#!/usr/bin/env python3
"""
unsparkle dashboard - a local web UI for inspecting and removing the
Gemini/Veo sparkle watermark.

    ./dashboard.py [--dir ~/Downloads] [--port 8765]

Runs entirely on your machine: it scans a folder, shows you exactly what the
watermark looks like before and after un-blending on any frame you pick, then
queues the real encode. Nothing is uploaded anywhere.
"""

import argparse
import base64
import io
import json
import mimetypes
import os
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unsparkle as us

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}

STATE = {"dir": os.path.expanduser("~/Downloads"), "recursive": False}
JOBS = {}
JOB_SEQ = [0]
LOCK = threading.Lock()
WORK = queue.Queue()
PROBE_CACHE = {}


# ------------------------------------------------------------------ helpers

def grab_yuv(path, t=0.0):
    """Decode a single frame at time t into (Y, U, V) planes."""
    info = probe(path)
    W, H = info["width"], info["height"]
    cmd = ["ffmpeg", "-v", "error"]
    if t > 0:
        cmd += ["-ss", "%.3f" % t]
    cmd += ["-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    need = W * H * 3 // 2
    if len(raw) < need:
        return None
    b = np.frombuffer(raw[:need], np.uint8)
    Y = b[:W * H].reshape(H, W)
    U = b[W * H:W * H + W * H // 4].reshape(H // 2, W // 2)
    V = b[W * H + W * H // 4:].reshape(H // 2, W // 2)
    return Y, U, V


def probe(path):
    key = (path, os.path.getmtime(path))
    if key not in PROBE_CACHE:
        PROBE_CACHE.clear()
        PROBE_CACHE[key] = us.ffprobe(path)
    return PROBE_CACHE[key]


def ring_mask(m):
    d = cv2.dilate((m > 0.01).astype(np.uint8), np.ones((5, 5), np.uint8))
    return d == 0


def plane_fit(roi, ring):
    h, w = roi.shape
    yy, xx = np.mgrid[0:h, 0:w]
    A = np.stack([np.ones(ring.sum()), xx[ring], yy[ring]], 1)
    g, *_ = np.linalg.lstsq(A, roi[ring], rcond=None)
    full = np.stack([np.ones(h * w), xx.ravel(), yy.ravel()], 1) @ g
    return full.reshape(h, w)


def implied_alpha(Y, m, x0, y0):
    """How strongly the sparkle is present in this frame. ~0.296 = watermarked,
    ~0 = clean. Reuses the same estimator the constants were measured with."""
    n = m.shape[0]
    roi = Y[y0:y0 + n, x0:x0 + n].astype(np.float64)
    ring = ring_mask(m)
    B = plane_fit(roi, ring)
    C = us.WHITE["Y"]
    den = (m ** 2 * (C - B) ** 2).sum()
    if den < 1e-6:
        return 0.0
    return float((m * (C - B) * (roi - B)).sum() / den)


def unblend_planes(Y, U, V, m, mc, x0, y0, strength=1.0, repair=True):
    n = m.shape[0]
    cn, cx0, cy0 = n // 2, x0 // 2, y0 // 2
    band = us.edge_band(m) if repair else None
    out = []
    for k, plane, py, px, pn, cov in (
            ("Y", Y, y0, x0, n, m),
            ("U", U, cy0, cx0, cn, mc),
            ("V", V, cy0, cx0, cn, mc)):
        p = plane.copy()
        a = us.ALPHA[k] * cov * strength
        roi = p[py:py + pn, px:px + pn].astype(np.float64)
        rec = np.clip((roi - a * us.WHITE[k]) / (1.0 - a), 0, 255)
        if k == "Y" and band is not None:
            rec = cv2.inpaint(np.round(rec).astype(np.uint8), band, 3,
                              cv2.INPAINT_TELEA).astype(np.float64)
        p[py:py + pn, px:px + pn] = np.round(rec).astype(np.uint8)
        out.append(p)
    return out


def yuv_to_bgr(Y, U, V):
    H, W = Y.shape
    buf = np.concatenate([Y.ravel(), U.ravel(), V.ravel()]).reshape(H * 3 // 2, W)
    return cv2.cvtColor(buf, cv2.COLOR_YUV2BGR_I420)


def png_b64(img, zoom=1):
    if zoom != 1:
        img = cv2.resize(img, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_NEAREST)
    ok, buf = cv2.imencode(".png", img)
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def jpg_b64(img, q=92, maxw=520):
    if img.shape[1] > maxw:
        s = maxw / img.shape[1]
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()


# ------------------------------------------------------------------ endpoints

def api_status():
    enc = us.available_encoders()
    try:
        args, desc = us.pick_encoder("auto", None)
    except SystemExit:
        desc = None
    gpu = ""
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                           capture_output=True, timeout=3)
        gpu = r.stdout.decode().strip().splitlines()[0] if r.returncode == 0 else ""
    except Exception:
        pass
    return {
        "encoder": desc,
        "has_x264": "libx264" in enc,
        "has_nvenc": "h264_nvenc" in enc,
        "gpu": gpu,
        "dir": STATE["dir"],
        "alpha": us.ALPHA, "white": us.WHITE,
    }


def api_scan(params):
    d = os.path.expanduser(params.get("dir", [STATE["dir"]])[0])
    STATE["dir"] = d
    if not os.path.isdir(d):
        return {"error": "not a directory: %s" % d, "videos": []}
    files = []
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        if not os.path.isfile(p) or os.path.splitext(name)[1].lower() not in VIDEO_EXT:
            continue
        try:
            info = probe(p)
        except SystemExit:
            continue
        except Exception:
            continue
        files.append({
            "path": p, "name": name,
            "width": info["width"], "height": info["height"],
            "duration": info["duration"], "size": info["size"],
            "fps": info["fps"], "audio": info["has_audio"],
            "cleaned": os.path.exists(os.path.join(
                d, os.path.splitext(name)[0] + "-clean" + os.path.splitext(name)[1])),
        })
    return {"dir": d, "videos": files}


def api_preview(params):
    path = params["path"][0]
    t = float(params.get("t", ["0"])[0])
    strength = float(params.get("strength", ["1"])[0])
    repair = params.get("repair", ["1"])[0] != "0"
    info = probe(path)
    W, H = info["width"], info["height"]
    planes = grab_yuv(path, t)
    if planes is None:
        return {"error": "could not decode a frame at %.2fs" % t}
    Y, U, V = planes
    m, mc, x0, y0 = us.load_matte(W, H)
    n = m.shape[0]
    a = implied_alpha(Y, m, x0, y0)
    Y2, U2, V2 = unblend_planes(Y, U, V, m, mc, x0, y0, strength, repair)
    before = yuv_to_bgr(Y, U, V)
    after = yuv_to_bgr(Y2, U2, V2)
    pad = 10
    sy, sx = max(0, y0 - pad), max(0, x0 - pad)
    ey, ex = min(H, y0 + n + pad), min(W, x0 + n + pad)
    zoom = max(1, int(360 / (ex - sx)))
    return {
        "alpha": a,
        "ratio": a / us.ALPHA["Y"],
        "patch": {"x": x0, "y": y0, "n": n},
        "frame": {"w": W, "h": H},
        "cropBefore": png_b64(before[sy:ey, sx:ex], zoom),
        "cropAfter": png_b64(after[sy:ey, sx:ex], zoom),
        "fullBefore": jpg_b64(before),
        "fullAfter": jpg_b64(after),
        "box": {"x": (x0 - sx) * zoom, "y": (y0 - sy) * zoom, "n": n * zoom},
    }


def api_enqueue(body):
    ids = []
    for p in body.get("paths", []):
        with LOCK:
            JOB_SEQ[0] += 1
            jid = JOB_SEQ[0]
            JOBS[jid] = {
                "id": jid, "path": p, "name": os.path.basename(p),
                "state": "queued", "pct": 0, "frames": 0, "total": 0,
                "msg": "", "srcSize": os.path.getsize(p), "outSize": 0,
                "out": "", "started": 0, "elapsed": 0,
            }
        ids.append(jid)
        WORK.put((jid, body.get("quality"), body.get("encoder", "auto"),
                  body.get("suffix", "-clean")))
    return {"ids": ids}


def worker():
    while True:
        jid, quality, encoder, suffix = WORK.get()
        job = JOBS[jid]
        src = job["path"]
        base, ext = os.path.splitext(src)
        dst = base + suffix + ext
        job.update(state="running", started=time.time(), out=dst)
        cmd = [sys.executable, os.path.join(HERE, "unsparkle.py"), src, "-o", dst,
               "--encoder", encoder]
        if quality:
            cmd += ["--quality", str(quality)]
        try:
            pr = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                  text=True, bufsize=1)
            for line in pr.stderr:
                line = line.strip()
                mm = re.match(r"(\d+)/(\d+) frames", line)
                if mm:
                    f, tot = int(mm.group(1)), int(mm.group(2))
                    job.update(frames=f, total=tot,
                               pct=round(100.0 * f / max(tot, 1), 1),
                               elapsed=time.time() - job["started"])
                elif line.startswith("error:"):
                    job["msg"] = line[6:].strip()
                elif "encoder:" in line:
                    job["msg"] = line.split("encoder:")[-1].strip()
            rc = pr.wait()
            job["elapsed"] = time.time() - job["started"]
            if rc == 0 and os.path.exists(dst):
                job.update(state="done", pct=100, outSize=os.path.getsize(dst))
            else:
                job.update(state="failed", msg=job["msg"] or "exit %d" % rc)
        except Exception as e:
            job.update(state="failed", msg=str(e))
        WORK.task_done()


# ------------------------------------------------------------------ http

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                with open(os.path.join(HERE, "ui.html"), "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            if u.path == "/api/status":
                return self._send(200, api_status())
            if u.path == "/api/scan":
                return self._send(200, api_scan(q))
            if u.path == "/api/preview":
                return self._send(200, api_preview(q))
            if u.path == "/api/jobs":
                with LOCK:
                    return self._send(200, {"jobs": list(JOBS.values())})
            if u.path == "/api/file":
                p = q["path"][0]
                if not os.path.isfile(p):
                    return self._send(404, {"error": "not found"})
                ctype = mimetypes.guess_type(p)[0] or "application/octet-stream"
                with open(p, "rb") as f:
                    return self._send(200, f.read(), ctype)
            self._send(404, {"error": "no such endpoint"})
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            if u.path == "/api/run":
                return self._send(200, api_enqueue(body))
            if u.path == "/api/clear":
                with LOCK:
                    for k in [k for k, v in JOBS.items() if v["state"] in ("done", "failed")]:
                        del JOBS[k]
                return self._send(200, {"ok": True})
            self._send(404, {"error": "no such endpoint"})
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})


def main():
    ap = argparse.ArgumentParser(description="Local dashboard for unsparkle.")
    ap.add_argument("--dir", default=os.path.expanduser("~/Downloads"))
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    STATE["dir"] = os.path.expanduser(a.dir)
    for _ in range(max(1, a.workers)):
        threading.Thread(target=worker, daemon=True).start()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    url = "http://%s:%d/" % (a.host, a.port)
    print("unsparkle dashboard  ->  %s" % url)
    print("scanning: %s" % STATE["dir"])
    if not a.no_open:
        try:
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
