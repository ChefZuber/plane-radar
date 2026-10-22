#!/bin/bash
# Plane Radar: sightings log. Remembers every plane the radar has seen for one year.
# Data: /var/lib/planeradar/sightings.db (SQLite). Updated every 10 s, saved to the SD card once a minute.
# Ask it things over the network (port 8092):
#   /plane?hex=a1b2c3   one plane: first/last seen, days seen, closest pass
#   /regulars?limit=20  the planes seen on the most days
#   /recent?limit=20    most recently seen planes
#   /stats              totals
set -e
mkdir -p /var/lib/planeradar

cat > /usr/local/bin/planeradar-sightings.py << 'EOS'
#!/usr/bin/env python3
"""Plane Radar sightings log: remembers every plane seen, for one year."""
import json, math, sqlite3, threading, time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

AIRCRAFT = "/run/readsb/aircraft.json"
RECEIVER = "/run/readsb/receiver.json"
DB = "/var/lib/planeradar/sightings.db"
KEEP_DAYS = 365

db = sqlite3.connect(DB, check_same_thread=False)
db.execute("""CREATE TABLE IF NOT EXISTS planes (
  hex TEXT PRIMARY KEY, callsign TEXT, reg TEXT, type TEXT, descr TEXT,
  first_seen INTEGER, last_seen INTEGER, days INTEGER, last_day TEXT,
  closest_mi REAL, closest_ts INTEGER)""")
db.commit()
lock = threading.Lock()
cache = {}      # hex -> row dict, changes not yet saved
dirty = set()

def load(hexid):
    if hexid in cache:
        return cache[hexid]
    cur = db.execute("SELECT hex,callsign,reg,type,descr,first_seen,last_seen,days,last_day,closest_mi,closest_ts FROM planes WHERE hex=?", (hexid,))
    r = cur.fetchone()
    if not r:
        return None
    keys = ["hex", "callsign", "reg", "type", "descr", "first_seen", "last_seen", "days", "last_day", "closest_mi", "closest_ts"]
    cache[hexid] = dict(zip(keys, r))
    return cache[hexid]

def miles(lat0, lon0, lat, lon):
    n = (lat - lat0) * 69.05
    e = (lon - lon0) * 69.05 * math.cos(math.radians(lat0))
    return math.hypot(n, e)

def collect():
    rx = None
    last_save = time.time()
    last_trim = 0
    while True:
        try:
            if rx is None:
                r = json.load(open(RECEIVER))
                rx = (r["lat"], r["lon"]) if "lat" in r else None
            data = json.load(open(AIRCRAFT))
            now = int(time.time())
            today = datetime.now().strftime("%Y-%m-%d")
            with lock:
                for a in data.get("aircraft", []):
                    if a.get("seen", 99) > 15:          # only planes actually heard in the last 15 s
                        continue
                    h = a["hex"]
                    row = load(h)
                    cs = (a.get("flight") or "").strip().upper()
                    if row is None:
                        row = cache[h] = {"hex": h, "callsign": "", "reg": "", "type": "", "descr": "",
                                          "first_seen": now, "last_seen": now, "days": 0, "last_day": "",
                                          "closest_mi": None, "closest_ts": None}
                    if cs: row["callsign"] = cs
                    if a.get("r"): row["reg"] = a["r"]
                    if a.get("t"): row["type"] = a["t"]
                    if a.get("desc"): row["descr"] = a["desc"]
                    row["last_seen"] = now
                    if row["last_day"] != today:
                        row["days"] += 1
                        row["last_day"] = today
                    if rx and "lat" in a and a.get("seen_pos", 99) < 30:
                        d = miles(rx[0], rx[1], a["lat"], a["lon"])
                        if row["closest_mi"] is None or d < row["closest_mi"]:
                            row["closest_mi"] = round(d, 1)
                            row["closest_ts"] = now
                    dirty.add(h)
                if time.time() - last_save > 60:        # save once a minute (easy on the SD card)
                    save()
                    last_save = time.time()
                if time.time() - last_trim > 6 * 3600:  # forget planes not seen for a year
                    db.execute("DELETE FROM planes WHERE last_seen < ?", (now - KEEP_DAYS * 86400,))
                    db.commit()
                    last_trim = time.time()
        except Exception as ex:
            print("collect error:", ex, flush=True)
        time.sleep(10)

def save():
    rows = [cache[h] for h in dirty]
    db.executemany("""INSERT INTO planes VALUES (:hex,:callsign,:reg,:type,:descr,:first_seen,:last_seen,:days,:last_day,:closest_mi,:closest_ts)
        ON CONFLICT(hex) DO UPDATE SET callsign=excluded.callsign, reg=excluded.reg, type=excluded.type, descr=excluded.descr,
        last_seen=excluded.last_seen, days=excluded.days, last_day=excluded.last_day,
        closest_mi=excluded.closest_mi, closest_ts=excluded.closest_ts""", rows)
    db.commit()
    dirty.clear()
    if len(cache) > 5000:
        cache.clear()

def rows(sql, args=()):
    with lock:
        save()
        cur = db.execute(sql, args)
        keys = [c[0] for c in cur.description]
        return [dict(zip(keys, r)) for r in cur.fetchall()]

class H(BaseHTTPRequestHandler):
    def send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        limit = max(1, min(100, int(q.get("limit", ["20"])[0] or 20)))
        if u.path == "/plane":
            h = q.get("hex", [""])[0].lower()
            r = rows("SELECT * FROM planes WHERE hex=?", (h,))
            return self.send(r[0] if r else {"hex": h, "new": True})
        if u.path == "/regulars":
            return self.send(rows("SELECT * FROM planes ORDER BY days DESC, last_seen DESC LIMIT ?", (limit,)))
        if u.path == "/recent":
            return self.send(rows("SELECT * FROM planes ORDER BY last_seen DESC LIMIT ?", (limit,)))
        if u.path == "/stats":
            r = rows("SELECT COUNT(*) AS planes, MIN(first_seen) AS since FROM planes")[0]
            r["today"] = rows("SELECT COUNT(*) AS n FROM planes WHERE last_day=?", (datetime.now().strftime("%Y-%m-%d"),))[0]["n"]
            r["now"] = int(time.time())
            return self.send(r)
        self.send({"error": "not found"}, 404)

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    threading.Thread(target=collect, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8092), H).serve_forever()
EOS
chmod +x /usr/local/bin/planeradar-sightings.py
python3 -m py_compile /usr/local/bin/planeradar-sightings.py

cat > /etc/systemd/system/planeradar-sightings.service << 'EOS'
[Unit]
Description=Plane Radar sightings log (one year of planes seen)
After=readsb.service

[Service]
ExecStart=/usr/bin/python3 /usr/local/bin/planeradar-sightings.py
Restart=always
RestartSec=10
Nice=10

[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload
systemctl enable --now planeradar-sightings >/dev/null 2>&1
systemctl restart planeradar-sightings
sleep 75
echo "sightings: $(systemctl is-active planeradar-sightings)  planes: $(systemctl is-active readsb)  radio: $(systemctl is-active rtl_airband)"
curl -s http://127.0.0.1:8092/stats; echo
curl -s "http://127.0.0.1:8092/recent?limit=3" | cut -c1-300; echo
ls -la /var/lib/planeradar/
echo SIGHTINGS-DONE
