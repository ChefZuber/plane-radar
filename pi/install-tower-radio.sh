#!/bin/bash
# Plane Radar: tower audio on the same Pi as plane tracking, using a second RTL-SDR stick.
#   - builds RTLSDR-Airband and sets up Icecast (the audio stream: http://<pi>:8000/radio.mp3)
#   - keeps the ADS-B stick on plane tracking (readsb) and gives the other stick to the radio
#   - installs the tuner service (port 8091) that Home Assistant and the Car Thing use to switch presets
# Run from this folder:   sudo bash install-tower-radio.sh
set -e
cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
# Serial number of the stick used for tower audio. To find it: unplug (or power off) the ADS-B stick,
# run `rtl_test -t`, and copy the "SN:" value. Leave empty to be shown the serials and stop.
AIR_SERIAL=""
GAIN=20          # radio gain. Lower = less hiss but weaker far-away voices. Change later with /gain?db=N
# ---------------------------------------------------------------------------

echo "== 1. Packages =="
export DEBIAN_FRONTEND=noninteractive
echo "icecast2 icecast2/icecast-setup boolean false" | debconf-set-selections
apt-get update -qq
apt-get install -y -qq git cmake build-essential pkg-config libmp3lame-dev libshout3-dev libconfig++-dev \
  libfftw3-dev librtlsdr-dev rtl-sdr icecast2 python3 >/dev/null

echo "== 2. Keep the TV-tuner driver off the radios =="
printf 'blacklist dvb_usb_rtl28xxu\nblacklist rtl2832_sdr\nblacklist rtl2832\nblacklist rtl2830\n' > /etc/modprobe.d/blacklist-rtl-sdr-planeradar.conf
for m in rtl2832_sdr dvb_usb_rtl28xxu rtl2832; do modprobe -r $m 2>/dev/null || true; done

echo "== 3. Find the two radios =="
SERIALS=$(rtl_test -t 2>&1 | grep -oP 'SN: \K\S+' || true)
echo "Radios found (serials): $(echo $SERIALS)"
if [ -z "$AIR_SERIAL" ]; then echo "!! Set AIR_SERIAL at the top of this script (see the note there), then run it again."; exit 1; fi
if ! echo "$SERIALS" | grep -q "^$AIR_SERIAL$"; then echo "!! The tower audio stick ($AIR_SERIAL) isn't showing up."; exit 1; fi
ADSB_SERIAL=$(echo "$SERIALS" | grep -v "^$AIR_SERIAL$" | head -1)
if [ -z "$ADSB_SERIAL" ]; then echo "!! The ADS-B stick isn't showing up."; exit 1; fi
echo "plane tracking = $ADSB_SERIAL, tower audio = $AIR_SERIAL"

echo "== 4. Pin readsb (plane tracking) to the ADS-B stick =="
if ! grep -q -- "--device $ADSB_SERIAL" /etc/default/readsb; then
  cp /etc/default/readsb /etc/default/readsb.bak-airband
  sed -i -E "s/--device [^ \"]+//; s/^RECEIVER_OPTIONS=\"/RECEIVER_OPTIONS=\"--device $ADSB_SERIAL /" /etc/default/readsb
fi
systemctl restart readsb

echo "== 5. Build RTLSDR-Airband =="
mkdir -p /opt && cd /opt
[ -d RTLSDR-Airband ] || git clone -q https://github.com/rtl-airband/RTLSDR-Airband.git
cd RTLSDR-Airband && git pull -q
cmake -B build -DPLATFORM=native >/dev/null && cmake --build build -j4 >/dev/null && cmake --install build >/dev/null
cd - >/dev/null
cat > /etc/systemd/system/rtl_airband.service << 'EOS'
[Unit]
Description=RTLSDR-Airband (tower radio)
After=network-online.target icecast2.service

[Service]
ExecStart=/usr/local/bin/rtl_airband -F -e -c /usr/local/etc/rtl_airband.conf
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOS

