import React, { useEffect, useMemo, useRef, useState } from "react";
import { DeskThing } from "@deskthing/client";
import Radar from "./Radar";
import {
  PlanesPayload, PlaneView, withGeometry, lookHint, operator, fmtAlt, climbArrow, compass, altColor, commas,
} from "./planes";

type View = "list" | "map" | "audio" | "stats";
const VIEWS: { id: View; label: string }[] = [
  { id: "list", label: "List" },
  { id: "map", label: "Map" },
  { id: "audio", label: "Audio" },
  { id: "stats", label: "Stats" },
];
const RANGES = [5, 10, 25, 50, 100];

type Radio = {
  presets: { id: string; title: string }[]; preset: string; title: string;
  lastHeard: string; lastHeardAge: number | null; playing: boolean; note?: string;
};
type Seen = { line1: string; line2: string };
const toServer = (type: string, payload: any) => (DeskThing as any).send({ type, payload });

const App: React.FC = () => {
  const [data, setData] = useState<PlanesPayload | null>(null);
  const [status, setStatus] = useState("Waiting for the plane radar Pi…");
  const [view, setView] = useState<View>("list");
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [radio, setRadio] = useState<Radio | null>(null);
  const [presetIdx, setPresetIdx] = useState(0);        // highlighted row in the Audio view
  const [sightings, setSightings] = useState<Record<string, Seen>>({});

  // data from the DeskThing server (PC side)
  useEffect(() => {
    const offPlanes = DeskThing.on("planes" as any, (msg: any) => {
      if (msg?.payload) { setData(msg.payload as PlanesPayload); setStatus(""); }
    });
    const offStatus = DeskThing.on("status" as any, (msg: any) => {
      if (msg?.payload?.message) setStatus(msg.payload.message);
    });
    const offRadio = DeskThing.on("radio" as any, (msg: any) => {
      if (msg?.payload) setRadio(msg.payload as Radio);
    });
    const offSighting = DeskThing.on("sighting" as any, (msg: any) => {
      const p = msg?.payload;
      if (p?.hex) setSightings((old) => ({ ...old, [p.hex]: { line1: p.line1 || "", line2: p.line2 || "" } }));
    });
    return () => { offPlanes(); offStatus(); offRadio(); offSighting(); };
  }, []);

  const planes: PlaneView[] = useMemo(
    () => (data?.receiver ? withGeometry(data.planes, data.receiver) : []),
    [data],
  );

  // keep a valid selection: default to the closest plane
  const selIndex = Math.max(0, planes.findIndex((p) => p.hex === selectedHex));
  const selected = planes[selIndex] || null;
  useEffect(() => {
    if (planes.length && !planes.some((p) => p.hex === selectedHex)) setSelectedHex(planes[0].hex);
  }, [planes, selectedHex]);

  // "have we seen this plane before?" for the selected plane (asked once a minute at most)
  const askedAt = useRef<Record<string, number>>({});
  useEffect(() => {
    const hex = selected?.hex;
    if (!hex) return;
    const now = Date.now();
    if (now - (askedAt.current[hex] || 0) < 60000) return;
    askedAt.current[hex] = now;
    toServer("sighting", { hex });
  }, [selected?.hex]);

  // knob + the four top buttons
  const stateRef = useRef({ planes, selIndex, view, radio, presetIdx });
  stateRef.current = { planes, selIndex, view, radio, presetIdx };
  useEffect(() => {
    DeskThing.overrideKeys(["wheel", "Enter", "Digit1", "Digit2", "Digit3", "Digit4"]);
    const move = (dir: number) => {
      const { planes, selIndex, view, radio, presetIdx } = stateRef.current;
      if (view === "audio") {                       // in the Audio view the knob picks a preset
        const n = radio?.presets.length || 0;
        if (n) setPresetIdx(Math.min(n - 1, Math.max(0, presetIdx + dir)));
        return;
      }
      if (!planes.length) return;
      const next = Math.min(planes.length - 1, Math.max(0, selIndex + dir));
      setSelectedHex(planes[next].hex);
    };
    const onWheel = (e: WheelEvent) => {
      const d = e.deltaY || e.deltaX;
      if (d) move(d > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Digit1") setView("list");
      else if (e.code === "Digit2") setView("map");
      else if (e.code === "Digit3") setView("audio");
      else if (e.code === "Digit4") setView("stats");
      else if (e.code === "Enter") {
        const { view, radio, presetIdx } = stateRef.current;
        if (view === "audio") {                     // press the knob to tune to the highlighted preset
          const p = radio?.presets[presetIdx];
          if (p) toServer("tune", { preset: p.id });
        } else setView(view === "map" ? "list" : "map");
      }
    };
    window.addEventListener("wheel", onWheel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      DeskThing.restoreKeys(["wheel", "Enter", "Digit1", "Digit2", "Digit3", "Digit4"]);
    };
  }, []);

  // keep the highlighted row visible in the list
  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-hex="${selected?.hex}"]`) as HTMLElement | null;
    row?.scrollIntoView({ block: "nearest" });
  }, [selected?.hex, view]);

  useEffect(() => {
    if (view === "audio" && radio) {
      const i = radio.presets.findIndex((p) => p.id === radio.preset);
      if (i >= 0) setPresetIdx(i);
    }
  }, [view]);   // eslint-disable-line react-hooks/exhaustive-deps

  const time = data?.clock || "";
  const mapRange = selected ? RANGES.find((r) => r >= Math.max(selected.distMi * 1.15, 10)) || 100 : 10;

  return (
    <div className="app">
      <header className="top">
        <span>NEARBY · {planes.length}</span>
        <nav className="tabs">
          {VIEWS.map((v, i) => (
            <button key={v.id} className={view === v.id ? "tab on" : "tab"} onClick={() => setView(v.id)}>
              <span className="num">{i + 1}</span> {v.label}
            </button>
          ))}
        </nav>
        <span>{time}</span>
      </header>

      {status && !data && <div className="status">{status}</div>}
      {status && data && <div className="banner">{status}</div>}

      {data && view === "list" && (
        <main className="body">
          <div className="list" ref={listRef}>
            {planes.length === 0 && <div className="empty">No planes with positions yet</div>}
            {planes.map((p) => (
              <div
                key={p.hex}
                data-hex={p.hex}
                className={p.hex === selected?.hex ? "row on" : "row"}
                onClick={() => setSelectedHex(p.hex)}
              >
                <span className="dot" style={{ background: altColor(p.alt) }} />
                <span className="cs">{p.callsign}</span>
                <span className="dist">{p.distMi.toFixed(1)}mi</span>
              </div>
            ))}
          </div>
          <Detail plane={selected} seen={selected ? sightings[selected.hex] : undefined} />
        </main>
      )}

      {data && view === "map" && (
        <main className="body map">
          <Radar planes={planes} selectedHex={selected?.hex ?? null} rangeMi={mapRange} size={380} />
          <Detail plane={selected} compact seen={selected ? sightings[selected.hex] : undefined} />
        </main>
      )}

      {data && view === "audio" && (
        <main className="body">
          {!radio && <div className="status">Waiting for the tower radio on the Pi…</div>}
          {radio && (
            <>
              <div className="list">
                {radio.presets.map((p, i) => (
                  <div
                    key={p.id}
                    className={"row" + (i === presetIdx ? " on" : "") + (p.id === radio.preset ? " tuned" : "")}
                    onClick={() => { setPresetIdx(i); toServer("tune", { preset: p.id }); }}
                  >
                    <span className="dot" style={{ background: p.id === radio.preset ? "#E24B4A" : "#0F6E56" }} />
                    <span className="cs">{p.title}</span>
                  </div>
                ))}
              </div>
              <div className="detail">
                <label className="muted small">NOW LISTENING TO</label>
                <div className="callsign radio-title">{radio.title || "—"}</div>
                <div className="sub">Last heard: {radio.lastHeard || "nothing yet on this preset"}</div>
                <button className={radio.playing ? "playbtn on" : "playbtn"} onClick={() => toServer("play", {})}>
                  {radio.playing ? "■  Stop on PC" : "▶  Play on PC"}
                </button>
                {radio.note && <div className="muted small">{radio.note}</div>}
                <Visualizer active={radio.lastHeardAge !== null && radio.lastHeardAge <= 20} />
              </div>
            </>
          )}
        </main>
      )}

      {data && view === "stats" && (
        <main className="body center">
          <div className="statgrid">
            <Stat label="Seen today" value={`${data.stats.seenToday}`} />
            <Stat label="Tracked right now" value={`${planes.length} / ${data.total}`} />
            <Stat
              label="Highest today"
              value={data.stats.highest ? `${commas(data.stats.highest.alt)} ft` : "—"}
              sub={data.stats.highest?.callsign}
            />
            <Stat
              label="Fastest today"
              value={data.stats.fastest ? `${data.stats.fastest.speed} kt` : "—"}
              sub={data.stats.fastest?.callsign}
            />
          </div>
        </main>
      )}

      <footer className="bottom">
        <span className="tower">
          <b>TOWER</b>{radio ? `${radio.playing ? "▶ " : ""}${radio.lastHeard || radio.title}` : "—"}
        </span>
        <span>
          <b>TODAY</b> {data ? `${data.stats.seenToday} seen` : "—"}
          {data?.stats.highest ? ` · max ${commas(data.stats.highest.alt)}ft` : ""}
        </span>
      </footer>
    </div>
  );
};

const Detail: React.FC<{ plane: PlaneView | null; compact?: boolean; seen?: Seen }> = ({ plane, compact, seen }) => {
  if (!plane) return <div className="detail muted">No plane selected</div>;
  const op = operator(plane);
  const kind = plane.desc || plane.type;
  return (
    <div className={compact ? "detail compact" : "detail"}>
      <div className="callsign">{plane.callsign}</div>
      <div className="sub">{[op, kind].filter(Boolean).join(" · ") || plane.reg || "Unknown aircraft"}</div>
      <div className="grid">
        <div><label>ALT</label><span>{fmtAlt(plane.alt)}{climbArrow(plane.climb)}</span></div>
        <div><label>SPEED</label><span>{plane.speed !== null ? `${plane.speed} kt` : "—"}</span></div>
        <div><label>HEADING</label><span>{plane.track !== null ? `${Math.round(plane.track)}° ${compass(plane.track)}` : "—"}</span></div>
        <div><label>DISTANCE</label><span>{plane.distMi.toFixed(1)} mi {compass(plane.bearing)}</span></div>
      </div>
      <div className="look">{lookHint(plane)}</div>
      {seen && seen.line1 && (
        <div className="seen">
          <div className="seen1">{seen.line1}</div>
          {seen.line2 && <div className="seen2">{seen.line2}</div>}
        </div>
      )}
      {plane.reg && !compact && <div className="muted small">Registration {plane.reg}{plane.squawk ? ` · Squawk ${plane.squawk}` : ""}</div>}
    </div>
  );
};

// Radio activity visualizer. The Car Thing can't hear the audio itself, so the bars come alive
// when the Pi reports a transmission in the last ~20 seconds and settle to a quiet idle otherwise.
const BARS = 28;
const Visualizer: React.FC<{ active: boolean }> = ({ active }) => (
  <div className={active ? "viz live" : "viz"}>
    {Array.from({ length: BARS }).map((_, i) => (
      <span
        key={i}
        style={{
          animationDelay: `${((i * 37) % 23) / 23}s`,
          animationDuration: `${0.55 + ((i * 53) % 17) / 30}s`,
        }}
      />
    ))}
    <div className="vizlabel">{active ? "TRANSMISSION" : "LISTENING"}</div>
  </div>
);

const Stat: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="stat">
    <label>{label}</label>
    <div className="value">{value}</div>
    {sub && <div className="muted small">{sub}</div>}
  </div>
);

export default App;
