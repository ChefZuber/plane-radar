// Plane Radar - DeskThing server side (runs on the PC inside the DeskThing app).
// Every few seconds it asks the plane radar Pi (readsb + tar1090) for nearby
// aircraft and sends a trimmed list to the Car Thing screen.

import { DeskThing } from "@deskthing/server";
import { AppSettings, DESKTHING_EVENTS, SETTING_TYPES } from "@deskthing/types";
import http from "node:http";
import { spawn, ChildProcess } from "node:child_process";

const DEFAULT_PI = "YOUR_PI_IP";
const POLL_MS = 2000;

type Plane = {
  hex: string;
  callsign: string;
  reg: string;
  type: string;
  desc: string;
  lat: number;
  lon: number;
  alt: number | null; // feet, null when on the ground
  speed: number | null; // knots
  track: number | null; // degrees, 0 = north
  climb: number | null; // feet per minute
  squawk: string;
};

let piAddress = DEFAULT_PI;
let receiver: { lat: number; lon: number } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// "Today" stats, reset at local midnight
let statsDay = new Date().toDateString();
const seenToday = new Set<string>();
let highest: { alt: number; callsign: string } | null = null;
let fastest: { speed: number; callsign: string } | null = null;

const getJson = (path: string, port = 80): Promise<any> =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: piAddress, port, path, timeout: 4000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });

const sendStatus = (message: string) => {
  DeskThing.send({ type: "status", payload: { message } });
};

// ---------------- Tower radio (tuner on the Pi, port 8091) ----------------
// The Car Thing has no speaker, so "Play" plays the Pi's stream on this PC.
const TUNER_PORT = 8091;
const SIGHTINGS_PORT = 8092;
let player: ChildProcess | null = null;
let radioTimer: ReturnType<typeof setInterval> | null = null;

const ago = (sec: number) => {
  if (sec < 60) return "just now";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} hr ${m % 60} min ago`;
};

const streamUrl = () => `http://${piAddress}:8000/radio.mp3`;

let playerCheck: ReturnType<typeof setTimeout> | null = null;
const stopPlayer = () => {
  if (playerCheck) { clearTimeout(playerCheck); playerCheck = null; }
  const old = player;
  player = null;
  if (old && process.platform === "win32" && old.pid) {
    // end PowerShell and anything it started, so no hidden player keeps playing
    spawn("taskkill", ["/PID", String(old.pid), "/T", "/F"], { windowsHide: true });
  }
};

let playerNote = "";        // shown on the Car Thing if PC playback had to fall back

const openInBrowser = () => {
  const url = streamUrl();
  if (process.platform === "win32") spawn("cmd.exe", ["/c", "start", "", url], { windowsHide: true, detached: true });
  else if (process.platform === "darwin") spawn("open", [url]);
  else spawn("xdg-open", [url]);
};

