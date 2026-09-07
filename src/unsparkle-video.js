/*
 * unsparkle-video.js - in-browser video watermark removal.
 *
 * mp4box.js demuxes, WebCodecs decodes and re-encodes, mp4-muxer writes the
 * result. The file never leaves the machine.
 *
 * WebCodecs rather than ffmpeg.wasm on purpose: it is hardware accelerated,
 * needs no 25 MB payload, and - critically - needs no SharedArrayBuffer, so
 * the page does not have to be cross-origin isolated.
 *
 * Frames are corrected on their I420 planes, so nothing outside the watermark
 * patch is touched before the encoder sees it. Audio is copied through as
 * encoded samples and never re-encoded.
 */
(function (global) {
  "use strict";
  var Core = global.UnsparkleCore;

  // mp4box.all exposes DataStream as its own global, not under MP4Box.
  var DS = (typeof DataStream !== "undefined") ? DataStream
         : (global.MP4Box && global.MP4Box.DataStream);

  function descriptionFor(mp4, trackId) {
    var trak = mp4.getTrackById(trackId);
    var entries = trak.mdia.minf.stbl.stsd.entries;
    for (var i = 0; i < entries.length; i++) {
      var box = entries[i].avcC || entries[i].hvcC || entries[i].av1C || entries[i].vpcC;
      if (box) {
        var ds = new DS(undefined, 0, DS.BIG_ENDIAN);
        box.write(ds);
        return new Uint8Array(ds.buffer, 8);   // strip the 8-byte box header
      }
    }
    return null;
  }

  function audioSpecificConfig(mp4, trackId) {
    try {
      var e = mp4.getTrackById(trackId).mdia.minf.stbl.stsd.entries[0];
      var d = e.esds.esd.descs[0].descs[0];
      if (d && d.data) return new Uint8Array(d.data);
    } catch (err) {}
    return null;
  }

  function demux(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var mp4 = MP4Box.createFile(), out = null;
      mp4.onError = function (e) { reject(new Error("Could not read this file: " + e)); };
      mp4.onReady = function (info) { try {
        var v = info.videoTracks[0];
        if (!v) return reject(new Error("No video track in this file."));
        var a = info.audioTracks[0];
        out = {
          info: info, video: v, audio: a,
          videoDesc: descriptionFor(mp4, v.id),
          audioDesc: a ? audioSpecificConfig(mp4, a.id) : null,
          vSamples: [], aSamples: []
        };
        mp4.setExtractionOptions(v.id, "v", { nbSamples: 1e9 });
        if (a) mp4.setExtractionOptions(a.id, "a", { nbSamples: 1e9 });
        mp4.start();
      } catch (err) { reject(err); } };
      mp4.onSamples = function (id, user, samples) {
        var into = user === "v" ? out.vSamples : out.aSamples;
        for (var i = 0; i < samples.length; i++) into.push(samples[i]);
        if (onProgress) onProgress(out.vSamples.length, out.video.nb_samples);
      };
      var reader = new FileReader();
      reader.onload = function () {
        var buf = reader.result;
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
        mp4.flush();
        if (!out) return reject(new Error("Could not parse this video."));
        resolve(out);
      };
      reader.onerror = function () { reject(new Error("Could not read the file.")); };
      reader.readAsArrayBuffer(file);
    });
  }

  /* Quality slider -> bitrate. Matches the CRF ladder the CLI tool exposes. */
  function bitrateFor(w, h, fps, quality) {
    var px = w * h * (fps || 30);
    var perPx = { 14: 0.28, 16: 0.20, 18: 0.14, 20: 0.10 }[quality] || 0.20;
    return Math.max(600000, Math.round(px * perPx));
  }

  async function process(file, opts) {
    opts = opts || {};
    var report = opts.onProgress || function () {};
    if (typeof VideoEncoder === "undefined")
      throw new Error("This browser has no WebCodecs support.");

    report(0, "reading");
    var d = await demux(file, function (n, total) {
      report(Math.min(12, 12 * n / Math.max(total, 1)), "reading");
    });

    var W = d.video.video.width, H = d.video.video.height;
    var timescale = d.video.timescale;
    var fps = d.video.nb_samples / (d.video.duration / timescale);
    var geom = null;   // chosen from the first frame, then reused

    var target = new Mp4Muxer.ArrayBufferTarget();
    var muxCfg = {
      target: target,
      video: { codec: "avc", width: W, height: H },
      fastStart: "in-memory"
    };
    if (d.audio) {
      muxCfg.audio = {
        codec: "aac",
        numberOfChannels: d.audio.audio.channel_count,
        sampleRate: d.audio.audio.sample_rate
      };
    }
    var muxer = new Mp4Muxer.Muxer(muxCfg);

    var encoded = 0, total = d.vSamples.length, firstAlpha = null, lastAlpha = null;
    var encoder = new VideoEncoder({
      output: function (chunk, meta) {
        muxer.addVideoChunk(chunk, meta || undefined);
        encoded++;
      },
      error: function (e) { throw e; }
    });
    encoder.configure({
      codec: "avc1.640028",
      width: W, height: H,
      bitrate: bitrateFor(W, H, fps, opts.quality || 16),
      framerate: Math.round(fps) || 30,
      avc: { format: "avc" },
      hardwareAcceleration: "no-preference",
      latencyMode: "quality"
    });

    var buf = null, fmt = null, layout = null;
    var processed = 0;

    /*
     * VideoDecoder invokes output callbacks in order but does not await them,
     * and decoder.flush() resolves as soon as it has *called* them. An async
     * callback therefore lets flush() win the race, so the encoder sees no
     * frames at all. Chaining serialises the work and gives us something to
     * await before flushing - and it keeps the shared plane buffer safe.
     */
    var chain = Promise.resolve();

    async function handleFrame(frame) {
      try {
        // copyTo() cannot convert formats, so take the decoder's own layout.
        if (!buf || buf.length < frame.allocationSize())
          buf = new Uint8Array(frame.allocationSize());
        layout = await frame.copyTo(buf);
        fmt = frame.format;
        var yPlane = buf.subarray(layout[0].offset), yStride = layout[0].stride;
        if (geom === null) {
          // Score the known watermark placements against a real frame and
          // lock in the winner, rather than assuming one size fits every
          // resolution Gemini emits.
          var cands = Core.geometryCandidates(W, H), bestA = -1;
          for (var gi = 0; gi < cands.length; gi++) {
            var av = Math.abs(Core.measure(yPlane, W, H, cands[gi], yStride));
            if (av > bestA) { bestA = av; geom = cands[gi]; }
          }
        }
        if (firstAlpha === null)
          firstAlpha = Core.measure(yPlane, W, H, geom, yStride);
        Core.unblendFrame(buf, fmt, layout, W, H,
                          { geom: geom, repair: opts.repair !== false });
        if (processed === 0 || processed === (total >> 1))
          lastAlpha = Core.measure(yPlane, W, H, geom, yStride);
        // A frame built from raw planes carries no colour metadata, so the
        // encoder would report colorSpace:null and the muxer would choke.
        // State it explicitly - and limited range is what we measured against.
        var out = new VideoFrame(buf, {
          format: fmt, codedWidth: W, codedHeight: H, layout: layout,
          timestamp: frame.timestamp, duration: frame.duration,
          colorSpace: { primaries: "bt709", transfer: "bt709",
                        matrix: "bt709", fullRange: false }
        });
        encoder.encode(out, { keyFrame: processed % 60 === 0 });
        out.close();
      } finally {
        frame.close();
        processed++;
        report(12 + 78 * processed / total, "cleaning");
      }
    }

    var decoder = new VideoDecoder({
      output: function (frame) { chain = chain.then(function () { return handleFrame(frame); }); },
      error: function (e) { throw e; }
    });
    decoder.configure({
      codec: d.video.codec, codedWidth: W, codedHeight: H,
      description: d.videoDesc, hardwareAcceleration: "no-preference"
    });

    for (var i = 0; i < d.vSamples.length; i++) {
      var s = d.vSamples[i];
      decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: 1e6 * s.cts / s.timescale,
        duration: 1e6 * s.duration / s.timescale,
        data: s.data
      }));
      if (i % 24 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    await decoder.flush();
    await chain;                 // every frame has now reached the encoder
    await encoder.flush();
    decoder.close(); encoder.close();
    if (encoded === 0) throw new Error("The encoder produced no frames.");

    /* Audio: copied verbatim, never re-encoded. */
    if (d.audio && d.aSamples.length) {
      report(92, "muxing");
      var meta = d.audioDesc
        ? { decoderConfig: {
              codec: "mp4a.40.2",
              numberOfChannels: d.audio.audio.channel_count,
              sampleRate: d.audio.audio.sample_rate,
              description: d.audioDesc } }
        : undefined;
      for (var j = 0; j < d.aSamples.length; j++) {
        var a = d.aSamples[j];
        muxer.addAudioChunkRaw(
          a.data, a.is_sync ? "key" : "delta",
          1e6 * a.cts / a.timescale, 1e6 * a.duration / a.timescale,
          j === 0 ? meta : undefined);
      }
    }

    report(97, "finishing");
    muxer.finalize();
    var blob = new Blob([target.buffer], { type: "video/mp4" });
    report(100, "done");

    return {
      blob: blob,
      stats: {
        width: W, height: H, frames: processed, encodedChunks: encoded,
        fps: fps, inSize: file.size, outSize: blob.size,
        alphaBefore: firstAlpha, alphaAfter: lastAlpha,
        hasAudio: !!(d.audio && d.aSamples.length),
        geom: geom || Core.geometry(W, H)
      }
    };
  }

  global.UnsparkleVideo = { process: process, demux: demux, bitrateFor: bitrateFor };
})(typeof self !== "undefined" ? self : this);
