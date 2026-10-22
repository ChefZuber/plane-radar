#!/bin/bash
# Installs "pistats": a tiny service that writes the Pi's health to pistats.json every 10 seconds,
# next to the plane data, so Home Assistant can read it at http://<pi>/tar1090/data/pistats.json
set -e

cat > /usr/local/bin/pistats.sh << 'EOS'
#!/bin/bash
# Writes Pi health (temperature, CPU, memory, disk, power warnings) as JSON every 10 seconds.
OUT_DIR=/run/readsb
cpu_sample() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat; }
while true; do
  read t1 i1 < <(cpu_sample); sleep 1; read t2 i2 < <(cpu_sample)
  cpu=$(awk -v t=$((t2 - t1)) -v i=$((i2 - i1)) 'BEGIN{ if (t > 0) printf "%.1f", 100 * (t - i) / t; else print 0 }')
  temp=$(awk '{printf "%.1f", $1 / 1000}' /sys/class/thermal/thermal_zone0/temp)
  read l1 l5 l15 _ < /proc/loadavg
  mem=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf "%.1f", 100 * (t - a) / t}' /proc/meminfo)
  disk=$(df -P / | awk 'NR==2{gsub("%", "", $5); print $5}')
  up=$(awk '{printf "%d", $1}' /proc/uptime)
  freq=$(awk '{printf "%d", $1 / 1000}' /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || echo 0)
  thr=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2); thr=${thr:-0x0}
  if [ -d "$OUT_DIR" ]; then
    printf '{"temp_c":%s,"cpu_pct":%s,"load_1m":%s,"mem_pct":%s,"disk_pct":%s,"uptime_s":%s,"cpu_mhz":%s,"throttled":"%s","now":%s}\n' \
      "$temp" "$cpu" "$l1" "$mem" "$disk" "$up" "$freq" "$thr" "$(date +%s)" > "$OUT_DIR/pistats.json.tmp"
    mv "$OUT_DIR/pistats.json.tmp" "$OUT_DIR/pistats.json"
  fi
  sleep 9
done
EOS
chmod +x /usr/local/bin/pistats.sh

cat > /etc/systemd/system/pistats.service << 'EOS'
[Unit]
Description=Pi health stats for Home Assistant
After=readsb.service

[Service]
ExecStart=/usr/local/bin/pistats.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOS

systemctl daemon-reload
systemctl enable --now pistats.service
sleep 12
echo "----- pistats output -----"
cat /run/readsb/pistats.json && echo "PISTATS OK"
