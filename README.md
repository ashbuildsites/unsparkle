<p align="center">
  <a href="https://actuallyfreegeminiwatermarkremover.com/"><img src="https://img.shields.io/badge/Online_Tool-actuallyfree...remover.com-2563eb?style=for-the-badge" alt="Online tool"></a>
  <img src="https://img.shields.io/badge/licence-MIT-green?style=for-the-badge" alt="MIT">
  <img src="https://img.shields.io/badge/runs-100%25_in_your_browser-0d1117?style=for-the-badge" alt="Client side">
</p>

# unsparkle — Gemini / Veo watermark remover

Removes the Gemini, Veo and Nano Banana sparkle watermark from **video and
images** by algebraically inverting the alpha composite that put it there —
not by inpainting over it.

**[Use it online →](https://actuallyfreegeminiwatermarkremover.com/)** · no
sign-up, no limits, nothing uploaded.

---

## Why not just inpaint it?

Most tools treat the watermark as a hole and paint a guess over it, or
re-encode the whole file at a lower bitrate. A typical online remover returns
a 10 MB clip at ~3 MB — every pixel of every frame degraded to fix a mark
covering 0.6% of the frame.

The watermark is a **constant alpha composite**, which makes it invertible:

```
observed = (1 − a·m) · original + a·m · white
```

`m` is the sub-pixel coverage of the four-point star, `a` its opacity. Solve
for `original` and the true pixels come back. Nothing is guessed.

## The measured constants

Fitted from **480 real video frames** spanning backgrounds from dark red
fabric to bright skin tone, then confirmed independently on the Y, U and V
planes and again on a 1408×768 still:

| Quantity | Value |
| :--- | :--- |
| Opacity, video (YUV) | `0.2962` luma · `0.2923` U · `0.2794` V |
| Opacity, image (sRGB) | `0.2975` (B 0.2959 · G 0.2983 · R 0.2983) |
| Watermark colour | white — `Y 235, U 128, V 128` (limited range) |
| Residual reduction | **14×** vs. leaving it alone (video), **9.6×** (image) |

### Watermark geometry

Gemini picks from a small catalogue rather than scaling with resolution. The
first row was measured here; the others are the configurations documented by
[GargantuaX/gemini-watermark-remover](https://github.com/GargantuaX/gemini-watermark-remover),
whose independent work on this problem predates ours:

| Size | Right margin | Bottom margin | Source |
| :--- | :--- | :--- | :--- |
| 76×76 | 80 px | 84 px | measured here (720×1280 video, 1408×768 still) |
| 96×96 | 64 px | 64 px | upstream, larger outputs |
| 48×48 | 32 px | 32 px | upstream, smaller outputs |

Every candidate is scored against the actual pixels and the best one wins, so
an unfamiliar output is handled rather than silently missed.

## What makes this one different

- **Video is first class.** WebCodecs rather than `ffmpeg.wasm`: hardware
  accelerated, ~180 KB of JS instead of ~25 MB, and no `SharedArrayBuffer`, so
  the page needs no cross-origin isolation. A 10-second 720×1280 clip cleans
  in **about one second**.
- **Frames are corrected on their native I420/NV12 planes.** Alpha
  compositing is affine, so the same equation holds in YUV as in RGB — no RGB
  round trip, no colour-matrix guessing. That alone moved untouched-area
  fidelity from 40 dB to **46 dB** PSNR.
- **Audio is copied, never re-encoded.** Encoded AAC samples are remuxed
  as-is.
- **It refuses to guess.** Each file gets a confidence score. Below the
  threshold nothing is modified — a clean image comes back byte-for-byte
  unchanged. An earlier version searched the whole image for the mark; it was
  removed after it confidently "found" a watermark 800 px from the truth and
  damaged clean pixels.
- **It reports its own work.** The same estimator that finds the watermark
  measures the result: `~0.30` before, `~0.00` after, shown per file.

## Measured against a re-encoding remover

Removing the watermark is the easy half. The half nobody measures is what the
tool does to the rest of the frame on the way out. Same 10-second Gemini clip,
same machine:

| | Output size | Fidelity outside the patch* | Watermark gone |
| :--- | :--- | :--- | :--- |
| Original | 10.06 MB | — | — |
| A re-encoding remover | 4.07 MB (40%) | **30.5 dB** | yes |
| **unsparkle** | 5.60 MB (56%) | **43.9 dB** | yes |

On a second clip: **28.1 dB vs 45.6 dB**, and the re-encoding tool left the
watermark visibly intact across part of the timeline while reporting success.

\* Luma PSNR against the original, measured only *outside* the watermark
patch, so it scores what the tool did to everything else. ~30 dB is where
compression artifacts start showing on detailed material; the mid-40s is
visually indistinguishable.

Do not take our word for it — [`bench/compare.py`](bench/compare.py) runs the
measurement on any two outputs:

```bash
./bench/compare.py original.mp4 candidate-a.mp4 candidate-b.mp4
```

It reports size, PSNR outside the patch, and the measured watermark opacity
per candidate — so "did it actually work" and "what did it cost" are both
numbers rather than claims.

## Use it

### Online (recommended)

<https://actuallyfreegeminiwatermarkremover.com/> — video and images, entirely
in your browser.

### In your own page

```html
<script src="src/unsparkle-core.js"></script>
<script src="src/unsparkle-image.js"></script>
<script>
  const res = await UnsparkleImage.process(file);
  if (res.found) download(res.blob);          // else: nothing was changed
</script>
```

Video additionally needs `mp4box.js` and `mp4-muxer`:

```html
<script src="mp4box.all.min.js"></script>
<script src="mp4-muxer.min.js"></script>
<script src="src/unsparkle-core.js"></script>
<script src="src/unsparkle-video.js"></script>
<script>
  const res = await UnsparkleVideo.process(file, { quality: 16 });
  console.log(res.stats.alphaBefore, "->", res.stats.alphaAfter);
</script>
```

### Command line (Python)

For batch work, long clips, or anything you want to keep off a browser:

```bash
pip install numpy opencv-python-headless        # plus ffmpeg on PATH
./cli/unsparkle.py video.mp4                    # -> video-clean.mp4
./cli/unsparkle.py *.mp4 -o cleaned/            # batch
./cli/unsparkle.py in.mp4 --quality 14          # CRF; lower = better
```

It streams frame by frame, so file size and length are unbounded. There is
also `cli/dashboard.py`, a small local web UI over the same code.

## API

| Call | Returns |
| :--- | :--- |
| `UnsparkleImage.process(file)` | `{found, blob, alphaBefore, alphaAfter, evidence, geom}` |
| `UnsparkleVideo.process(file, {quality, onProgress})` | `{blob, stats}` |
| `UnsparkleCore.geometryCandidates(w, h)` | plausible watermark placements |
| `UnsparkleCore.measure(Y, w, h, geom, stride)` | opacity present at a placement |

## Requirements

Video needs [WebCodecs](https://caniuse.com/webcodecs) — Chrome, Edge, or
Safari 16.4+. Images work anywhere with `<canvas>`.

## Limitations

- **It does not remove SynthID.** This removes the visible corner sparkle
  only. SynthID is Google's separate invisible watermark carried across the
  whole frame; nothing here targets or removes it, and any tool claiming
  otherwise deserves scepticism.
- Compression ringing along the mark's hard edge is a JPEG/H.264 artifact
  rather than part of the blend, so it cannot be un-blended. A few diffusion
  sweeps along the rim clear it; on very low-quality sources a faint trace can
  remain.
- The geometry catalogue covers the configurations we have seen. An output
  with a different watermark size will be reported as "not found" rather than
  mangled — please open an issue with the resolution.

## Credits

The reverse-alpha-blending approach to this watermark was published first by
[GargantuaX/gemini-watermark-remover](https://github.com/GargantuaX/gemini-watermark-remover)
(MIT). This is an independent implementation: the constants here were measured
from scratch, and the video path is built on WebCodecs rather than a port of
theirs. Their geometry table for other output sizes is used with attribution.

## Legal

Use this on footage and images you have the right to edit. Removing a
provenance marker to pass AI-generated media off as genuine is a bad idea and,
in some contexts, unlawful. This exists so that people who generated their own
content are not forced to choose between a watermark and a mangled re-encode.

Not affiliated with Google. Gemini, Veo, Nano Banana and SynthID are
trademarks of Google LLC.

## Licence

MIT — see [LICENSE](LICENSE).
