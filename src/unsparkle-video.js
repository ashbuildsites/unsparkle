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

  /*
   * Quality setting -> bitrate.
   *
   * "source" matches the input's own video bitrate, so the output lands at
   * roughly the original file size. It cannot reproduce the original bytes -
   * changing pixels means re-encoding, and H.264 is lossy - but it stops the
   * encoder from being the thing that loses detail.
   */
  function bitrateFor(w, h, fps, quality, sourceBps) {
    if (quality === "source" || quality === 12) {
      if (sourceBps > 0) return Math.max(600000, Math.round(sourceBps));
    }
    var px = w * h * (fps || 30);
    var perPx = { 14: 0.28, 16: 0.20, 18: 0.14, 20: 0.10 }[quality] || 0.20;
    return Math.max(600000, Math.round(px * perPx));
  }

  /*
   * Decide where the watermark is before touching anything.
   *
   * Deciding from the first decoded frame alone was unreliable - frame 0 is
   * often a fade or an atypical shot, and on one 848x478 clip it picked a
   * 40px mark where the real one was 50px, leaving a ghost. Sampling several
   * frames and keeping the most convincing fit fixes that.
   */
  async function detectGeometry(d, W, H, wanted) {
    /*
     * Sample only the opening of the clip. The mark is static, so early frames
     * settle it - and spreading samples across the whole video forced a near
     * complete extra decode, which made a 10s clip take 10s instead of 1s.
     */
    var samples = d.vSamples, picks = [], i;
    var horizon = Math.min(samples.length, 36);
    var stride = Math.max(1, Math.floor(horizon / (wanted || 4)));
    for (i = 0; i < horizon && picks.length < (wanted || 4); i += stride) picks.push(i);
    if (!picks.length) picks = [0];

    var results = [], buf = null, seen = 0, want = {};
    for (i = 0; i < picks.length; i++) want[picks[i]] = true;

    // Frames arrive in decode order; only the sampled ones are worth the
    // (expensive) corner search - searching all of them made this crawl.
    var chain = Promise.resolve();
    var dec = new VideoDecoder({
      output: function (frame) {
        var idx = seen++;
        if (!want[idx]) { frame.close(); return; }
        chain = chain.then(async function () {
          try {
            if (!buf || buf.length < frame.allocationSize())
              buf = new Uint8Array(frame.allocationSize());
            var layout = await frame.copyTo(buf);
            var hit = Core.locateCorner(buf.subarray(layout[0].offset), W, H,
                                        layout[0].stride, Core.WHITE.y);
            if (hit) results.push(hit);
          } catch (e) { /* a frame we cannot read tells us nothing */ }
          finally { frame.close(); }
        });
      },
      error: function () {}
    });
    try {
      dec.configure({ codec: d.video.codec, codedWidth: W, codedHeight: H,
                      description: d.videoDesc, hardwareAcceleration: "no-preference" });
    } catch (e) { return null; }

    // Decode from the start up to the furthest sample we want.
    var last = picks[picks.length - 1];
    for (i = 0; i <= last && i < samples.length; i++) {
      var sm = samples[i];
      if (i === 0 && !sm.is_sync) break;
      dec.decode(new EncodedVideoChunk({
        type: sm.is_sync ? "key" : "delta",
        timestamp: 1e6 * sm.cts / sm.timescale,
        duration: 1e6 * sm.duration / sm.timescale,
        data: sm.data
      }));
      if (i % 24 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    try { await dec.flush(); } catch (e) {}
    try { await chain; } catch (e) {}        // the sampled searches finish here
    try { dec.close(); } catch (e) {}
    if (!results.length) return null;

    // Group by placement and keep the one that fits best across frames.
    var best = null;
    for (i = 0; i < results.length; i++) {
      var r = results[i];
      if (!best || r.evidence > best.evidence) best = r;
    }
    return best;
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
    var durationSec = d.video.duration / timescale;
    // The video track's own rate, so "source" quality can match it. Subtract a
    // nominal audio allowance so we size the video stream, not the container.
    var srcBps = durationSec > 0
      ? Math.max(0, (file.size * 8 / durationSec) - (d.audio ? 128000 : 0))
      : 0;
    var geom = null;         // located on the first frame, then reused
    var detection = null;    // what that search concluded

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

    /*
     * WebCodecs reports failures through this callback, asynchronously.
     * Throwing from here does NOT reach the caller - the exception is
     * swallowed and the run ends with zero output, which used to surface as a
     * useless "encoder produced no frames". Record it and re-throw later.
     */
    var codecError = null;
    function noteError(where) {
      return function (e) {
        if (!codecError) codecError = new Error(where + ": " + (e && e.message ? e.message : e));
      };
    }

    /*
     * Pick an encoder configuration by actually encoding a frame with it.
     *
     * isConfigSupported() is optimistic on Android: it happily approves
     * avc1.640028 at 1280x720 and then the hardware encoder emits nothing at
     * all, with no error. So every candidate gets a real one-frame smoke test
     * and only a config that produced a chunk is used. The order walks down
     * from best quality to the most conservative thing that tends to work on
     * phones: Baseline profile, realtime latency, software encoding.
     */
    var targetBitrate = bitrateFor(W, H, fps, opts.quality || 16, srcBps);

    async function smokeTest(cfg) {
      var got = 0, failed = false;
      var probe = new VideoEncoder({
        output: function () { got++; },
        error: function () { failed = true; }
      });
      try {
        probe.configure(cfg);
        var blank = new Uint8Array(W * H * 3 / 2);
        blank.fill(16);
        blank.fill(128, W * H);
        var f = new VideoFrame(blank, {
          format: "I420", codedWidth: W, codedHeight: H,
          timestamp: 0, duration: 1000,
          colorSpace: { primaries: "bt709", transfer: "bt709",
                        matrix: "bt709", fullRange: false }
        });
        probe.encode(f, { keyFrame: true });
        f.close();
        await probe.flush();
      } catch (e) {
        failed = true;
      }
      try { probe.close(); } catch (e) {}
      return !failed && got > 0;
    }

    var profiles = ["avc1.640028", "avc1.4d401f", "avc1.42001f"];
    var latencies = ["quality", "realtime"];
    var accels = ["no-preference", "prefer-software"];
    var encCfg = null, tried = [];
    for (var li = 0; li < latencies.length && !encCfg; li++) {
      for (var ai = 0; ai < accels.length && !encCfg; ai++) {
        for (var pi = 0; pi < profiles.length && !encCfg; pi++) {
          var cand = {
            codec: profiles[pi], width: W, height: H,
            bitrate: targetBitrate, framerate: Math.round(fps) || 30,
            avc: { format: "avc" },
            hardwareAcceleration: accels[ai],
            latencyMode: latencies[li]
          };
          tried.push(profiles[pi] + "/" + latencies[li] + "/" + accels[ai]);
          if (await smokeTest(cand)) encCfg = cand;
        }
      }
    }
    if (!encCfg) {
      throw new Error(
        "This browser could not encode H.264 at " + W + "x" + H + ". " +
        "Tried " + tried.length + " configurations, none produced output. " +
        "Mobile browsers are often the culprit \u2014 a desktop browser, or the " +
        "command line tool, will handle this file.");
    }

    var encoder = new VideoEncoder({
      output: function (chunk, meta) {
        muxer.addVideoChunk(chunk, meta || undefined);
        encoded++;
      },
      error: noteError("encoder")
    });
    encoder.configure(encCfg);

    var buf = null, fmt = null, layout = null;
    var processed = 0;

    report(10, "checking");
    var hit = await detectGeometry(d, W, H, 4);
    if (!hit || hit.evidence < Core.MIN_EVIDENCE) {
      detection = { found: false, evidence: hit ? hit.evidence : 0 };
      geom = false;                             // nothing convincing: leave it alone
    } else {
      geom = { x0: hit.x0 & ~1, y0: hit.y0 & ~1, n: hit.n, scale: 1 };
      detection = { found: true, evidence: hit.evidence, alpha: hit.alpha };
    }

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
        if (geom === false) {                   // pass the frame through clean
          var passthru = new VideoFrame(buf, {
            format: fmt, codedWidth: W, codedHeight: H, layout: layout,
            timestamp: frame.timestamp, duration: frame.duration,
            colorSpace: { primaries: "bt709", transfer: "bt709",
                          matrix: "bt709", fullRange: false }
          });
          encoder.encode(passthru, { keyFrame: processed % 60 === 0 });
          passthru.close();
          return;
        }
        if (firstAlpha === null)
          firstAlpha = Core.measure(yPlane, W, H, geom, yStride);
        Core.unblendFrame(buf, fmt, layout, W, H,
                          { geom: geom, repair: opts.repair !== false,
                            alpha: detection && detection.alpha });
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
      error: noteError("decoder")
    });
    var decCfg = {
      codec: d.video.codec, codedWidth: W, codedHeight: H,
      description: d.videoDesc, hardwareAcceleration: "no-preference"
    };
    try {
      var dsup = await VideoDecoder.isConfigSupported(decCfg);
      if (dsup && !dsup.supported)
        throw new Error("This browser cannot decode " + d.video.codec +
                        " at " + W + "x" + H + ".");
    } catch (e) {
      if (e && /cannot decode/.test(e.message)) throw e;
    }
    decoder.configure(decCfg);

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
    try {
      await decoder.flush();
      await chain;               // every frame has now reached the encoder
      await encoder.flush();
    } catch (e) {
      if (!codecError) codecError = e;
    }
    try { decoder.close(); } catch (e) {}
    try { encoder.close(); } catch (e) {}
    if (codecError) throw codecError;
    if (encoded === 0) {
      throw new Error(
        "The encoder passed its smoke test but produced no frames for this " +
        "video (" + W + "x" + H + ", " + encCfg.codec + "). Please report this " +
        "with the resolution \u2014 a desktop browser will handle the file " +
        "meanwhile.");
    }

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
        sourceBps: srcBps, bitrate: bitrateFor(W, H, fps, opts.quality || 16, srcBps),
        alphaBefore: firstAlpha, alphaAfter: lastAlpha,
        hasAudio: !!(d.audio && d.aSamples.length),
        found: !!(detection && detection.found),
        evidence: detection ? detection.evidence : 0,
        encoderConfig: encCfg.codec + " / " + encCfg.latencyMode + " / " + encCfg.hardwareAcceleration,
        geom: (geom && geom !== false) ? geom : Core.geometry(W, H)
      }
    };
  }

  global.UnsparkleVideo = { process: process, demux: demux, bitrateFor: bitrateFor };
})(typeof self !== "undefined" ? self : this);
