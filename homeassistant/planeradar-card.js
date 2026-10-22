// Plane Radar card for Home Assistant
// Change YOUR_PI_IP below (map_url) and the AIRPORTS list to your own.
// Shows live planes from the plane radar Pi (readsb + tar1090) as a radar sweep
// plus a list of the closest planes. Click a plane in the list to highlight it.
//
// Card config (all optional):
//   type: custom:planeradar-card
//   entity: sensor.plane_radar_data   # sensor that HA fills from the plane radar Pi
//   range: 25                      # starting zoom in miles (5, 10, 25, 50, 100)
//   rows: 7                        # how many planes to list
//   height: calc(100vh - 110px)    # card height (any CSS size)
//   map_url: http://YOUR_PI_IP/tar1090/   # "Full map" link in the header

const RANGES = [5, 10, 25, 50, 100];
const MI_PER_DEG = 69.05;
const AIRPORTS = [
  { id: "GSP", lat: 34.8957, lon: -82.2189 },
  { id: "SPA", lat: 34.9157, lon: -81.9565 },
];
const AIRLINES = {
  AAL: "American", DAL: "Delta", UAL: "United", SWA: "Southwest", JBU: "JetBlue", MXY: "Breeze",
  ENY: "American Eagle", JIA: "American Eagle", PDT: "American Eagle", RPA: "Republic", SKW: "SkyWest",
  EDV: "Delta Connection", ASH: "Mesa", GJS: "GoJet", FFT: "Frontier", NKS: "Spirit", AAY: "Allegiant",
  ASA: "Alaska", FDX: "FedEx", UPS: "UPS", EJA: "NetJets", LXJ: "Flexjet", ACA: "Air Canada",
};
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (d) => DIRS[Math.round((((d % 360) + 360) % 360) / 45) % 8];
const commas = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const altColor = (alt) =>
  alt === null ? "#888780" : alt < 5000 ? "#EF9F27" : alt < 15000 ? "#97C459" : alt < 30000 ? "#5DCAA5" : "#AFA9EC";

class PlaneRadarCard extends HTMLElement {
  setConfig(config) {
    this._cfg = { entity: "sensor.plane_radar_data", range: 25, rows: 8, height: "calc(100vh - 110px)", map_url: "http://YOUR_PI_IP/tar1090/", ...config };
    this._range = RANGES.includes(this._cfg.range) ? this._cfg.range : 25;
    this._selected = null;
    this._planes = [];
    this._rx = null;
    this._error = "";
    this._sweep = 0;
  }

  set hass(hass) {
    const old = this._hass && this._hass.states[this._cfg.entity];
    this._hass = hass;
    if (!this._built) this._build();
    if (hass.states[this._cfg.entity] !== old) this._poll();
  }

  getCardSize() { return 9; }
  getGridOptions() { return { columns: 12, rows: 8, min_columns: 6, min_rows: 6 }; }
  static getStubConfig() { return { entity: "sensor.plane_radar_data" }; }

  connectedCallback() {
    if (!this._built) this._build();
    this._poll();
    const frame = () => { this._draw(); this._raf = requestAnimationFrame(frame); };
    this._raf = requestAnimationFrame(frame);
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
  }

