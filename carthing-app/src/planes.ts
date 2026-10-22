// Shared plane types and math for the Car Thing screen.

export type Plane = {
  hex: string;
  callsign: string;
  reg: string;
  type: string;
  desc: string;
  lat: number;
  lon: number;
  alt: number | null;
  speed: number | null;
  track: number | null;
  climb: number | null;
  squawk: string;
};

export type Stats = {
  seenToday: number;
  highest: { alt: number; callsign: string } | null;
  fastest: { speed: number; callsign: string } | null;
};

export type PlanesPayload = {
  receiver: { lat: number; lon: number } | null;
  planes: Plane[];
  total: number;
  time: number;
  stats: Stats;
  clock?: string;
};

export type PlaneView = Plane & {
  distMi: number;
  bearing: number; // degrees from your house to the plane, 0 = north
  east: number; // miles
  north: number; // miles
};

const MI_PER_DEG_LAT = 69.05;

export const withGeometry = (planes: Plane[], rx: { lat: number; lon: number }): PlaneView[] =>
  planes
    .map((p) => {
      const north = (p.lat - rx.lat) * MI_PER_DEG_LAT;
      const east = (p.lon - rx.lon) * MI_PER_DEG_LAT * Math.cos((rx.lat * Math.PI) / 180);
      const distMi = Math.sqrt(east * east + north * north);
      const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
      return { ...p, distMi, bearing, east, north };
    })
    .sort((a, b) => a.distMi - b.distMi);

const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compass = (deg: number) => DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

// Where to look out the window: compass direction + how high in the sky.
export const lookHint = (p: PlaneView) => {
  if (p.alt === null) return `Look ${compass(p.bearing)}, on the ground`;
  const altMi = p.alt / 5280;
  const elev = (Math.atan2(altMi, Math.max(p.distMi, 0.05)) * 180) / Math.PI;
  const height = elev < 10 ? "low on the horizon" : elev < 35 ? "partway up" : elev < 65 ? "high up" : "almost overhead";
  return `Look ${compass(p.bearing)}, ${height}`;
};

// Common airline callsign prefixes (ICAO codes).
const AIRLINES: Record<string, string> = {
  AAL: "American",
  DAL: "Delta",
  UAL: "United",
  SWA: "Southwest",
  JBU: "JetBlue",
  MXY: "Breeze",
  ENY: "Envoy (American Eagle)",
  JIA: "PSA (American Eagle)",
  PDT: "Piedmont (American Eagle)",
  RPA: "Republic",
  SKW: "SkyWest",
  EDV: "Endeavor (Delta Connection)",
  ASH: "Mesa",
  GJS: "GoJet",
  FFT: "Frontier",
  NKS: "Spirit",
  AAY: "Allegiant",
  ASA: "Alaska",
  FDX: "FedEx",
  UPS: "UPS",
  EJA: "NetJets",
  LXJ: "Flexjet",
  ACA: "Air Canada",
  BAW: "British Airways",
  DLH: "Lufthansa",
  AFR: "Air France",
};

export const operator = (p: Plane) => {
  const m = /^([A-Z]{3})\d/.exec(p.callsign);
  if (m && AIRLINES[m[1]]) return AIRLINES[m[1]];
  if (/^N\d/.test(p.callsign) || /^N\d/.test(p.reg)) return "Private / general aviation";
  return "";
};

// Adds thousands commas without relying on the browser's locale support.
export const commas = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export const fmtAlt = (alt: number | null) => (alt === null ? "Ground" : `${commas(alt)} ft`);

export const climbArrow = (climb: number | null) =>
  climb === null || Math.abs(climb) < 250 ? "" : climb > 0 ? " ▲" : " ▼";

// Altitude colour, matching the round display's palette
export const altColor = (alt: number | null) => {
  if (alt === null) return "#888780";
  if (alt < 5000) return "#EF9F27";
  if (alt < 15000) return "#97C459";
  if (alt < 30000) return "#5DCAA5";
  return "#AFA9EC";
};