const startPlayer = () => {
  stopPlayer();
  if (playerCheck) clearTimeout(playerCheck);
  playerNote = "";
  if (process.platform !== "win32") {          // Mac / Linux: hand the stream to the default app
    openInBrowser();
    playerNote = "Opened in your default player";
    sendRadio();
    return;
  }
  // Windows: the media player built into every Windows PC (WPF MediaPlayer), hidden.
  // It prints its play position every 2 s so we can tell it's really playing,
  // and reopens the stream if it gets stuck (e.g. after switching presets).
  const ps = [
    "Add-Type -AssemblyName PresentationCore",
    `$u = [uri]'${streamUrl()}'`,
    "$m = New-Object System.Windows.Media.MediaPlayer",
    "$m.Volume = 0.9",
    "$m.Open($u); $m.Play()",
    "$last = -1; $stuck = 0; $started = $false",
    "while ($true) {",
    "  Start-Sleep -Seconds 2",
    "  $pos = [math]::Round($m.Position.TotalSeconds, 1)",
    "  [Console]::Out.WriteLine('pos ' + $pos); [Console]::Out.Flush()",
    "  if ($pos -gt 0) { $started = $true }",
    // only treat it as stuck once it has played; the first start can take a while to buffer
    "  if ($started -and $pos -eq $last) { $stuck++ } else { $stuck = 0 }",
    "  if ($stuck -ge 4) { $m.Close(); $m.Open($u); $m.Play(); $stuck = 0; $started = $false }",
    "  $last = $pos",
    "}",
  ].join("; ");
  const mine = spawn("powershell.exe", ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true });
  player = mine;
  let confirmed = false;
  let errText = "";
  mine.stdout?.on("data", (d: Buffer) => {
    const m = /pos ([0-9.]+)/.exec(d.toString());
    if (m && parseFloat(m[1]) > 0 && !confirmed) { confirmed = true; playerNote = "Playing on this PC"; sendRadio(); }
  });
  mine.stderr?.on("data", (d: Buffer) => {
    errText += d.toString();
    if (!confirmed && /exception|error/i.test(errText)) { playerNote = "PC player error: " + errText.split("\n")[0].slice(0, 60); sendRadio(); }
  });
  mine.on("exit", () => { if (player === mine) { player = null; sendRadio(); } });
  mine.on("error", () => { if (player === mine) { player = null; sendRadio(); } });
  // The Windows player can take up to a minute to start on a quiet stream; show that on the Car Thing.
  playerNote = "Starting... can take up to a minute";
  sendRadio();
};

let lastRadio: any = null;
const sendRadio = () => {
  if (!lastRadio) return;
  const lh = lastRadio.last_heard;
  const now = lastRadio.now || Math.floor(Date.now() / 1000);
  DeskThing.send({
    type: "radio",
    payload: {
      presets: lastRadio.presets || [],
      preset: lastRadio.preset,
      title: lastRadio.title,
      lastHeard: lh ? `${lh.label} · ${ago(now - lh.ts)}` : "",
      lastHeardAge: lh ? now - lh.ts : null,
      playing: !!player,
      note: playerNote,
    },
  });
};

const pollRadio = async () => {
  try {
    lastRadio = await getJson("/status", TUNER_PORT);
    sendRadio();
  } catch {
    /* tuner not reachable; the Audio view keeps its last info */
  }
};

const tune = async (preset: string) => {
  try {
    await getJson(`/tune?preset=${encodeURIComponent(preset)}`, TUNER_PORT);
  } catch (e) {
    sendStatus(`Couldn't change the tower radio (${(e as Error).message})`);
  }
  await pollRadio();
  // The PC player notices the stream restart and reconnects on its own (no new player needed).
};

// ---------------- Sightings log (port 8092): "have we seen this plane before?" ----------------
const fmtDay = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const sendSighting = async (hex: string) => {
  // Two short lines for the Car Thing: what (first time / regular) and when.
  try {
    const r = await getJson(`/plane?hex=${encodeURIComponent(hex)}`, SIGHTINGS_PORT);
    let line1 = "First time seen";
    let line2 = "";
    if (!r.new && r.first_seen) {
      const isToday = (ts: number) => new Date(ts * 1000).toDateString() === new Date().toDateString();
      if (r.days <= 1 && isToday(r.first_seen)) line2 = `Today at ${fmtTime(r.first_seen)}`;
      else {
        line1 = `Seen on ${r.days} day${r.days === 1 ? "" : "s"}`;
        line2 = `First seen ${fmtDay(r.first_seen)} at ${fmtTime(r.first_seen)}`;
      }
      if (typeof r.closest_mi === "number") line2 += ` · closest ${r.closest_mi} mi`;
    }
    DeskThing.send({ type: "sighting", payload: { hex, line1, line2 } });
  } catch {
    DeskThing.send({ type: "sighting", payload: { hex, line1: "", line2: "" } });
  }
};


