# Plane Radar: fetches live planes from the plane radar Pi for Home Assistant.
# HA runs this every few seconds (see packages/planeradar.yaml) and keeps the output in sensor.plane_radar_data.
import json, math, urllib.request

BASE = "http://YOUR_PI_IP/tar1090/data/"


def get(name):
    with urllib.request.urlopen(BASE + name, timeout=5) as r:
        return json.load(r)


try:
    rx = get("receiver.json")
    ac = get("aircraft.json")
    lat0, lon0 = rx["lat"], rx["lon"]
    k = math.cos(math.radians(lat0))
    planes = []
    for a in ac["aircraft"]:
        if "lat" not in a or a.get("seen_pos", 0) > 30:
            continue
        n = (a["lat"] - lat0) * 69.05
        e = (a["lon"] - lon0) * 69.05 * k
        alt = a.get("alt_baro")
        alt = alt if isinstance(alt, (int, float)) else None
        planes.append({
            "hex": a["hex"],
            "cs": (a.get("flight") or a.get("r") or a["hex"]).strip().upper(),
            "reg": a.get("r", ""),
            "desc": a.get("desc") or a.get("t", ""),
            "alt": alt,
            "gs": round(a["gs"]) if "gs" in a else None,
            "trk": round(a["track"]) if "track" in a else None,
            "n": round(n, 2),
            "e": round(e, 2),
            "d": round(math.hypot(n, e), 1),
            "brg": round(math.degrees(math.atan2(e, n)) % 360),
        })
    planes.sort(key=lambda p: p["d"])
    c = planes[0] if planes else None
    flying = [p for p in planes if p["alt"] is not None]
    hi = max(flying, key=lambda p: p["alt"]) if flying else None
    out = {
        "count": len(planes),
        "total": len(ac["aircraft"]),
        "rx": [lat0, lon0],
        "within_10": sum(1 for p in planes if p["d"] <= 10),
        "closest": c["cs"] if c else "None",
        "closest_desc": c["desc"] if c else "",
        "closest_dist": c["d"] if c else None,
        "closest_alt": c["alt"] if c else None,
        "highest": hi["cs"] if hi else "None",
        "highest_alt": hi["alt"] if hi else None,
        "overhead": bool(c and c["d"] <= 2 and c["alt"] is not None and c["alt"] < 10000),
        "planes": planes[:40],
    }
except Exception as ex:
    out = {"count": None, "error": str(ex)}

print(json.dumps(out, separators=(",", ":")))
