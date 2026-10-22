#!/usr/bin/env python3
"""Plane Radar tower radio tuner (port 8091). Switches RTLSDR-Airband between preset files and reports activity.
GET /status            -> current preset, all presets, last heard + recent activity
GET /tune?preset=ID    -> switch to a preset (ID must be one of the preset files)
GET /levels            -> signal / noise / squelch (dBFS) for each frequency in the current preset
GET /squelch?db=3..20  -> fixed squelch in every preset (db=auto for RTLSDR-Airband's automatic squelch)
GET /gain              -> current gain;  /gain?db=N sets the radio gain (10-49.6) in every preset"""
import json, os, shutil, subprocess, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PRESETS = "/usr/local/etc/airband/presets"
ACTIVE = "/usr/local/etc/rtl_airband.conf"
STATE = "/usr/local/etc/airband/current"
lock = threading.Lock()

# --- last heard: watch RTLSDR-Airband's per-frequency activity counters ---
import re, time
STATS = "/run/rtl_airband_stats.txt"
ACT = re.compile(r'^channel_activity_counter\{freq="([0-9.]+)"(?:,label="([^"]*)")?\}\s+(\d+)')
prev, recent = {}, []   # recent: newest first, [{"label","freq","ts"}]

def watch_activity():
    while True:
        try:
            seen = {}
            for line in open(STATS):
                m = ACT.match(line)
                if m:
                    seen[m.group(1)] = (m.group(2) or m.group(1) + " MHz", int(m.group(3)))
            for freq, (label, n) in seen.items():
                if freq in prev and n > prev[freq]:
                    recent[:] = [r for r in recent if r["freq"] != freq]
                    recent.insert(0, {"label": label, "freq": freq, "ts": int(time.time())})
                    del recent[8:]
                prev[freq] = n
        except OSError:
            pass
        time.sleep(3)

threading.Thread(target=watch_activity, daemon=True).start()

def presets():
    out = []
    for f in sorted(os.listdir(PRESETS)):
        if f.endswith(".conf"):
            with open(os.path.join(PRESETS, f)) as fh:
                title = fh.readline().lstrip("# ").strip()
            out.append({"id": f[:-5], "title": title})
    return out

# --- signal meter: read RTLSDR-Airband's per-frequency levels from its stats file ---
LVL = re.compile(r'^channel_(dbfs_signal_level|dbfs_noise_level|squelch_level|activity_counter|squelch_counter)\{freq="([0-9.]+)"(?:,label="([^"]*)")?\}\s+(-?[0-9.]+|-?inf|nan)')

def levels():
    out = {}
    try:
        for line in open(STATS):
            m = LVL.match(line)
            if not m:
                continue
            key, freq, label, val = m.groups()
            try:
                v = float(val)
            except ValueError:
                v = None
            ch = out.setdefault(freq, {"freq": freq, "label": label or freq})
            ch[{"dbfs_signal_level": "signal_dbfs", "dbfs_noise_level": "noise_dbfs", "squelch_level": "squelch",
                "activity_counter": "activity", "squelch_counter": "squelch_opens"}[key]] = None if v is None else round(v, 1)
    except OSError:
        pass
    for ch in out.values():
        s_, n_ = ch.get("signal_dbfs"), ch.get("noise_dbfs")
        ch["snr_db"] = round(s_ - n_, 1) if s_ is not None and n_ is not None else None
    return sorted(out.values(), key=lambda c: c["freq"])

SQ = re.compile(r'\s*squelch_snr_threshold = [0-9.]+;')

def set_squelch(db):
    """Write the squelch into every preset (and the active config), then restart the radio."""
    for f in sorted(os.listdir(PRESETS)):
        if not f.endswith(".conf"):
            continue
        path = os.path.join(PRESETS, f)
        txt = SQ.sub("", open(path).read())
        if db is not None:
            txt = re.sub(r'(label = "[^"]*";)', r'\1 squelch_snr_threshold = %.1f;' % db, txt)
            txt = re.sub(r'(labels = \([^)]*\);)', r'\1 squelch_snr_threshold = %.1f;' % db, txt)
        open(path, "w").write(txt)
    cur = current()
    if cur:
        tune(cur)
    open("/usr/local/etc/airband/squelch", "w").write("auto" if db is None else str(db))

def squelch_setting():
    try:
        return open("/usr/local/etc/airband/squelch").read().strip()
    except OSError:
        return "auto"

GAIN_RE = re.compile(r'gain = [0-9.]+;')

def set_gain(db):
    """Write the gain into every preset, then retune so the radio picks it up."""
    for f in sorted(os.listdir(PRESETS)):
        if f.endswith(".conf"):
            path = os.path.join(PRESETS, f)
            txt = GAIN_RE.sub("gain = %.1f;" % db, open(path).read())
            open(path, "w").write(txt)
    open("/usr/local/etc/airband/gain", "w").write(str(db))
    cur = current()
    if cur:
        tune(cur)

def gain_setting():
    try:
        return open("/usr/local/etc/airband/gain").read().strip()
    except OSError:
        return "35"

def current():
    try:
        return open(STATE).read().strip()
    except OSError:
        return ""

def tune(pid):
    ids = {p["id"]: p for p in presets()}
    if pid not in ids:
        return None
    with lock:
        shutil.copyfile(os.path.join(PRESETS, pid + ".conf"), ACTIVE)
        open(STATE, "w").write(pid)
        prev.clear()  # counters restart with the radio
        subprocess.run(["systemctl", "restart", "rtl_airband"], check=False)
    return ids[pid]

class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/status":
            cur = current()
            ps = presets()
            title = next((p["title"] for p in ps if p["id"] == cur), "")
            return self.send(200, {"preset": cur, "title": title, "presets": ps, "now": int(time.time()),
                                   "last_heard": recent[0] if recent else None, "recent": recent})
        if u.path == "/levels":
            return self.send(200, {"preset": current(), "squelch": squelch_setting(), "now": int(time.time()), "channels": levels()})
        if u.path == "/squelch":
            v = parse_qs(u.query).get("db", [""])[0].strip().lower()
            if v == "auto":
                set_squelch(None)
            else:
                try:
                    db = float(v)
                except ValueError:
                    return self.send(400, {"error": "use db=3..20 or db=auto"})
                if not 3 <= db <= 20:
                    return self.send(400, {"error": "use db=3..20 or db=auto"})
                set_squelch(db)
            return self.send(200, {"squelch": squelch_setting()})
        if u.path == "/gain":
            v = parse_qs(u.query).get("db", [""])[0].strip()
            if v:
                try:
                    db = float(v)
                except ValueError:
                    return self.send(400, {"error": "use db=10..49"})
                if not 10 <= db <= 49.6:
                    return self.send(400, {"error": "use db=10..49"})
                set_gain(db)
            return self.send(200, {"gain": gain_setting()})
        if u.path == "/tune":
            pid = parse_qs(u.query).get("preset", [""])[0]
            p = tune(pid)
            return self.send(200 if p else 400, p or {"error": "unknown preset"})
        self.send(404, {"error": "not found"})

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    if not current():
        tune(presets()[0]["id"])
    ThreadingHTTPServer(("0.0.0.0", 8091), H).serve_forever()