echo "== 6. Icecast (the audio stream server) =="
X=/etc/icecast2/icecast.xml
rnd() { head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16; }
ICE_PASS=$(rnd)     # random, stays on the Pi; nothing outside the Pi needs it
sed -i -E "s#<source-password>[^<]*</source-password>#<source-password>$ICE_PASS</source-password>#; \
  s#<relay-password>[^<]*</relay-password>#<relay-password>$(rnd)</relay-password>#; \
  s#<admin-password>[^<]*</admin-password>#<admin-password>$(rnd)</admin-password>#; \
  s#<hostname>[^<]*</hostname>#<hostname>$(hostname -I | awk '{print $1}')</hostname>#; \
  s#<sources>[0-9]+</sources>#<sources>20</sources>#; \
  s#<burst-size>[0-9]+</burst-size>#<burst-size>8192</burst-size>#" $X     # small burst = ~2 s delay instead of ~30 s
sed -i 's/^ENABLE=.*/ENABLE=true/' /etc/default/icecast2 2>/dev/null || true
systemctl enable --now icecast2 >/dev/null 2>&1; systemctl restart icecast2

echo "== 7. Presets =="
P=/usr/local/etc/airband/presets
mkdir -p $P
echo "$GAIN" > /usr/local/etc/airband/gain
OUT="outputs: ( { type = \"icecast\"; server = \"127.0.0.1\"; port = 8000; mountpoint = \"radio.mp3\"; username = \"source\"; password = \"$ICE_PASS\"; name = \"Plane Radar tower radio\"; } );"
STATS='stats_filepath = "/run/rtl_airband_stats.txt";'
multi() {  # file, title, center, then "freq|label" pairs
  local f=$1 title=$2 center=$3; shift 3
  {
    echo "# $title"
    echo "$STATS"
    echo "mixers: { all: { $OUT }; };"
    echo "devices: ( { type = \"rtlsdr\"; serial = \"$AIR_SERIAL\"; gain = $GAIN; correction = 0;"
    echo "  centerfreq = $center; sample_rate = 2.4; mode = \"multichannel\";"
    echo "  channels: ("
    local first=1
    for pair in "$@"; do
      [ $first = 1 ] || echo "    ,"; first=0
      echo "    { freq = ${pair%%|*}; label = \"${pair#*|}\"; outputs: ( { type = \"mixer\"; name = \"all\"; balance = 0.0; } ); }"
    done
    echo "  );"
    echo "} );"
  } > $P/$f.conf
}
scan() {  # file, title, then "freq|label" pairs
  local f=$1 title=$2; shift 2
  local freqs="" labels=""
  for pair in "$@"; do freqs="$freqs${freqs:+, }${pair%%|*}"; labels="$labels${labels:+, }\"${pair#*|}\""; done
  {
    echo "# $title"
    echo "$STATS"
    echo "devices: ( { type = \"rtlsdr\"; serial = \"$AIR_SERIAL\"; gain = $GAIN; correction = 0; mode = \"scan\";"
    echo "  channels: ( { freqs = ( $freqs ); labels = ( $labels ); $OUT } );"
    echo "} );"
  } > $P/$f.conf
}
. ./presets.sh
ls $P

echo "== 8. Tuner service (port 8091) =="
install -m 755 planeradar-tuner.py /usr/local/bin/planeradar-tuner.py
cat > /etc/systemd/system/planeradar-tuner.service << 'EOS'
[Unit]
Description=Plane Radar tower radio tuner
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 /usr/local/bin/planeradar-tuner.py
Restart=always

[Install]
WantedBy=multi-user.target
EOS
rm -f /usr/local/etc/airband/current
systemctl daemon-reload
systemctl enable rtl_airband planeradar-tuner >/dev/null 2>&1
systemctl restart planeradar-tuner     # picks the first preset and starts the radio
sleep 15
echo "radio: $(systemctl is-active rtl_airband)  tuner: $(systemctl is-active planeradar-tuner)  planes: $(systemctl is-active readsb)"
curl -s -o /dev/null -m 3 -w "stream: %{http_code}\n" http://127.0.0.1:8000/radio.mp3 || true
echo "Listen at http://$(hostname -I | awk '{print $1}'):8000/radio.mp3"
echo TOWER-RADIO-DONE