const poll = async () => {
  try {
    if (!receiver) {
      const rx = await getJson("/tar1090/data/receiver.json");
      if (typeof rx.lat === "number" && typeof rx.lon === "number") {
        receiver = { lat: rx.lat, lon: rx.lon };
      }
    }
    const data = await getJson("/tar1090/data/aircraft.json");

    const today = new Date().toDateString();
    if (today !== statsDay) {
      statsDay = today;
      seenToday.clear();
      highest = null;
      fastest = null;
    }

    const planes: Plane[] = [];
    let total = 0;
    for (const a of data.aircraft || []) {
      total++;
      if (a.hex) seenToday.add(a.hex);
      const callsign = String(a.flight || a.r || a.hex || "").trim().toUpperCase();
      if (typeof a.alt_baro === "number" && (!highest || a.alt_baro > highest.alt)) {
        highest = { alt: a.alt_baro, callsign };
      }
      if (typeof a.gs === "number" && (!fastest || a.gs > fastest.speed)) {
        fastest = { speed: Math.round(a.gs), callsign };
      }
      if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
      if ((a.seen_pos ?? 99) > 30) continue;
      planes.push({
        hex: a.hex || "",
        callsign,
        reg: a.r || "",
        type: a.t || "",
        desc: a.desc || "",
        lat: a.lat,
        lon: a.lon,
        alt: typeof a.alt_baro === "number" ? a.alt_baro : null,
        speed: typeof a.gs === "number" ? Math.round(a.gs) : null,
        track: typeof a.track === "number" ? a.track : null,
        climb: typeof a.baro_rate === "number" ? a.baro_rate : null,
        squawk: a.squawk || "",
      });
    }

    DeskThing.send({
      type: "planes",
      payload: {
        receiver,
        planes,
        total,
        time: Date.now(),
        // The Car Thing's own clock and number formatting are unreliable, so the PC sends local time.
        clock: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        stats: { seenToday: seenToday.size, highest, fastest },
      },
    });
  } catch (err) {
    sendStatus(`Can't reach the Pi at ${piAddress} (${(err as Error).message})`);
  }
};

const applySettings = (settings: AppSettings | null | undefined) => {
  const value = settings?.piAddress?.value;
  if (typeof value === "string" && value.trim() && value.trim() !== piAddress) {
    piAddress = value.trim();
    receiver = null;
    console.log(`Plane Radar: Pi address is now ${piAddress}`);
  }
};

const start = async () => {
  const settings: AppSettings = {
    piAddress: {
      id: "piAddress",
      label: "Plane radar Pi address",
      description: "IP address or name of the Raspberry Pi running readsb + tar1090",
      type: SETTING_TYPES.STRING,
      value: DEFAULT_PI,
    },
  };
  await DeskThing.initSettings(settings);
  applySettings(await DeskThing.getSettings());

  poll();
  timer = setInterval(poll, POLL_MS);
  pollRadio();
  radioTimer = setInterval(pollRadio, 5000);
  console.log("Plane Radar started");
};

const stop = async () => {
  if (timer) clearInterval(timer);
  if (radioTimer) clearInterval(radioTimer);
  timer = null;
  radioTimer = null;
  stopPlayer();
  console.log("Plane Radar stopped");
};

DeskThing.on(DESKTHING_EVENTS.SETTINGS, (data) => applySettings(data.payload as AppSettings));
DeskThing.on(DESKTHING_EVENTS.START, start);
// Messages from the Car Thing screen
DeskThing.on("tune" as any, (data: any) => { if (data?.payload?.preset) tune(String(data.payload.preset)); });
DeskThing.on("play" as any, () => { if (player) stopPlayer(); else startPlayer(); sendRadio(); });
DeskThing.on("sighting" as any, (data: any) => { if (data?.payload?.hex) sendSighting(String(data.payload.hex)); });
DeskThing.on(DESKTHING_EVENTS.STOP, stop);