  _build() {
    this._built = true;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        ha-card { background: #04342C; color: #E1F5EE; overflow: hidden; min-height: 380px;
          font-family: "DejaVu Sans Mono", Menlo, Consolas, monospace; display: flex; flex-direction: column; }
        .top { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px;
          border-bottom: 1px solid #0F6E56; color: #5DCAA5; font-size: 15px; }
        .ranges button { background: none; border: 1px solid #0F6E56; color: #5DCAA5; border-radius: 6px;
          font: inherit; font-size: 12px; padding: 3px 7px; margin-left: 3px; cursor: pointer; }
        .maplink { color: #FAC775; text-decoration: none; font-size: 12px; margin-left: 10px; border: 1px solid #EF9F27;
          border-radius: 6px; padding: 3px 7px; }
        .ranges button.on { background: #085041; color: #FAC775; border-color: #EF9F27; }
        .body { flex: 1; display: flex; gap: 10px; padding: 10px; min-height: 0; }
        .scope { flex: 1.7; min-width: 0; display: flex; align-items: center; justify-content: center; }
        canvas { width: 100%; height: 100%; display: block; }
        .side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
        .list { flex: 1; overflow: hidden; }
        .row { display: flex; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 6px;
          cursor: pointer; color: #9FE1CB; font-size: 14px; }
        .row.on { background: #085041; color: #FAC775; outline: 1px solid #EF9F27; }
        .row .cs { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .row .d { color: #5DCAA5; font-size: 12px; }
        .dot { width: 8px; height: 8px; border-radius: 4px; flex-shrink: 0; }
        .detail { border-top: 1px solid #0F6E56; padding-top: 8px; font-size: 13px; color: #9FE1CB; line-height: 1.5; }
        .detail .cs { color: #FAC775; font-size: 20px; font-weight: bold; }
        .detail .look { color: #EF9F27; }
        .msg { color: #F0997B; padding: 12px; font-size: 14px; }
      </style>
      <ha-card>
        <div class="top"><span class="count">PLANE RADAR</span><span><span class="ranges"></span><a class="maplink" target="_blank" rel="noopener">Full map ↗</a></span></div>
        <div class="body">
          <div class="scope"><canvas></canvas></div>
          <div class="side"><div class="list"></div><div class="detail"></div></div>
        </div>
      </ha-card>`;
    root.querySelector("ha-card").style.height = this._cfg.height;
    root.querySelector(".maplink").href = this._cfg.map_url;
    this._canvas = root.querySelector("canvas");
    this._listEl = root.querySelector(".list");
    this._detailEl = root.querySelector(".detail");
    this._countEl = root.querySelector(".count");
    const rangesEl = root.querySelector(".ranges");
    RANGES.forEach((r) => {
      const b = document.createElement("button");
      b.textContent = `${r}mi`;
      b.onclick = () => { this._range = r; this._renderRanges(); };
      rangesEl.appendChild(b);
    });
    this._rangesEl = rangesEl;
    this._renderRanges();
    this._listEl.addEventListener("click", (e) => {
      const row = e.target.closest(".row");
      if (row) { this._selected = row.dataset.hex; this._renderSide(); }
    });
  }

  _renderRanges() {
    [...this._rangesEl.children].forEach((b, i) => b.classList.toggle("on", RANGES[i] === this._range));
  }

  // Reads the plane list from the sensor.plane_radar_data entity (HA fetches it from the Pi).
  _poll() {
    const st = this._hass && this._hass.states[this._cfg.entity];
    if (!st || !st.attributes.planes) {
      this._error = st && st.attributes.error ? "Pi not answering: " + st.attributes.error : `Waiting for ${this._cfg.entity}…`;
      this._planes = [];
    } else {
      this._error = "";
      const a = st.attributes;
      this._rx = a.rx ? { lat: a.rx[0], lon: a.rx[1] } : null;
      this._planes = a.planes.map((p) => ({
        hex: p.hex, cs: p.cs, reg: p.reg, desc: p.desc, alt: p.alt, gs: p.gs, track: p.trk,
        north: p.n, east: p.e, dist: p.d, bearing: p.brg,
      }));
      if (!this._planes.some((p) => p.hex === this._selected)) this._selected = this._planes[0]?.hex || null;
    }
    this._renderSide();
  }

  _renderSide() {
    if (!this._listEl) return;
    this._countEl.textContent = `PLANE RADAR · ${this._planes.length} nearby`;
    if (this._error) {
      this._listEl.innerHTML = `<div class="msg">${this._error}</div>`;
      this._detailEl.innerHTML = "";
      return;
    }
    this._listEl.innerHTML = this._planes
      .slice(0, this._cfg.rows)
      .map((p) => `<div class="row ${p.hex === this._selected ? "on" : ""}" data-hex="${p.hex}">
          <span class="dot" style="background:${altColor(p.alt)}"></span>
          <span class="cs">${p.cs}</span><span class="d">${p.dist.toFixed(1)}mi</span></div>`)
      .join("");
    const p = this._planes.find((x) => x.hex === this._selected);
    if (!p) { this._detailEl.innerHTML = `<span>No planes with positions yet</span>`; return; }
    const m = /^([A-Z]{3})\d/.exec(p.cs);
    const op = m && AIRLINES[m[1]] ? AIRLINES[m[1]] : /^N\d/.test(p.cs) || /^N\d/.test(p.reg) ? "Private" : "";
    const elev = p.alt === null ? null : (Math.atan2(p.alt / 5280, Math.max(p.dist, 0.05)) * 180) / Math.PI;
    const height = elev === null ? "on the ground" : elev < 10 ? "low on the horizon" : elev < 35 ? "partway up" : elev < 65 ? "high up" : "almost overhead";
    this._detailEl.innerHTML = `
      <div class="cs">${p.cs}</div>
      <div>${[op, p.desc].filter(Boolean).join(" · ") || p.reg || "Unknown aircraft"}</div>
      <div>${p.alt === null ? "Ground" : commas(p.alt) + " ft"} · ${p.gs ?? "—"} kt · ${p.track !== null ? compass(p.track) : "—"}</div>
      <div class="look">Look ${compass(p.bearing)}, ${height}</div>`;
  }

  _draw() {
    const c = this._canvas;
    if (!c) return;
    const rect = c.parentElement.getBoundingClientRect();
    const size = Math.max(120, Math.floor(Math.min(rect.width, rect.height)));
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== size * dpr) {
      c.width = c.height = size * dpr;
      c.style.width = c.style.height = size + "px";
    }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = size / 2 - 4, cx = size / 2, cy = size / 2;
    const scale = R / this._range;

    g.clearRect(0, 0, size, size);
    g.fillStyle = "#03251F";
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();

    // range rings + labels
    g.strokeStyle = "#0F6E56"; g.lineWidth = 1;
    g.fillStyle = "#1D9E75"; g.font = "11px monospace";
    [0.25, 0.5, 0.75, 1].forEach((f) => {
      g.beginPath(); g.arc(cx, cy, R * f, 0, Math.PI * 2); g.stroke();
      if (f < 1) g.fillText(`${Math.round(this._range * f * 10) / 10}`, cx + 3, cy - R * f - 2);
    });
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    g.fillStyle = "#5DCAA5"; g.font = "bold 12px monospace"; g.textAlign = "center";
    g.fillText("N", cx, cy - R + 14);

    // sweep
    this._sweep = (this._sweep + 0.02) % (Math.PI * 2);
    const sw = g.createConicGradient ? g.createConicGradient(this._sweep - Math.PI / 2 - 0.6, cx, cy) : null;
    if (sw) {
      sw.addColorStop(0, "rgba(93,202,165,0)");
      sw.addColorStop(0.095, "rgba(93,202,165,0.28)");
      sw.addColorStop(0.0955, "rgba(93,202,165,0)");
      g.fillStyle = sw;
      g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    }

    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();

    // Label collision boxes: every label checks these first, so names never sit on top of each other.
    const taken = [];
    const inCircle = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= (R - 3) ** 2;
    const free = (b) => inCircle(b.x, b.y) && inCircle(b.x + b.w, b.y) && inCircle(b.x, b.y + b.h) && inCircle(b.x + b.w, b.y + b.h) &&
      !taken.some((t) => b.x < t.x + t.w && t.x < b.x + b.w && b.y < t.y + t.h && t.y < b.y + b.h);
    const take = (x, y, w, h) => { const b = { x, y, w, h }; taken.push(b); return b; };
    // Try right, left, above, below; if all are blocked the label waits until there's room.
    const placeLabel = (text, x, y, font, gap) => {
      g.font = font;
      const w = g.measureText(text).width + 2, h = 11;
      const spots = [[x + gap, y - h / 2], [x - gap - w, y - h / 2], [x - w / 2, y - gap - h], [x - w / 2, y + gap]];
      for (const [lx, ly] of spots) {
        const b = { x: lx, y: ly, w, h };
        if (free(b)) { taken.push(b); return b; }
      }
      return null;
    };
    // Arrow pointing where the plane is heading (a diamond if heading is unknown)
    const arrow = (x, y, track, size, col, outline) => {
      g.save(); g.translate(x, y);
      g.beginPath();
      if (track === null) {
        g.moveTo(0, -size * 0.7); g.lineTo(size * 0.7, 0); g.lineTo(0, size * 0.7); g.lineTo(-size * 0.7, 0);
      } else {
        g.rotate((track * Math.PI) / 180);
        g.moveTo(0, -size); g.lineTo(size * 0.62, size * 0.75); g.lineTo(0, size * 0.35); g.lineTo(-size * 0.62, size * 0.75);
      }
      g.closePath();
      g.fillStyle = col; g.fill();
      if (outline) { g.strokeStyle = outline; g.lineWidth = 1; g.stroke(); }
      g.restore();
    };

    take(cx - 4, cy - 4, 8, 8);                     // home dot
    take(cx - 8, cy - R + 2, 16, 15);               // "N"
    [0.25, 0.5, 0.75].forEach((f) => take(cx + 2, cy - R * f - 13, 30, 12));   // ring mile labels

    // airports
    if (this._rx) {
      g.textAlign = "left"; g.textBaseline = "top";
      AIRPORTS.forEach((a) => {
        const x = cx + (a.lon - this._rx.lon) * MI_PER_DEG * Math.cos((this._rx.lat * Math.PI) / 180) * scale;
        const y = cy - (a.lat - this._rx.lat) * MI_PER_DEG * scale;
        g.strokeStyle = "#5DCAA5"; g.lineWidth = 1; g.strokeRect(x - 3, y - 3, 6, 6);
        take(x - 4, y - 4, 8, 8);
        const b = placeLabel(a.id, x, y, "10px monospace", 6);
        if (b) { g.fillStyle = "#5DCAA5"; g.fillText(a.id, b.x + 1, b.y + 1); }
      });
    }

    // planes: arrows first (they take their space), then names. Selected plane and closest planes get names first.
    const shown = this._planes.filter((p) => p.dist <= this._range * 1.05)
      .map((p) => ({ p, x: cx + p.east * scale, y: cy - p.north * scale, sel: p.hex === this._selected }));
    const big = Math.max(5, Math.min(9, size / 60));
    shown.forEach((s) => take(s.x - big, s.y - big, big * 2, big * 2));
    shown.filter((s) => !s.sel).forEach((s) => arrow(s.x, s.y, s.p.track, big, altColor(s.p.alt), "#03251F"));
    const sel = shown.find((s) => s.sel);
    if (sel) {
      g.strokeStyle = "#EF9F27"; g.lineWidth = 1.5;
      g.beginPath(); g.arc(sel.x, sel.y, big + 6, 0, Math.PI * 2); g.stroke();
      arrow(sel.x, sel.y, sel.p.track, big * 1.35, "#FAC775", "#03251F");
    }
    g.textAlign = "left"; g.textBaseline = "top";
    [...(sel ? [sel] : []), ...shown.filter((s) => !s.sel).sort((a, b) => a.p.dist - b.p.dist)].forEach((s) => {
      const font = s.sel ? "bold 12px monospace" : "10px monospace";
      const b = placeLabel(s.p.cs, s.x, s.y, font, s.sel ? big + 9 : big + 3);
      if (!b) return;
      g.fillStyle = s.sel ? "#FAC775" : "#CFEDE2";
      g.fillText(s.p.cs, b.x + 1, b.y + (s.sel ? 0 : 1));
    });
    g.textBaseline = "alphabetic";
    g.restore();

    // home
    g.fillStyle = "#E1F5EE";
    g.beginPath(); g.arc(cx, cy, 3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#1D9E75"; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();

    if (this._error) {
      g.fillStyle = "#F0997B"; g.font = "13px monospace"; g.textAlign = "center";
      g.fillText("No data from Pi", cx, cy + 24);
    }
  }
}

customElements.define("planeradar-card", PlaneRadarCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "planeradar-card",
  name: "Plane Radar",
  description: "Live planes from your plane radar Pi, drawn as a radar sweep.",
});
