#!/bin/bash
# Plane Radar: give readsb an aircraft database so every plane gets its tail number and type
# (e.g. "N78525 · C172 · Cessna 172") everywhere: round display, Car Thing, HA, sightings log.
# Uses the free tar1090-db list, refreshed monthly.
set -e
DB=/usr/local/share/tar1090/aircraft.csv.gz
mkdir -p /usr/local/share/tar1090

echo "== 1. Download the aircraft database =="
curl -fsSL -o $DB.tmp https://github.com/wiedehopf/tar1090-db/raw/csv/aircraft.csv.gz
mv $DB.tmp $DB
ls -la $DB

echo "== 2. Tell readsb to use it =="
cp /etc/default/readsb /etc/default/readsb.bak-db
if ! grep -q -- "--db-file" /etc/default/readsb; then
  if grep -q '^JSON_OPTIONS=' /etc/default/readsb; then
    sed -i -E "s#^JSON_OPTIONS=\"#JSON_OPTIONS=\"--db-file $DB --db-file-lt #" /etc/default/readsb
  else
    echo "JSON_OPTIONS=\"--db-file $DB --db-file-lt\"" >> /etc/default/readsb
  fi
fi
grep -E '^(RECEIVER|JSON)_OPTIONS' /etc/default/readsb

echo "== 3. Refresh it once a month =="
cat > /etc/cron.monthly/planeradar-aircraft-db << EOS
#!/bin/sh
curl -fsSL -o $DB.tmp https://github.com/wiedehopf/tar1090-db/raw/csv/aircraft.csv.gz && mv $DB.tmp $DB && systemctl restart readsb
EOS
chmod +x /etc/cron.monthly/planeradar-aircraft-db

echo "== 4. Restart plane tracking =="
systemctl restart readsb
sleep 20
if ! systemctl is-active --quiet readsb || ! [ -s /run/readsb/aircraft.json ]; then
  echo "!! readsb didn't like the new option. Putting the old settings back so plane tracking keeps working."
  cp /etc/default/readsb.bak-db /etc/default/readsb
  systemctl restart readsb
  sleep 5
  echo "planes: $(systemctl is-active readsb) (restored)"
  exit 1
fi
echo "planes: $(systemctl is-active readsb)"
python3 - << 'EOP'
import json
a = json.load(open("/run/readsb/aircraft.json"))["aircraft"]
named = [x for x in a if x.get("r")]
print(f"{len(a)} aircraft, {len(named)} with tail numbers")
for x in named[:5]:
    print(" ", (x.get("flight") or "").strip(), x.get("r"), x.get("t"), x.get("desc", ""))
EOP
echo READSB-DB-DONE
