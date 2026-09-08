/*
 * unsparkle-core.js - the watermark maths, running in the visitor's browser.
 *
 * The Gemini/Veo sparkle is a constant alpha composite:
 *
 *     observed = (1 - a*m) * original + a*m * white
 *
 * Alpha compositing is affine, so this holds identically in YUV as in RGB.
 * Video is therefore corrected directly on the I420 planes WebCodecs hands us
 * - no RGB round trip, no colour-matrix guessing, and every pixel outside the
 * 76x76 patch stays bit-identical until the encoder sees it.
 *
 * Constants measured from 480 real frames; see the site's "how it works".
 */
(function (global) {
  "use strict";

  var REF_W = 720, REF_H = 1280, REF_X0 = 564, REF_Y0 = 1120, REF_N = 76;

  // Per-plane opacity. Chroma reads lower because 4:2:0 subsampling averages
  // the watermark edge with its surroundings.
  var ALPHA = { y: 0.2962, u: 0.2923, v: 0.2794 };
  var WHITE = { y: 235.0, u: 128.0, v: 128.0 };
  // Canvas gives full-range sRGB, where the same mark measures a touch lower.
  var ALPHA_RGB = 0.2975, WHITE_RGB = 255.0;
  /*
   * The mark scales with the SHORTER side of the frame, not with width and
   * not as a fixed badge. Measured:
   *
   *    720x1280   76px  inset 80/84    (0.106 of min side)
   *    1408x768   76px  inset 80/84    (0.099)
   *    848x478    50px  inset 52/56    (0.105)
   *
   * A fixed geometry was wrong: on 848x478 it corrected empty pixels and
   * punched a dark star into clean footage while leaving the real watermark
   * untouched. So the ratios below are only a starting point - the corner is
   * searched around them and the fit has to earn its place before anything is
   * modified.
   */
  var SIZE_RATIO = 0.104, RIGHT_RATIO = 0.108, BOTTOM_RATIO = 0.115;
  var CONFIGS = [
    { n: 76, right: 80, bottom: 84 },
    { n: 96, right: 64, bottom: 64 },
    { n: 48, right: 32, bottom: 32 }
  ];
  var INSET_RIGHT = CONFIGS[0].right, INSET_BOTTOM = CONFIGS[0].bottom;

  var MATTE_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANDQ8REBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgsKCwwNAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACQAb4toYDxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKTPj9SwoLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACZ77/ZQPDwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACA3X///rFQ8LAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5O/////1YNAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVof////+8DwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/D//////zcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ/7//////eiCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADy3y////////+E4TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACXS/f////////+9CgAKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8+P///////////3cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAh8/j///////////3dNgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCzf/////////////+/9EiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwfT////////9/v///fztsgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIh//9//////////7//////P+UCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhuf///////////////////399JEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhvPT/////////////////////////wjMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArye7+/////v7/////////////////+/LNIgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAtu6vn6//79/P39/v7+//////////////v/+u95EAoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEWm6+///Pf8/v3+/v/////////////////////y+8ooAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4IK5T19///+fr99/v8/Pz9/v7//////////////////v739pYlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEqfHt8/P+//r5+Pv7+/v7/f39/v//////////////////+/3z5Z5AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPZrX9vT+/f/////49vn5+/r7+/z9/f7////////////////////////49NKOOgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAz+vw8/j19fj/////+Pj4+vr7+/v8/P39//////////////////////3/////+vLHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANL27fb9+/v8///++/j39/r6+/v7/Pz9/f7//////////Pv9/////v/6/fj69e75zQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAN5TS9Pj5///5+vr6/Pr7+/v7/Pz8/f3+/v/////////+///9/////////9+QOQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEOc6/P39vj9//3///v7+/v8/Pz9/v///////////////v///+/xskgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJACiP9/j9/v37//77+/v7/Pz8/f7+//////////////////uZKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB7L8vT//////Pz8/f39/v7+/v7//////////fr27bJJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACoLp//X//vz8/Pz8/f39/f7+/v7+//////n/53AXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH87x/v77/Pv8/Pz9/f3+/v/+/v7////yzy0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAswv/t/P78+/z8/f39/v///v7//vf/rB4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACL4/f4//n//////fr///3/+v7sigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIrz8v/2///9//f3//////j8iAoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAtuv3/////v34+//8//juywAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACLU+P////////76////zzUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALfDx//3//f78///79ycAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABw9v/8///+/f///4IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEbX69//////9/8cSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAk89/v///////wcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJnv/v/9//OYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAq6//8+v/oNgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3//v//kQoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABH+//+7j8KAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOX6/NUKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAuY9faSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOe39PQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADL1AwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

  var _matte = null;
  function matte() {
    if (_matte) return _matte;
    var bin = atob(MATTE_B64), a = new Float32Array(REF_N * REF_N);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i) / 255;
    _matte = a;
    return a;
  }

  /*
   * Where the sparkle sits, for any resolution.
   *
   * Originally this scaled the patch by width, on the assumption the overlay
   * grew with the frame. Measuring a 1408x768 still against 720x1280 video
   * disproved that: both put a 76x76 mark exactly 80px from the right edge
   * and 84px from the bottom. It is a fixed-size badge, so scaling it would
   * have missed the mark on every resolution except the one it was fitted to.
   */
  function placeConfig(cfg, w, h) {
    var n = cfg.n;
    if (w < n + cfg.right || h < n + cfg.bottom) {
      n = Math.max(8, Math.min(n, Math.min(w, h) - 2));
    }
    var x0 = w - cfg.right - n, y0 = h - cfg.bottom - n;
    if (x0 < 0 || y0 < 0) return null;
    return { x0: (Math.min(x0, w - n)) & ~1, y0: (Math.min(y0, h - n)) & ~1,
             n: n, scale: 1 };
  }

  /* Every plausible placement for this frame size, best-known first. */
  function geometryCandidates(w, h) {
    var out = [];
    var mn = Math.min(w, h);
    var scaled = { n: Math.round(mn * SIZE_RATIO) & ~1,
                   right: Math.round(mn * RIGHT_RATIO),
                   bottom: Math.round(mn * BOTTOM_RATIO) };
    var g0 = placeConfig(scaled, w, h);
    if (g0) out.push(g0);
    for (var i = 0; i < CONFIGS.length; i++) {
      var g = placeConfig(CONFIGS[i], w, h);
      if (g && !out.some(function (o) {
            return o.n === g.n && o.x0 === g.x0 && o.y0 === g.y0; })) out.push(g);
    }
    if (!out.length) {
      var n = Math.max(8, Math.min(REF_N, Math.min(w, h) - 2));
      out.push({ x0: Math.max(0, w - n) & ~1, y0: Math.max(0, h - n) & ~1,
                 n: n, scale: 1 });
    }
    return out;
  }

  /* The single best-known placement, for callers that just need one. */
  function geometry(w, h) { return geometryCandidates(w, h)[0]; }

  /* Bilinear resample of the matte. Nearest-neighbour biased the fitted
     opacity enough to matter when searching for the mark in an image. */
  function matteAt(n) {
    var src = matte(), out = new Float32Array(n * n);
    if (n === REF_N) { out.set(src); return out; }
    var sc = REF_N / n;
    for (var y = 0; y < n; y++) {
      var fy = Math.min(REF_N - 1.001, (y + 0.5) * sc - 0.5); if (fy < 0) fy = 0;
      var y0 = fy | 0, wy = fy - y0, y1 = Math.min(REF_N - 1, y0 + 1);
      for (var x = 0; x < n; x++) {
        var fx = Math.min(REF_N - 1.001, (x + 0.5) * sc - 0.5); if (fx < 0) fx = 0;
        var x0 = fx | 0, wx = fx - x0, x1 = Math.min(REF_N - 1, x0 + 1);
        out[y * n + x] =
          src[y0 * REF_N + x0] * (1 - wx) * (1 - wy) + src[y0 * REF_N + x1] * wx * (1 - wy) +
          src[y1 * REF_N + x0] * (1 - wx) * wy      + src[y1 * REF_N + x1] * wx * wy;
      }
    }
    return out;
  }

  /* Chroma planes are half resolution: box-average the coverage. */
  function matteChroma(m, n) {
    var h = n >> 1, out = new Float32Array(h * h);
    for (var y = 0; y < h; y++)
      for (var x = 0; x < h; x++)
        out[y * h + x] = (m[(2*y) * n + 2*x] + m[(2*y) * n + 2*x + 1] +
                          m[(2*y+1) * n + 2*x] + m[(2*y+1) * n + 2*x + 1]) / 4;
    return out;
  }

  function unblendPlane(plane, stride, x0, y0, n, cov, alpha, white) {
    for (var y = 0; y < n; y++) {
      var row = (y0 + y) * stride + x0, mrow = y * n;
      for (var x = 0; x < n; x++) {
        var a = alpha * cov[mrow + x];
        if (a <= 0) continue;
        var v = (plane[row + x] - a * white) / (1 - a);
        plane[row + x] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  /*
   * H.264 leaves ringing along the watermark's hard edge. That is a
   * compression artifact, not part of the blend, so it cannot be un-blended.
   * A few Jacobi sweeps over the thin rim diffuse it away using the corrected
   * pixels on both sides - the browser-side stand-in for Telea inpainting.
   */
  function repairRim(plane, stride, x0, y0, n, cov, iters) {
    var band = new Uint8Array(n * n), i, x, y;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      var c = cov[y * n + x];
      if (c > 0.02 && c < 0.98) band[y * n + x] = 1;
    }
    // widen by one pixel, where the ringing actually sits
    var wide = new Uint8Array(band);
    for (y = 1; y < n - 1; y++) for (x = 1; x < n - 1; x++)
      if (band[y*n+x]) { wide[(y-1)*n+x]=1; wide[(y+1)*n+x]=1; wide[y*n+x-1]=1; wide[y*n+x+1]=1; }
    for (i = 0; i < iters; i++) {
      for (y = 1; y < n - 1; y++) for (x = 1; x < n - 1; x++) {
        if (!wide[y * n + x]) continue;
        var p = (y0 + y) * stride + x0 + x;
        plane[p] = (plane[p - 1] + plane[p + 1] + plane[p - stride] + plane[p + stride]) >> 2;
      }
    }
  }

  /* NV12 keeps U and V interleaved in one plane at half resolution. */
  function unblendUVInterleaved(plane, stride, x0, y0, n, cov, k) {
    k = k || 1;
    for (var y = 0; y < n; y++) {
      var row = (y0 + y) * stride + x0 * 2, mrow = y * n;
      for (var x = 0; x < n; x++) {
        var c = cov[mrow + x];
        if (c <= 0) continue;
        var au = ALPHA.u * k * c, av = ALPHA.v * k * c;
        var iu = row + x * 2, iv = iu + 1;
        var u = (plane[iu] - au * WHITE.u) / (1 - au);
        var v = (plane[iv] - av * WHITE.v) / (1 - av);
        plane[iu] = u < 0 ? 0 : u > 255 ? 255 : u;
        plane[iv] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  /*
   * Correct a decoded frame in place, using the plane layout WebCodecs gives
   * us. copyTo() refuses to convert pixel formats, so we take whatever the
   * decoder produced - I420 on most machines, NV12 on some hardware paths.
   */
  function unblendFrame(buf, fmt, layout, w, h, opts) {
    var g = (opts && opts.geom) || geometry(w, h);
    var n = g.n, m = matteAt(n), mc = matteChroma(m, n);
    /*
     * Opacity is fitted per file, then scaled onto the per-plane constants.
     *
     * A single fixed value cannot work: measured marks run from ~0.30 on
     * 720x1280 Gemini output to ~0.59 on a 1080x1920 Veo clip. An earlier
     * attempt used a single frame's estimate and was reverted for being
     * noisy - this uses the median across sampled frames instead, which is
     * stable on the clips the constant already handled and correct on the
     * ones it did not.
     */
    var k = 1;
    if (opts && opts.alpha > 0) {
      k = opts.alpha / ALPHA.y;
      if (k < 0.6) k = 0.6; else if (k > 2.4) k = 2.4;
    }
    var cx = g.x0 >> 1, cy = g.y0 >> 1, cn = n >> 1;
    var yStride = layout[0].stride, Y = buf.subarray(layout[0].offset);
    unblendPlane(Y, yStride, g.x0, g.y0, n, m, ALPHA.y * k, WHITE.y);
    if (!opts || opts.repair !== false) repairRim(Y, yStride, g.x0, g.y0, n, m, 12);

    if (fmt === "NV12" || fmt === "NV21") {
      var uv = buf.subarray(layout[1].offset);
      unblendUVInterleaved(uv, layout[1].stride, cx, cy, cn, mc, k);
    } else if (layout.length >= 3) {
      unblendPlane(buf.subarray(layout[1].offset), layout[1].stride, cx, cy, cn, mc, ALPHA.u * k, WHITE.u);
      unblendPlane(buf.subarray(layout[2].offset), layout[2].stride, cx, cy, cn, mc, ALPHA.v * k, WHITE.v);
    }
    return g;
  }

  /* ---- video: correct an I420 buffer in place ---- */
  function unblendI420(buf, w, h, opts) {
    var g = (opts && opts.geom) || geometry(w, h);
    var n = g.n, m = matteAt(n), mc = matteChroma(m, n);
    var ySize = w * h, cW = w >> 1, cH = h >> 1, cSize = cW * cH;
    var Y = buf.subarray(0, ySize);
    var U = buf.subarray(ySize, ySize + cSize);
    var V = buf.subarray(ySize + cSize, ySize + 2 * cSize);
    unblendPlane(Y, w, g.x0, g.y0, n, m, ALPHA.y, WHITE.y);
    if (!opts || opts.repair !== false) repairRim(Y, w, g.x0, g.y0, n, m, 12);
    unblendPlane(U, cW, g.x0 >> 1, g.y0 >> 1, n >> 1, mc, ALPHA.u, WHITE.u);
    unblendPlane(V, cW, g.x0 >> 1, g.y0 >> 1, n >> 1, mc, ALPHA.v, WHITE.v);
    return g;
  }

  /*
   * JPEG leaves ringing along the mark's hard edge, exactly as H.264 does in
   * video. It is a compression artifact rather than part of the blend, so it
   * survives un-blending and shows as a faint outline. Diffuse it away using
   * the corrected pixels either side.
   */
  function repairRimRGBA(data, w, x0, y0, n, cov, iters) {
    var band = new Uint8Array(n * n), x, y, i;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      var c = cov[y * n + x];
      if (c > 0.02 && c < 0.98) band[y * n + x] = 1;
    }
    var wide = new Uint8Array(band);
    for (y = 1; y < n - 1; y++) for (x = 1; x < n - 1; x++)
      if (band[y*n+x]) { wide[(y-1)*n+x]=1; wide[(y+1)*n+x]=1; wide[y*n+x-1]=1; wide[y*n+x+1]=1; }
    for (i = 0; i < iters; i++) {
      for (y = 1; y < n - 1; y++) for (x = 1; x < n - 1; x++) {
        if (!wide[y * n + x]) continue;
        var p = ((y0 + y) * w + (x0 + x)) * 4;
        var up = p - w * 4, dn = p + w * 4;
        for (var k = 0; k < 3; k++)
          data[p + k] = (data[p - 4 + k] + data[p + 4 + k] + data[up + k] + data[dn + k]) >> 2;
      }
    }
  }

  /* ---- images: correct RGBA ImageData in place ---- */
  function unblendRGBA(data, w, h, opts) {
    var g = (opts && opts.geom) || geometry(w, h);
    var n = g.n, m = matteAt(n), a, i, x, y, c;
    var safe = g.x0 > 0 && g.y0 > 0 && g.x0 + n < w && g.y0 + n < h;
    var aBase = (opts && opts.alpha > 0)
      ? Math.max(ALPHA_RGB * 0.6, Math.min(ALPHA_RGB * 2.4, opts.alpha))
      : ALPHA_RGB;
    for (y = 0; y < n; y++) {
      for (x = 0; x < n; x++) {
        c = m[y * n + x];
        if (c <= 0) continue;
        a = aBase * c;
        i = ((g.y0 + y) * w + (g.x0 + x)) * 4;
        for (var k = 0; k < 3; k++) {
          var v = (data[i + k] - a * WHITE_RGB) / (1 - a);
          data[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
    if (safe && (!opts || opts.repair !== false))
      repairRimRGBA(data, w, g.x0, g.y0, n, m, 10);
    return g;
  }

  /*
   * Measure how strongly the sparkle is present, by fitting a plane to the
   * ring around it and solving the blend equation. ~0.30 means watermarked,
   * ~0.00 means clean. Same estimator the constants were measured with, so
   * the page can prove the removal rather than assert it.
   */
  function measure(Y, w, h, geom, stride) {
    var g = geom || geometry(w, h), n = g.n, m = matteAt(n);
    var W = stride || w;
    var sx = 0, sy = 0, s1 = 0, sxx = 0, sxy = 0, syy = 0, sz = 0, sxz = 0, syz = 0;
    var x, y, val;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      if (m[y * n + x] > 0.01) continue;                 // ring only
      val = Y[(g.y0 + y) * W + g.x0 + x];
      s1++; sx += x; sy += y; sxx += x*x; sxy += x*y; syy += y*y;
      sz += val; sxz += x*val; syz += y*val;
    }
    if (s1 < 16) return 0;
    // least-squares plane z = c0 + c1*x + c2*y  (3x3 solve)
    var A = [[s1, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], B = [sz, sxz, syz], i, j, k;
    for (i = 0; i < 3; i++) {
      var piv = A[i][i]; if (Math.abs(piv) < 1e-9) return 0;
      for (j = i; j < 3; j++) A[i][j] /= piv; B[i] /= piv;
      for (k = 0; k < 3; k++) if (k !== i) {
        var f = A[k][i];
        for (j = i; j < 3; j++) A[k][j] -= f * A[i][j];
        B[k] -= f * B[i];
      }
    }
    var num = 0, den = 0, C = WHITE.y;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      var cov = m[y * n + x]; if (cov <= 0) continue;
      var base = B[0] + B[1] * x + B[2] * y;
      var obs = Y[(g.y0 + y) * W + g.x0 + x];
      num += cov * (C - base) * (obs - base);
      den += cov * cov * (C - base) * (C - base);
    }
    return den > 1e-6 ? num / den : 0;
  }

  /*
   * Fit the blend at one placement and report how much better "a sparkle is
   * here" explains the pixels than "nothing is here". Shared by video and
   * images so both gate on the same evidence.
   */
  function fitAt(Y, w, h, stride, x0, y0, n, m, white) {
    var C = white === undefined ? WHITE.y : white;
    var s1 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sz = 0, sxz = 0, syz = 0;
    var x, y, val;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      if (m[y * n + x] > 0.01) continue;
      val = Y[(y0 + y) * stride + x0 + x];
      s1++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
      sz += val; sxz += x * val; syz += y * val;
    }
    if (s1 < 20) return { a: 0, evidence: 0 };
    var A = [[s1, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], B = [sz, sxz, syz], i, j, k;
    for (i = 0; i < 3; i++) {
      var piv = A[i][i]; if (Math.abs(piv) < 1e-9) return { a: 0, evidence: 0 };
      for (j = i; j < 3; j++) A[i][j] /= piv; B[i] /= piv;
      for (k = 0; k < 3; k++) if (k !== i) {
        var f = A[k][i];
        for (j = i; j < 3; j++) A[k][j] -= f * A[i][j];
        B[k] -= f * B[i];
      }
    }
    var num = 0, den = 0;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      var cov = m[y * n + x]; if (cov <= 0) continue;
      var base = B[0] + B[1] * x + B[2] * y;
      num += cov * (C - base) * (Y[(y0 + y) * stride + x0 + x] - base);
      den += cov * cov * (C - base) * (C - base);
    }
    if (den < 1e-6) return { a: 0, evidence: 0 };
    var a = num / den, r0 = 0, r1 = 0, cnt = 0;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      var c2 = m[y * n + x]; if (c2 <= 0) continue;
      var b2 = B[0] + B[1] * x + B[2] * y;
      var o2 = Y[(y0 + y) * stride + x0 + x];
      var d0 = o2 - b2, d1 = o2 - (b2 + a * c2 * (C - b2));
      r0 += d0 * d0; r1 += d1 * d1; cnt++;
    }
    r0 = Math.sqrt(r0 / cnt); r1 = Math.sqrt(r1 / cnt);
    // The mean background under the mark. The opacity estimate divides by
    // (C - background), so a bright background makes it unreliable - callers
    // use this to weight frames rather than trusting them equally.
    var bg = s1 ? sz / s1 : 0;
    return { a: a, evidence: r1 > 0.5 ? r0 / r1 : 0, resid: r1,
             bg: bg, contrast: Math.abs(C - bg) };
  }

  /*
   * Search the bottom-right corner for the mark. Bounded to that corner and to
   * plausible sizes - never a whole-frame hunt, which produced convincing
   * false positives when it was tried.
   */
  /*
   * Find the sparkle at any resolution.
   *
   * Nothing here is pinned to a resolution or a constant. The corner is swept
   * across a wide range of sizes; at each placement the opacity that best
   * explains the pixels is solved for analytically, and the winner is the fit
   * that beats "nothing is here" by the widest margin.
   *
   * Both halves have to be fitted, because both genuinely vary: a 1080x1920
   * Veo clip carries a mark at opacity ~0.59 where a 720x1280 Gemini clip is
   * ~0.30. Assuming either one produced a visible leftover on the other.
   */
  function locateCorner(Y, w, h, stride, white) {
    stride = stride || w;
    var mn = Math.min(w, h), best = null, si, dr, db;

    // Sizes from 4% to 16% of the shorter side - wide enough that no known
    // Gemini or Veo output falls outside it.
    var lo = Math.max(16, Math.round(mn * 0.04));
    var hi = Math.max(lo + 2, Math.round(mn * 0.16));
    var step = Math.max(2, Math.round((hi - lo) / 14)) & ~1 || 2;
    var sizes = [];
    for (si = lo; si <= hi; si += step) {
      var n0 = si & ~1;
      if (sizes.indexOf(n0) < 0) sizes.push(n0);
    }
    // 76 and 50 are the sizes actually observed in the wild; make sure the
    // ladder cannot step over them.
    [76, 50].forEach(function (n) {
      if (n >= lo && n <= hi && sizes.indexOf(n) < 0) sizes.push(n);
    });
    sizes.sort(function (a, b) { return a - b; });

    // Positions: sweep the corner rather than trusting a fixed inset.
    var maxInset = Math.round(mn * 0.22), posStep = Math.max(3, Math.round(mn * 0.012));
    for (si = 0; si < sizes.length; si++) {
      var nn = sizes[si]; if (nn >= mn * 0.5) continue;
      var m = matteAt(nn);
      for (dr = 0; dr <= maxInset; dr += posStep) {
        var x0 = w - dr - nn; if (x0 < 0) continue;
        for (db = 0; db <= maxInset; db += posStep) {
          var y0 = h - db - nn; if (y0 < 0) continue;
          var r = fitAt(Y, w, h, stride, x0, y0, nn, m, white);
          if (r.a < 0.10 || r.a > 0.80) continue;
          if (!best || r.evidence > best.evidence)
            best = { x0: x0, y0: y0, n: nn, alpha: r.a, evidence: r.evidence,
                     resid: r.resid, bg: r.bg, contrast: r.contrast };
        }
      }
    }
    if (!best) return null;

    /*
     * Prefer the largest size that fits almost as well as the winner.
     *
     * Evidence quietly favours an UNDERSIZED matte: a small patch sitting
     * inside the mark's solid core fits beautifully and scores high, while
     * leaving the rim uncorrected - which showed up as a bright arc around an
     * otherwise-removed sparkle. Covering the whole mark matters more than
     * the last few percent of fit.
     */
    var tol = best.evidence * 0.9, grow = best;
    var cx = best.x0 + best.n / 2, cy = best.y0 + best.n / 2;
    for (si = 0; si < sizes.length; si++) {
      var ng = sizes[si];
      if (ng <= grow.n || ng > best.n * 1.6) continue;
      var mg = matteAt(ng);
      // Concentric only. Letting this roam turned a weak fit somewhere else
      // entirely into the "winner" - it must answer "is the same mark bigger
      // than I thought", not "is there a bigger mark anywhere".
      var lim = Math.max(3, Math.round(ng * 0.18));
      for (var gx = Math.round(cx - ng / 2) - lim; gx <= Math.round(cx - ng / 2) + lim; gx += 2) {
        if (gx < 0 || gx + ng > w) continue;
        for (var gy = Math.round(cy - ng / 2) - lim; gy <= Math.round(cy - ng / 2) + lim; gy += 2) {
          if (gy < 0 || gy + ng > h) continue;
          var rg = fitAt(Y, w, h, stride, gx, gy, ng, mg, white);
          if (rg.a < 0.10 || rg.a > 0.80) continue;
          if (rg.evidence >= tol && ng > grow.n)
            grow = { x0: gx, y0: gy, n: ng, alpha: rg.a, evidence: rg.evidence,
                     resid: rg.resid, bg: rg.bg, contrast: rg.contrast };
        }
      }
    }
    best = grow;

    // Tighten size and position one pixel at a time around the winner.
    var refined = best, pass, span, sstep;
    for (pass = 0; pass < 2; pass++) {
      span = pass === 0 ? posStep : 2;
      sstep = pass === 0 ? Math.max(2, step >> 1) : 1;
      var c = refined;
      for (var dn = -step; dn <= step; dn += sstep) {
        var n2 = c.n + dn; if (n2 < 16 || n2 >= mn * 0.5) continue;
        var m2 = matteAt(n2);
        for (var dx = -span; dx <= span; dx++) for (var dy = -span; dy <= span; dy++) {
          var X = c.x0 + dx, Yy = c.y0 + dy;
          if (X < 0 || Yy < 0 || X + n2 > w || Yy + n2 > h) continue;
          var rr = fitAt(Y, w, h, stride, X, Yy, n2, m2, white);
          if (rr.a < 0.10 || rr.a > 0.80) continue;
          if (rr.evidence > refined.evidence)
            refined = { x0: X, y0: Yy, n: n2, alpha: rr.a, evidence: rr.evidence,
                        resid: rr.resid, bg: rr.bg, contrast: rr.contrast };
        }
      }
    }
    return refined;
  }

  /*
   * Choose the opacity that leaves the least behind.
   *
   * The analytic solve inside fitAt returns the least-squares opacity for a
   * given placement, but it is biased whenever the matte size is even
   * slightly off - on one clip it read 0.356 where 0.30 was correct, and
   * over-corrected into a dark smudge. Sweeping the actual post-correction
   * residual is unbiased by construction, because it scores the thing we
   * actually care about.
   */
  function refineAlpha(Y, w, h, stride, geom, white, seed) {
    var C = white === undefined ? WHITE.y : white;
    var n = geom.n, m = matteAt(n), x0 = geom.x0, y0 = geom.y0;
    var s1 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sz = 0, sxz = 0, syz = 0;
    var x, y, val;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      if (m[y * n + x] > 0.01) continue;
      val = Y[(y0 + y) * stride + x0 + x];
      s1++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
      sz += val; sxz += x * val; syz += y * val;
    }
    if (s1 < 20) return seed || ALPHA.y;
    var A = [[s1, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], B = [sz, sxz, syz], i, j, k;
    for (i = 0; i < 3; i++) {
      var piv = A[i][i]; if (Math.abs(piv) < 1e-9) return seed || ALPHA.y;
      for (j = i; j < 3; j++) A[i][j] /= piv; B[i] /= piv;
      for (k = 0; k < 3; k++) if (k !== i) {
        var f = A[k][i];
        for (j = i; j < 3; j++) A[k][j] -= f * A[i][j];
        B[k] -= f * B[i];
      }
    }
    var bestA = seed || ALPHA.y, bestR = Infinity;
    for (var a = 0.14; a <= 0.78; a += 0.01) {
      var acc = 0, cnt = 0;
      for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
        var cov = m[y * n + x]; if (cov <= 0.02) continue;
        var aa = a * cov; if (aa >= 0.97) continue;
        var base = B[0] + B[1] * x + B[2] * y;
        var rec = (Y[(y0 + y) * stride + x0 + x] - aa * C) / (1 - aa);
        var d = rec - base;
        acc += d * d; cnt++;
      }
      if (!cnt) continue;
      var r = acc / cnt;
      if (r < bestR) { bestR = r; bestA = a; }
    }
    return bestA;
  }

  global.UnsparkleCore = {
    fitAt: fitAt, locateCorner: locateCorner, refineAlpha: refineAlpha,
    SIZE_RATIO: SIZE_RATIO, /*
     * Below this, the file is left alone.
     *
     * Set by the two cases that matter: an already-cleaned video scores 3.3
     * (the rim ringing we leave behind reads as a faint mark), and the
     * weakest genuine watermark seen scores 4.9. Running the tool twice must
     * be safe, so the line sits between them.
     */
    MIN_EVIDENCE: 4.0,
    ALPHA: ALPHA, WHITE: WHITE, ALPHA_RGB: ALPHA_RGB,
    REF: {w: REF_W, h: REF_H, n: REF_N, insetRight: INSET_RIGHT, insetBottom: INSET_BOTTOM},
    geometry: geometry, geometryCandidates: geometryCandidates, CONFIGS: CONFIGS,
    matteAt: matteAt, unblendI420: unblendI420,
    unblendFrame: unblendFrame,
    unblendRGBA: unblendRGBA, measure: measure, repairRimRGBA: repairRimRGBA
  };
})(typeof self !== "undefined" ? self : this);
