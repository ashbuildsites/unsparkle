#!/usr/bin/env python3
"""
unsparkle - remove the Gemini / Veo "sparkle" watermark from videos.

Instead of inpainting (which destroys texture), this inverts the alpha
compositing that put the watermark there in the first place:

    observed = (1 - a*m) * original + a*m * white

where `m` is a sub-pixel coverage matte of the 4-point star and `a` is a
constant opacity. Solving for `original` recovers the true pixels almost
exactly, so fabric texture, embroidery and skin detail survive intact.

Alpha compositing is affine, so the same equation holds in YUV as in RGB.
We therefore work directly on the decoded yuv420p planes: no RGB round
trip, no colour-matrix guessing, and every pixel outside the ~76x76 patch
stays bit-identical until the final encode.

Measured on 720x1280 Gemini output: a=0.2962 (luma), white=Y235/U128/V128,
i.e. pure white at limited (TV) range.
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys

import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None

# ---------------------------------------------------------------- constants

# Coverage matte for the sparkle, measured from 720x1280 Gemini renders.
# 76x76 8-bit PNG; the patch sits at (564, 1120) in the luma plane.
MATTE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAEwAAABMCAAAAADi/A73AAADkklEQVRYCa3Be2iVZQDH8e/ved+znbPT3AKNoNC8kWhBJNL8YyaWFESGRZbQBiPy8k83IoykoEDwEkKgEpVFFBE5wpAsuoosayMMK1BEkShIKJlNz/19nubKODue8z774/l8REAiIBGQCEgEJAISAYmAREAiIBGQCEgEJAISPp0Y4xhlCoRPh5ykMaZAeOSK1x0pLStqFD/h07FiX2bV17qIn/DJ7eoze57nPH7CI5sZXsCfCyu1i3gJj2nL9wMPHRzDT3jM2NEPfPnAefyEx+37uxjX8z1+wuOtR2Kg9OG6El4iVdfMoU4uKa8Z+gsfkWr+4CLDhK/uLXQUSCdSbd7czn82bcVHpJl9LNPOv+yZtcN4iBQrtt/KZU7HVp8mnUhxaHGeS6yEdeeHVpFOtJR9cZM1THACkmjXMyXSiJa2DFxLPUvxzSdII1qY/XpPniscfuoHWhPNLdo7v1vgEHVqxZMPnqYl0Uz+0c1dyjjnhEBcVourF7ftqRRoTjSxcmBl3J1UM8YJMdlY7mj/cZoTDaZV5m4cMFkqiiqxQELUcZTd2ztP0oxocOdjd9fayKvqXMQ4AxL1aqbw92fvfMOVRL3evt5ZtsMZoGwjjBMSEo3KtdNf7PuWBqLO0eszUSYhagfKYBAIYZjMGqBa+mUpk4k6x+YVc+0WRbgkcUQIhJCYkDhjwKkaVU21nP95MZOJerf1LZsTq42KwFgBAiHEBCesYcKZ/R8coYFocMfa+7KxMxljDTVAIIn/OcGoObT7U64kGuSKC9ZvUEbOxi4BBBKiTm3vzuM0I5qYOXijyQMJCMQ4McEmteLQnoM0J5rp2LT+mkKHs4wTIMYJqLT9sfX9s7Qgmpv10dxOEjmBQMiBYOxU/0+0JFq4aXfvuS5jnRBIOOTK2cGnf6U10dL2h6ervdIG2CSDNdX43N5nSSNa27bRdRZzWFMiC5TjHS8VSCNSfLLkqiw4V43iJCoXTi0hnUgx5+N57Vziahn4cd0I6USamw9rmjVWNqJWu+UEHiLVk1tySYRzBl5+AR+R6up3VyZZwJrv7jmHj0iVW/x5HDMuueE3vITHa2u6ZM2F9zbgJzwWHpqe2MzZVcP4CZ/B+5149bkCfsLnrgOxG109UsBPeP0+w5xYUmAKhE/+lT698ThTIbyWHuhePlJiCoTfSK7nAlMhAhIBiYBEQCIgEZAISAQkAhIBiYBEQP8AcIUWXLx18N4AAAAASUVORK5CYII="

REF_W, REF_H = 720, 1280
REF_X0, REF_Y0 = 564, 1120           # even-aligned so 4:2:0 chroma divides cleanly
REF_SIZE = 76

# Per-plane opacity. Chroma reads slightly lower because 4:2:0 subsampling
# averages the watermark edge with its surroundings.
ALPHA = {"Y": 0.2962, "U": 0.2923, "V": 0.2794}
WHITE = {"Y": 235.0, "U": 128.0, "V": 128.0}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def die(msg, code=1):
    log("error: " + msg)
    sys.exit(code)


# ---------------------------------------------------------------- ffmpeg glue

def ffprobe(path):
    cmd = ["ffprobe", "-v", "error", "-print_format", "json",
           "-show_format", "-show_streams", path]
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        die("ffprobe failed on %s: %s" % (path, out.stderr.decode()[:400]))
    info = json.loads(out.stdout)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if v is None:
        die("no video stream in %s" % path)
    has_audio = any(s["codec_type"] == "audio" for s in info["streams"])
    return {
        "width": int(v["width"]),
        "height": int(v["height"]),
        "fps": v.get("r_frame_rate", "30/1"),
        "nb_frames": int(v.get("nb_frames") or 0),
        "duration": float(info["format"].get("duration") or 0.0),
        "size": int(info["format"].get("size") or 0),
        "has_audio": has_audio,
    }


def available_encoders():
    out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"],
                         capture_output=True).stdout.decode(errors="replace")
    return set(re.findall(r"^\s*\S+\s+(\S+)", out, re.M))


def pick_encoder(pref, quality):
    """Return (ffmpeg args, human description)."""
    enc = available_encoders()
    order = [pref] if pref != "auto" else ["libx264", "h264_nvenc", "libx265"]
    for name in order:
        if name not in enc:
            continue
        if name == "libx264":
            q = 16 if quality is None else quality
            return (["-c:v", "libx264", "-preset", "slow", "-crf", str(q),
                     "-pix_fmt", "yuv420p"], "libx264 CRF %d" % q)
        if name == "libx265":
            q = 20 if quality is None else quality
            return (["-c:v", "libx265", "-preset", "medium", "-crf", str(q),
                     "-pix_fmt", "yuv420p", "-tag:v", "hvc1"], "libx265 CRF %d" % q)
        if name == "h264_nvenc":
            q = 19 if quality is None else quality
            return (["-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq",
                     "-rc", "vbr", "-cq", str(q), "-b:v", "0",
                     "-maxrate", "60M", "-bufsize", "120M",
                     "-pix_fmt", "yuv420p"], "h264_nvenc CQ %d" % q)
    die("no usable H.264 encoder found. On Fedora run:\n"
        "    sudo dnf swap ffmpeg-free ffmpeg --allowerasing\n"
        "(RPM Fusion is already enabled on this machine.)")


# ---------------------------------------------------------------- the matte

def load_matte(width, height, scale_override=None):
    """Return (luma matte, chroma matte, x0, y0) for a frame of this size."""
    if cv2 is None:
        die("opencv-python is required (pip install opencv-python)")
    png = np.frombuffer(base64.b64decode(MATTE_B64), np.uint8)
    m = cv2.imdecode(png, cv2.IMREAD_GRAYSCALE).astype(np.float64) / 255.0

    s = scale_override if scale_override else width / float(REF_W)
    if abs(s - 1.0) > 1e-6:
        n = int(round(REF_SIZE * s))
        n += n % 2                                    # keep it even for 4:2:0
        m = cv2.resize(m, (n, n), interpolation=cv2.INTER_LINEAR)
        # keep the watermark centred on the same relative spot
        cx = (REF_X0 + REF_SIZE / 2.0) / REF_W * width
        cy = (REF_Y0 + REF_SIZE / 2.0) / REF_H * height
        x0 = int(round(cx - n / 2.0)) & ~1
        y0 = int(round(cy - n / 2.0)) & ~1
    else:
        x0, y0 = REF_X0, REF_Y0

    n = m.shape[0]
    x0 = max(0, min(x0, width - n))
    y0 = max(0, min(y0, height - n))
    mc = m.reshape(n // 2, 2, n // 2, 2).mean((1, 3))   # chroma-plane coverage
    return m, mc, x0, y0


def edge_band(m):
    """Thin ring along the antialiased rim, where H.264 left ringing."""
    e = ((m > 0.02) & (m < 0.98)).astype(np.uint8)
    return cv2.dilate(e, np.ones((3, 3), np.uint8)) * 255


# ---------------------------------------------------------------- processing

def process(src, dst, args):
    info = ffprobe(src)
    W, H = info["width"], info["height"]
    if W % 2 or H % 2:
        die("odd frame size %dx%d not supported" % (W, H))

    m, mc, x0, y0 = load_matte(W, H, args.scale)
    if args.box:
        x0, y0 = args.box
    n = m.shape[0]
    band = edge_band(m) if not args.no_edge_repair else None

    # Precompute the per-plane unblend coefficients: orig = (obs - num) / den
    coef = {}
    for k, cov in (("Y", m), ("U", mc), ("V", mc)):
        a = ALPHA[k] * cov * args.strength
        coef[k] = (a * WHITE[k], 1.0 - a)

    fsz = W * H * 3 // 2
    ysz, csz = W * H, W * H // 4
    ch, cw = H // 2, W // 2
    cx0, cy0 = x0 // 2, y0 // 2
    cn = n // 2

    enc_args, enc_desc = pick_encoder(args.encoder, args.quality)
    log("  %dx%d  %s  patch %dx%d at (%d,%d)  encoder: %s"
        % (W, H, info["fps"], n, n, x0, y0, enc_desc))

    dec = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", src, "-f", "rawvideo",
         "-pix_fmt", "yuv420p", "-"],
        stdout=subprocess.PIPE, bufsize=fsz * 4)

    out_cmd = ["ffmpeg", "-y", "-v", "error",
               "-f", "rawvideo", "-pix_fmt", "yuv420p",
               "-s", "%dx%d" % (W, H), "-r", info["fps"], "-i", "pipe:0",
               "-i", src, "-map", "0:v:0"]
    if info["has_audio"]:
        out_cmd += ["-map", "1:a:0", "-c:a", "copy"]
    out_cmd += enc_args + ["-map_metadata", "1", "-movflags", "+faststart", dst]
    enc = subprocess.Popen(out_cmd, stdin=subprocess.PIPE, bufsize=fsz * 4)

    total = info["nb_frames"] or int(info["duration"] * 30)
    count = 0
    try:
        while True:
            buf = dec.stdout.read(fsz)
            if len(buf) < fsz:
                break
            f = bytearray(buf)
            planes = (
                ("Y", np.frombuffer(f, np.uint8, ysz, 0).reshape(H, W),
                 y0, x0, n),
                ("U", np.frombuffer(f, np.uint8, csz, ysz).reshape(ch, cw),
                 cy0, cx0, cn),
                ("V", np.frombuffer(f, np.uint8, csz, ysz + csz).reshape(ch, cw),
                 cy0, cx0, cn),
            )
            for k, plane, py, px, pn in planes:
                num, den = coef[k]
                roi = plane[py:py + pn, px:px + pn].astype(np.float64)
                rec = np.clip((roi - num) / den, 0, 255)
                if k == "Y" and band is not None:
                    rec = cv2.inpaint(np.round(rec).astype(np.uint8),
                                      band, 3, cv2.INPAINT_TELEA).astype(np.float64)
                plane[py:py + pn, px:px + pn] = np.round(rec).astype(np.uint8)
            enc.stdin.write(bytes(f))
            count += 1
            if count % 60 == 0 and total:
                log("    %d/%d frames" % (count, total))
    finally:
        try:
            enc.stdin.close()
        except BrokenPipeError:
            pass
        dec.stdout.close()
        dec.wait()
        rc = enc.wait()
    if rc != 0:
        die("encoder exited with status %d" % rc)
    return count, info


def parse_box(s):
    try:
        x, y = s.split(",")
        return int(x) & ~1, int(y) & ~1
    except Exception:
        raise argparse.ArgumentTypeError("expected X,Y")


def main():
    p = argparse.ArgumentParser(
        description="Remove the Gemini/Veo sparkle watermark by inverting its alpha blend.")
    p.add_argument("inputs", nargs="+")
    p.add_argument("-o", "--output",
                   help="output file (single input) or directory")
    p.add_argument("--suffix", default="-clean",
                   help="filename suffix when writing next to the input")
    p.add_argument("--encoder", default="auto",
                   choices=["auto", "libx264", "libx265", "h264_nvenc"])
    p.add_argument("--quality", type=int,
                   help="CRF (libx264/5) or CQ (nvenc); lower = better. "
                        "Defaults: x264 16, x265 20, nvenc 19")
    p.add_argument("--strength", type=float, default=1.0,
                   help="scale the correction; 1.0 is the measured value")
    p.add_argument("--scale", type=float,
                   help="override watermark scale (default: width/720)")
    p.add_argument("--box", type=parse_box,
                   help="override patch top-left as X,Y in luma pixels")
    p.add_argument("--no-edge-repair", action="store_true",
                   help="skip the thin-rim repair of H.264 ringing")
    args = p.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            die("%s not found on PATH" % tool)

    multi = len(args.inputs) > 1
    if multi and args.output and not os.path.isdir(args.output):
        die("--output must be a directory when passing several inputs")

    for src in args.inputs:
        if not os.path.isfile(src):
            die("no such file: %s" % src)
        if args.output and not multi and not os.path.isdir(args.output):
            dst = args.output
        else:
            base, ext = os.path.splitext(os.path.basename(src))
            d = args.output if args.output else os.path.dirname(src) or "."
            dst = os.path.join(d, base + args.suffix + (ext or ".mp4"))
        if os.path.abspath(dst) == os.path.abspath(src):
            die("refusing to overwrite the input: %s" % src)
        log("%s" % os.path.basename(src))
        count, info = process(src, dst, args)
        osz = os.path.getsize(dst)
        log("  wrote %s  (%d frames, %.2f MB -> %.2f MB, %.0f%% of original)\n"
            % (dst, count, info["size"] / 1e6, osz / 1e6,
               100.0 * osz / max(info["size"], 1)))


if __name__ == "__main__":
    main()
