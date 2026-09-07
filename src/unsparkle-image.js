/*
 * unsparkle-image.js - in-browser image watermark removal.
 *
 * An earlier version searched the whole image for the sparkle. It was
 * abandoned: on a synthetic test it confidently located the mark 800px from
 * the truth and "corrected" clean pixels. Measuring real Gemini stills showed
 * the search was never needed - the badge is drawn at a fixed 76x76, exactly
 * 80px from the right edge and 84px from the bottom, at every resolution.
 *
 * So this looks in one place, nudges a few pixels to absorb rounding, and
 * refuses to touch the image unless the evidence is convincing. Declining to
 * act on a clean image is the behaviour that matters most here.
 */
(function (global) {
  "use strict";
  var Core = global.UnsparkleCore;

  var MIN_EVIDENCE = 3.0;    // how much better "a sparkle is here" must fit
  var MIN_ALPHA = 0.15, MAX_ALPHA = 0.55;

  function toGray(data, w, h) {
    var g = new Float32Array(w * h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4)
      g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    return g;
  }

  var _mc = {};
  function matteN(n) { return _mc[n] || (_mc[n] = Core.matteAt(n)); }

  /*
   * Fit a plane to the ring around the patch, solve the blend for the opacity,
   * then report how much better that explains the pixels than "nothing here".
   */
  function fit(gray, w, h, x0, y0, n, m) {
    var s1 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sz = 0, sxz = 0, syz = 0;
    var x, y, val, C = 255;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      if (m[y * n + x] > 0.01) continue;
      val = gray[(y0 + y) * w + x0 + x];
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
      var obs = gray[(y0 + y) * w + x0 + x];
      num += cov * (C - base) * (obs - base);
      den += cov * cov * (C - base) * (C - base);
    }
    if (den < 1e-6) return { a: 0, evidence: 0 };
    var a = num / den, r0 = 0, r1 = 0, cnt = 0;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      var c2 = m[y * n + x]; if (c2 <= 0) continue;
      var b2 = B[0] + B[1] * x + B[2] * y;
      var o2 = gray[(y0 + y) * w + x0 + x];
      var d0 = o2 - b2, d1 = o2 - (b2 + a * c2 * (C - b2));
      r0 += d0 * d0; r1 += d1 * d1; cnt++;
    }
    r0 = Math.sqrt(r0 / cnt); r1 = Math.sqrt(r1 / cnt);
    return { a: a, evidence: r1 > 0.5 ? r0 / r1 : 0, resid: r1 };
  }

  /* Same bounded corner search the video path uses, in full-range sRGB. */
  function locate(gray, w, h) {
    return Core.locateCorner(gray, w, h, w, 255);
  }

  async function process(file, opts) {
    opts = opts || {};
    var report = opts.onProgress || function () {};
    report(5, "reading");
    var bmp = await createImageBitmap(file);
    var w = bmp.width, h = bmp.height;
    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0); bmp.close();
    var img = ctx.getImageData(0, 0, w, h);

    report(30, "checking");
    var cand = locate(toGray(img.data, w, h), w, h);
    if (!cand || cand.evidence < MIN_EVIDENCE) {
      return {
        found: false, width: w, height: h,
        evidence: cand ? cand.evidence : 0,
        message: "No Gemini watermark found in the corner of this image. " +
                 "Nothing was changed."
      };
    }

    report(60, "cleaning");
    var before = cand.alpha;
    Core.unblendRGBA(img.data, w, h,
                     { geom: { x0: cand.x0, y0: cand.y0, n: cand.n },
                       alpha: cand.alpha });
    ctx.putImageData(img, 0, 0);
    var after = fit(toGray(img.data, w, h), w, h,
                    cand.x0, cand.y0, cand.n, matteN(cand.n)).a;

    report(85, "encoding");
    var blob = await new Promise(function (r) { cv.toBlob(r, "image/png"); });
    report(100, "done");
    return {
      found: true, blob: blob, width: w, height: h,
      inSize: file.size, outSize: blob.size,
      alphaBefore: before, alphaAfter: after,
      evidence: cand.evidence, geom: cand
    };
  }

  global.UnsparkleImage = { process: process, locate: locate, fit: fit,
                            MIN_EVIDENCE: MIN_EVIDENCE };
})(typeof self !== "undefined" ? self : this);
