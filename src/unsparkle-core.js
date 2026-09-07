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
     * The opacity constant stays fixed at the measured 0.2962. Substituting a
     * per-file estimate was tried and reverted: a residual sweep showed 0.2962
     * beats every higher value at every candidate size, and the single-frame
     * estimate is noisier than the constant fitted over 480 frames. Where a
     * ghost remains it is the mark's SIZE that is slightly off, or the source
     * is simply too compressed to recover cleanly.
     */
    var k = 1;
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
    var aBase = ALPHA_RGB;
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
    return { a: a, evidence: r1 > 0.5 ? r0 / r1 : 0, resid: r1 };
  }

  /*
   * Search the bottom-right corner for the mark. Bounded to that corner and to
   * plausible sizes - never a whole-frame hunt, which produced convincing
   * false positives when it was tried.
   */
  function locateCorner(Y, w, h, stride, white) {
    stride = stride || w;
    var mn = Math.min(w, h), best = null, si, dr, db;
    var base = Math.round(mn * SIZE_RATIO);

    // Coarse: a few plausible sizes, positions on a wide step.
    var sizes = [];
    for (si = -8; si <= 8; si += 4) {
      var n = (base + si) & ~1;
      if (n >= 16 && n < mn / 2 && sizes.indexOf(n) < 0) sizes.push(n);
    }
    [76, 96, 48].forEach(function (n) {
      if (n < mn / 2 && sizes.indexOf(n) < 0) sizes.push(n);
    });

    var rMid = Math.round(mn * RIGHT_RATIO), bMid = Math.round(mn * BOTTOM_RATIO);
    var span = Math.max(12, Math.round(mn * 0.05));
    for (si = 0; si < sizes.length; si++) {
      var nn = sizes[si], m = matteAt(nn);
      for (dr = -span; dr <= span; dr += 4) {
        var x0 = w - (rMid + dr) - nn;
        if (x0 < 0 || x0 + nn > w) continue;
        for (db = -span; db <= span; db += 4) {
          var y0 = h - (bMid + db) - nn;
          if (y0 < 0 || y0 + nn > h) continue;
          var r = fitAt(Y, w, h, stride, x0, y0, nn, m, white);
          if (r.a < 0.12 || r.a > 0.60) continue;
          if (!best || r.evidence > best.evidence)
            best = { x0: x0, y0: y0, n: nn, alpha: r.a, evidence: r.evidence };
        }
      }
    }
    if (!best) return null;

    // Fine: walk size and position one step at a time around the winner.
    var refined = best;
    for (var dn = -4; dn <= 4; dn += 2) {
      var n2 = best.n + dn; if (n2 < 16 || n2 >= mn) continue;
      var m2 = matteAt(n2);
      for (var dx = -4; dx <= 4; dx++) for (var dy = -4; dy <= 4; dy++) {
        var X = best.x0 + dx, Yy = best.y0 + dy;
        if (X < 0 || Yy < 0 || X + n2 > w || Yy + n2 > h) continue;
        var rr = fitAt(Y, w, h, stride, X, Yy, n2, m2, white);
        if (rr.a < 0.12 || rr.a > 0.60) continue;
        if (rr.evidence > refined.evidence)
          refined = { x0: X, y0: Yy, n: n2, alpha: rr.a, evidence: rr.evidence };
      }
    }
    return refined;
  }

  global.UnsparkleCore = {
    fitAt: fitAt, locateCorner: locateCorner,
    SIZE_RATIO: SIZE_RATIO, MIN_EVIDENCE: 2.6,
    ALPHA: ALPHA, WHITE: WHITE, ALPHA_RGB: ALPHA_RGB,
    REF: {w: REF_W, h: REF_H, n: REF_N, insetRight: INSET_RIGHT, insetBottom: INSET_BOTTOM},
    geometry: geometry, geometryCandidates: geometryCandidates, CONFIGS: CONFIGS,
    matteAt: matteAt, unblendI420: unblendI420,
    unblendFrame: unblendFrame,
    unblendRGBA: unblendRGBA, measure: measure, repairRimRGBA: repairRimRGBA
  };
})(typeof self !== "undefined" ? self : this);
