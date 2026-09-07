#!/usr/bin/env python3
"""
Benchmark any watermark remover against the original.

Removing the watermark is the easy half. The half nobody measures is what the
tool did to the rest of the frame on its way out — so this scores fidelity
*outside* the watermark patch, where a re-encode does its damage, and checks
whether the watermark actually went away.

    ./bench/compare.py original.mp4 candidate-a.mp4 candidate-b.mp4

Reports, per candidate:
  size          bytes and percentage of the original
  PSNR          luma, against the original, excluding the watermark patch
  alpha         measured watermark opacity at several timestamps
                (~0.30 = still there, ~0.00 = gone)

Needs ffmpeg on PATH plus numpy and opencv-python-headless.
"""
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cli"))
import unsparkle as us                                            # noqa: E402
import cv2                                                        # noqa: E402


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,nb_frames",
         "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    w, h, n = (out.split(",") + ["0"])[:3]
    return int(w), int(h)


def luma(path, w, h, limit=None):
    fs = w * h * 3 // 2
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo",
         "-pix_fmt", "yuv420p", "-"], capture_output=True).stdout
    n = len(raw) // fs
    if limit:
        n = min(n, limit)
    buf = np.frombuffer(raw[:n * fs], np.uint8).reshape(n, fs)
    return buf[:, :w * h].reshape(n, h, w)


def alpha(Y, w, h):
    """Watermark opacity implied by this frame, via a plane fit on the ring."""
    m, _, x0, y0 = us.load_matte(w, h)
    n = m.shape[0]
    roi = Y[y0:y0 + n, x0:x0 + n].astype(np.float64)
    ring = cv2.dilate((m > 0.01).astype(np.uint8), np.ones((5, 5), np.uint8)) == 0
    yy, xx = np.mgrid[0:n, 0:n]
    A = np.stack([np.ones(ring.sum()), xx[ring], yy[ring]], 1)
    g, *_ = np.linalg.lstsq(A, roi[ring], rcond=None)
    B = (np.stack([np.ones(n * n), xx.ravel(), yy.ravel()], 1) @ g).reshape(n, n)
    C = us.WHITE["Y"]
    den = (m * m * (C - B) ** 2).sum()
    return float((m * (C - B) * (roi - B)).sum() / den) if den > 1e-6 else 0.0


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    src, cands = sys.argv[1], sys.argv[2:]
    w, h = probe(src)
    S = luma(src, w, h)
    m, _, x0, y0 = us.load_matte(w, h)
    n = m.shape[0]
    patch = np.zeros((h, w), bool)
    patch[y0:y0 + n, x0:x0 + n] = True
    picks = [i for i in (len(S) // 10, len(S) // 2, len(S) * 9 // 10) if i < len(S)]

    print("original: %s  %dx%d  %d frames  %.2f MB"
          % (os.path.basename(src), w, h, len(S), os.path.getsize(src) / 1e6))
    print("  watermark opacity in source: %s"
          % "  ".join("%+.4f" % alpha(S[i], w, h) for i in picks))
    print()
    print("%-26s %11s %9s  %s" % ("candidate", "size", "PSNR*", "watermark opacity"))
    print("-" * 78)
    for c in cands:
        C = luma(c, w, h, limit=len(S))
        k = min(len(S), len(C))
        se = cnt = 0
        for i in range(0, k, 8):
            d = (S[i].astype(np.float64) - C[i].astype(np.float64))[~patch]
            se += (d ** 2).sum(); cnt += d.size
        psnr = 10 * np.log10(255 ** 2 / max(se / cnt, 1e-9))
        a = [alpha(C[i], w, h) for i in picks if i < len(C)]
        verdict = "CLEAN" if max(a) < 0.12 else "STILL PRESENT"
        print("%-26s %8.2f MB %8.1f dB  %s  %s"
              % (os.path.basename(c)[:26], os.path.getsize(c) / 1e6, psnr,
                 " ".join("%+.4f" % v for v in a), verdict))
    print()
    print("* luma PSNR against the original, measured only OUTSIDE the watermark")
    print("  patch — it scores what the tool did to the rest of your video.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
