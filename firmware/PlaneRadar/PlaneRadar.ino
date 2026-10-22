/*
 * PlaneRadar - round radar screen for the Elecrow CrowPanel 2.1" rotary display
 *
 * Shows planes from your own ADS-B receiver (the "planeradar" Raspberry Pi
 * running readsb + tar1090) on a sweeping radar scope.
 *
 *   Turn the knob      -> zoom (5 / 10 / 25 / 50 / 100 miles)
 *   Click the knob     -> highlight the next plane (closest first)
 *   Double-click knob  -> swap red/blue if the colors look wrong
 *
 * First boot: join the WiFi network "PlaneRadar-Setup" from your phone and
 * pick your home WiFi. The Pi address can be changed on that same page.
 *
 * Board setup is taken from Elecrow's official examples for this display
 * (ST7701 panel over RGB, PCF8574 expander for power/reset, knob on 42/4).
 */

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <Arduino_GFX_Library.h>
#include <PCF8574.h>
#include <math.h>


// ------------------------------------------------------------------
// Settings you might want to change
// ------------------------------------------------------------------
#define WIFI_BOOT_WAIT_MS 120000UL  // how long to keep trying the saved WiFi at power-up (2 minutes)
#define DEFAULT_PI_ADDRESS "YOUR_PI_IP"   // the plane radar Pi
#define FETCH_EVERY_MS     2000                // how often to ask the Pi for planes
#define SWEEP_SECONDS      4.0f                // time for one full radar sweep
#define BACKLIGHT_LEVEL    204                 // 0-255

// Nearby airports drawn on the scope (approximate coordinates).
struct Airport { const char *code; float lat; float lon; };
static const Airport AIRPORTS[] = {
  {"GSP", 34.8957f, -82.2189f},   // Greenville-Spartanburg International
  {"SPA", 34.9157f, -81.9565f},   // Spartanburg Downtown Memorial
};

// Zoom levels, in statute miles (radius of the outer ring).
static const float RANGES_MI[] = {5, 10, 25, 50, 100};
static const int   NUM_RANGES = sizeof(RANGES_MI) / sizeof(RANGES_MI[0]);

// ------------------------------------------------------------------
// Hardware (from Elecrow's Board21.h for this exact display)
// ------------------------------------------------------------------
static const int I2C_SDA_PIN = 38;
static const int I2C_SCL_PIN = 39;
static const int BACKLIGHT_PIN = 6;
static const int ONBOARD_LED_PIN = 43;
static const int ENCODER_A_PIN = 42;
static const int ENCODER_B_PIN = 4;
static const int W = 480, H = 480, CX = 240, CY = 240;
static const int SCOPE_R = 226;          // radius of the outer range ring

PCF8574 pcf(0x21);   // P0 touch reset, P2 touch int, P3 lcd power, P4 lcd reset, P5 knob button

Arduino_DataBus *panelBus = new Arduino_SWSPI(GFX_NOT_DEFINED, 16, 2, 1, GFX_NOT_DEFINED);
Arduino_ESP32RGBPanel *rgbPanel = new Arduino_ESP32RGBPanel(
  40, 7, 15, 41,
  46, 3, 8, 18, 17,
  14, 13, 12, 11, 10, 9,
  5, 45, 48, 47, 21,
  1, 10, 4, 20,
  1, 10, 4, 20,
  0, 12000000, false, 0, 0, 480 * 20);
Arduino_RGB_Display *screen = new Arduino_RGB_Display(
  W, H, rgbPanel, 0, true, panelBus, GFX_NOT_DEFINED,
  st7701_type5_init_operations, sizeof(st7701_type5_init_operations));

// Everything is drawn here first, then copied to the screen in one go (no flicker).
Arduino_Canvas *gfx = new Arduino_Canvas(W, H, screen);

// ------------------------------------------------------------------
// Plane data (filled by a background task, read by the drawing loop)
// ------------------------------------------------------------------
struct Plane {
  char  callsign[10];
  char  type[6];
  float lat, lon;
  int   alt;        // feet
  int   speed;      // knots
  float track;      // degrees, 0 = north
  int   climb;      // feet per minute (+ up, - down)
  char  hex[8];
};

// 37000 -> "37,000"
namespace fmt { void withCommas(int n, char *out, size_t len) {
  char raw[16];
  snprintf(raw, sizeof(raw), "%d", n < 0 ? -n : n);
  int digits = strlen(raw), o = 0;
  if (n < 0 && o < (int)len - 1) out[o++] = '-';
  for (int i = 0; i < digits && o < (int)len - 1; i++) {
    out[o++] = raw[i];
    int left = digits - i - 1;
    if (left > 0 && left % 3 == 0 && o < (int)len - 1) out[o++] = ',';
  }
  out[o] = 0;
}
}

static const int MAX_PLANES = 80;
static Plane planes[MAX_PLANES];
static int numPlanes = 0;
static int totalSeen = 0;
static float rxLat = NAN, rxLon = NAN;
static uint32_t lastGoodFetch = 0;
static char statusMsg[48] = "Starting up";
static SemaphoreHandle_t dataLock;

static char piAddress[40] = DEFAULT_PI_ADDRESS;
static Preferences prefs;

// UI state
static int rangeIndex = 1;               // start at 10 miles
static bool swapRB = false;              // flip if red and blue look swapped
static char selectedHex[8] = "";         // highlighted plane ("" = closest)
static volatile int32_t knobSteps = 0;   // written by the knob task

// ------------------------------------------------------------------
// Colors (RGB565). col() applies the optional red/blue swap.
// ------------------------------------------------------------------
static uint16_t col(uint8_t r, uint8_t g, uint8_t b) {
  if (swapRB) { uint8_t t = r; r = b; b = t; }
  return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
}
static uint16_t blend(uint8_t r, uint8_t g, uint8_t b, float k) {   // k = 0..1 brightness
  k = constrain(k, 0.0f, 1.0f);
  return col((uint8_t)(r * k), (uint8_t)(g * k), (uint8_t)(b * k));
}
#define C_BEZEL     col(0x2C, 0x2C, 0x2A)
#define C_SCOPE     col(0x04, 0x34, 0x2C)
#define C_RING      col(0x1D, 0x9E, 0x75)
#define C_GRID      col(0x08, 0x50, 0x41)
#define C_TEXT_DIM  col(0x5D, 0xCA, 0xA5)
#define C_PLANE     col(0x9F, 0xE1, 0xCB)
#define C_SELECT    col(0xEF, 0x9F, 0x27)
#define C_SELECT_LT col(0xFA, 0xC7, 0x75)
#define C_HOME      col(0xFA, 0xC7, 0x75)
#define C_BADGE     col(0x08, 0x50, 0x41)
#define C_WHITE     col(0xE1, 0xF5, 0xEE)
#define C_WARN      col(0xF0, 0x99, 0x7B)

// ------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------
static const float NM_PER_DEG = 60.0f;
static const float MI_PER_NM = 1.15078f;

// Offset of a point from the receiver, in miles (east, north).
static void offsetMiles(float lat, float lon, float &east, float &north) {
  north = (lat - rxLat) * NM_PER_DEG * MI_PER_NM;
  east  = (lon - rxLon) * NM_PER_DEG * MI_PER_NM * cosf(rxLat * DEG_TO_RAD);
}

// Screen position for a point; returns false if outside the current range.
static bool toScreen(float lat, float lon, int &x, int &y, float &distMi) {
  float e, n;
  offsetMiles(lat, lon, e, n);
  distMi = sqrtf(e * e + n * n);
  float range = RANGES_MI[rangeIndex];
  x = CX + (int)lroundf(e / range * SCOPE_R);
  y = CY - (int)lroundf(n / range * SCOPE_R);
  return distMi <= range;
}

static const char *compass(float deg) {
  static const char *dirs[] = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"};
  int i = (int)lroundf(fmodf(deg + 360.0f, 360.0f) / 45.0f) % 8;
  return dirs[i];
}

// ------------------------------------------------------------------
// Knob: a fast background task reads the two encoder pins
// ------------------------------------------------------------------
static void knobTask(void *) {
  static const int8_t trans[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};
  uint8_t last = (digitalRead(ENCODER_A_PIN) << 1) | digitalRead(ENCODER_B_PIN);
  int8_t acc = 0;
  for (;;) {
    uint8_t s = (digitalRead(ENCODER_A_PIN) << 1) | digitalRead(ENCODER_B_PIN);
    acc += trans[(last << 2) | s];
    last = s;
    if (acc >= 4)  { knobSteps++; acc = 0; }   // one detent clockwise
    if (acc <= -4) { knobSteps--; acc = 0; }   // one detent counter-clockwise
    vTaskDelay(1);
  }
}

// Knob button (through the PCF8574): returns 1 = click, 2 = double-click, 0 = nothing
static int readButton() {
  static uint8_t raw = HIGH, stable = HIGH;
  static uint32_t changedAt = 0, releasedAt = 0;
  static int clicks = 0;
  uint32_t now = millis();
  uint8_t s = pcf.digitalRead(P5, true);
  if (s != raw) { raw = s; changedAt = now; }
  if (raw != stable && now - changedAt >= 40) {
    stable = raw;
    if (stable == HIGH) { clicks++; releasedAt = now; }   // counted on release
  }
  if (clicks >= 2) { clicks = 0; return 2; }
  if (clicks == 1 && now - releasedAt > 350) { clicks = 0; return 1; }
  return 0;
}

// ------------------------------------------------------------------
// Fetching planes from the Pi (runs on its own so the sweep stays smooth)
// ------------------------------------------------------------------
static int lastHttpCode = 0;  // shown on screen while looking for the Pi, to help troubleshoot

static bool fetchReceiver() {
  HTTPClient http;
  String url = String("http://") + piAddress + "/tar1090/data/receiver.json";
  http.setConnectTimeout(3000);
  http.setTimeout(4000);
  if (!http.begin(url)) return false;
  int code = http.GET();
  lastHttpCode = code;
  bool ok = false;
  if (code == 200) {
    JsonDocument doc;
    if (!deserializeJson(doc, http.getStream()) && doc["lat"].is<float>()) {
      rxLat = doc["lat"].as<float>();
      rxLon = doc["lon"].as<float>();
      ok = true;
    }
  }
  http.end();
  return ok;
}

static void fetchPlanes() {
  HTTPClient http;
  String url = String("http://") + piAddress + "/tar1090/data/aircraft.json";
  http.setConnectTimeout(3000);
  http.setTimeout(4000);
  if (!http.begin(url)) { strlcpy(statusMsg, "Bad Pi address", sizeof(statusMsg)); return; }
  int code = http.GET();
  lastHttpCode = code;
  if (code != 200) {
    snprintf(statusMsg, sizeof(statusMsg), "Pi not answering (%d)", code);
    http.end();
    return;
  }

  // Only keep the fields we draw, which keeps memory use small.
  JsonDocument filter;
  JsonObject f = filter["aircraft"][0].to<JsonObject>();
  for (const char *k : {"hex", "flight", "t", "lat", "lon", "alt_baro", "gs", "track", "baro_rate", "seen_pos"})
    f[k] = true;

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getStream(), DeserializationOption::Filter(filter));
  http.end();
  if (err) {
    snprintf(statusMsg, sizeof(statusMsg), "Data error: %s", err.c_str());
    return;
  }

  static Plane fresh[MAX_PLANES];
  int n = 0, total = 0;
  for (JsonObject a : doc["aircraft"].as<JsonArray>()) {
    total++;
    if (!a["lat"].is<float>() || !a["lon"].is<float>()) continue;       // no position yet
    if ((a["seen_pos"] | 99.0f) > 30.0f) continue;                     // position too old
    if (!a["alt_baro"].is<int>()) continue;                            // "ground" or unknown
    if (n >= MAX_PLANES) break;
    Plane &p = fresh[n++];
    const char *cs = a["flight"] | "";
    const char *hx = a["hex"] | "";
    strlcpy(p.hex, hx, sizeof(p.hex));
    // trim trailing spaces from the callsign; fall back to the hex code
    strlcpy(p.callsign, (*cs ? cs : hx), sizeof(p.callsign));
    for (int i = strlen(p.callsign) - 1; i >= 0 && p.callsign[i] == ' '; i--) p.callsign[i] = 0;
    for (char *c = p.callsign; *c; c++) *c = toupper(*c);
    strlcpy(p.type, a["t"] | "", sizeof(p.type));
    p.lat = a["lat"];
    p.lon = a["lon"];
    p.alt = a["alt_baro"];
    p.speed = (int)lroundf(a["gs"] | 0.0f);
    p.track = a["track"] | -1.0f;
    p.climb = a["baro_rate"] | 0;
  }

  xSemaphoreTake(dataLock, portMAX_DELAY);
  memcpy(planes, fresh, sizeof(Plane) * n);
  numPlanes = n;
  totalSeen = total;
  lastGoodFetch = millis();
  statusMsg[0] = 0;
  xSemaphoreGive(dataLock);
}

static void fetchTask(void *) {
  uint32_t wifiLostAt = 0;
  for (;;) {
    // WiFi watchdog: nudge after 1 minute offline, restart the display after 5 minutes offline
    if (WiFi.status() != WL_CONNECTED) {
      if (!wifiLostAt) wifiLostAt = millis();
      uint32_t down = millis() - wifiLostAt;
      snprintf(statusMsg, sizeof(statusMsg), "WiFi reconnecting... %lus", (unsigned long)(down / 1000));
      if (down > 60000 && down % 30000 < 2000) WiFi.reconnect();
      if (down > 300000) ESP.restart();
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }
    wifiLostAt = 0;
    // If the Pi's replies keep timing out (negative codes) for 30s while WiFi looks connected,
    // the WiFi link is probably half-stuck: drop it and reconnect.
    static uint32_t badSince = 0;
    if (lastHttpCode < 0) {
      if (!badSince) badSince = millis();
      else if (millis() - badSince > 30000) {
        strlcpy(statusMsg, "Resetting WiFi link...", sizeof(statusMsg));
        WiFi.disconnect(false);
        vTaskDelay(pdMS_TO_TICKS(1000));
        WiFi.reconnect();
        badSince = 0; lastHttpCode = 0;
        vTaskDelay(pdMS_TO_TICKS(5000));
        continue;
      }
    } else badSince = 0;
    if (isnan(rxLat)) {
      if (!fetchReceiver()) {
        snprintf(statusMsg, sizeof(statusMsg), "Looking for Pi %s (err %d, %ddBm)", piAddress, lastHttpCode,
                 (int)WiFi.RSSI());
        vTaskDelay(pdMS_TO_TICKS(2000));
        continue;
      }
    }
    fetchPlanes();
    vTaskDelay(pdMS_TO_TICKS(FETCH_EVERY_MS));
  }
}

// ------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------
static void centeredText(const char *s, int x, int y, uint8_t size, uint16_t color) {
  int16_t bx, by; uint16_t bw, bh;
  gfx->setTextSize(size);
  gfx->getTextBounds(s, 0, 0, &bx, &by, &bw, &bh);
  gfx->setTextColor(color);
  gfx->setCursor(x - bw / 2, y - bh / 2);
  gfx->print(s);
}

static void dashedCircle(int r, uint16_t color) {
  for (int a = 0; a < 360; a += 6) {
    float a1 = a * DEG_TO_RAD, a2 = (a + 3) * DEG_TO_RAD;
    gfx->drawLine(CX + r * cosf(a1), CY + r * sinf(a1), CX + r * cosf(a2), CY + r * sinf(a2), color);
  }
}

// ---- Keeping text from piling up -------------------------------------------------------
// Each frame we keep a list of screen boxes that are already taken (plane icons, labels, the info
// box...). New text tries a few spots and takes the first one that is free and inside the circle.
struct Box { int16_t x, y, w, h; };
static Box taken[200];
static int nTaken = 0;
static void takeBox(int x, int y, int w, int h) { if (nTaken < 200) taken[nTaken++] = { (int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h }; }
static bool boxFree(int x, int y, int w, int h) {
  for (int i = 0; i < nTaken; i++) {
    const Box &b = taken[i];
    if (x < b.x + b.w + 2 && x + w + 2 > b.x && y < b.y + b.h + 2 && y + h + 2 > b.y) return false;
  }
  return true;
}
static bool boxInside(int x, int y, int w, int h) {
  return insideScope(x, y) && insideScope(x + w, y) && insideScope(x, y + h) && insideScope(x + w, y + h);
}

// A plane's callsign: try right-above, left-above, right-below, left-below.
// Returns false (and draws nothing) if every spot is blocked, unless mustShow is set.
static bool placePlaneLabel(int x, int y, const char *text, uint8_t size, uint16_t color, bool mustShow) {
  int w = strlen(text) * 6 * size, h = 8 * size, gap = 8 + 2 * size;
  const int cand[4][2] = { { x + gap, y - h - 4 }, { x - gap - w, y - h - 4 }, { x + gap, y + 6 }, { x - gap - w, y + 6 } };
  int lx = -9999, ly = 0;
  for (auto &c : cand)
    if (boxInside(c[0], c[1], w, h) && boxFree(c[0], c[1], w, h)) { lx = c[0]; ly = c[1]; break; }
  if (lx == -9999) {
    if (!mustShow) return false;
    labelSpot(x, y, text, size, lx, ly);       // the selected plane always gets a label
  }
  gfx->setTextSize(size);
  gfx->setTextColor(color);
  gfx->setCursor(lx, ly);
  gfx->print(text);
  takeBox(lx, ly, w, h);
  return true;
}

// Ring distance labels: each ring's label sits on the right of its ring; if a plane or label is in
// the way it moves to the left, then the top, then the bottom, and only hides if all four are blocked.
// It moves back to the right as soon as that spot is free again.
static void drawRingLabels() {
  char buf[16];
  float range = RANGES_MI[rangeIndex];
  for (int i = 1; i <= 3; i++) {
    float v = range * i / 3.0f;
    if (v < 10) snprintf(buf, sizeof(buf), "%.1fmi", v); else snprintf(buf, sizeof(buf), "%.0fmi", v);
    int r = SCOPE_R * i / 3, w = strlen(buf) * 6, h = 8;
    const int spot[4][2] = {
      { CX + r - w - 4, CY + 5 },          // right
      { CX - r + 4,     CY + 5 },          // left
      { CX + 5,         CY - r + 4 },      // top
      { CX + 5,         CY + r - h - 4 },  // bottom
    };
    for (auto &c : spot) {
      if (!boxInside(c[0], c[1], w, h) || !boxFree(c[0], c[1], w, h)) continue;
      gfx->setTextSize(1);
      gfx->setTextColor(C_TEXT_DIM);
      gfx->setCursor(c[0], c[1]);
      gfx->print(buf);
      takeBox(c[0], c[1], w, h);
      break;
    }
  }
}

static void drawScope(float sweepDeg) {
  gfx->fillScreen(0x0000);
  gfx->fillCircle(CX, CY, 239, C_BEZEL);
  gfx->fillCircle(CX, CY, 232, C_SCOPE);

  // grid: crosshair and range rings at 1/3, 2/3 and full range
  gfx->drawFastHLine(CX - SCOPE_R, CY, SCOPE_R * 2, C_GRID);
  gfx->drawFastVLine(CX, CY - SCOPE_R, SCOPE_R * 2, C_GRID);
  for (int i = 1; i <= 3; i++) dashedCircle(SCOPE_R * i / 3, C_RING);

  // (ring distance labels are drawn after the planes, in drawRingLabels, so they can step aside)
  centeredText("N", CX, CY - SCOPE_R + 14, 2, C_TEXT_DIM);

  // airports
  if (!isnan(rxLat)) {
    for (const Airport &ap : AIRPORTS) {
      int x, y; float d;
      if (!toScreen(ap.lat, ap.lon, x, y, d)) continue;
      gfx->drawRect(x - 4, y - 4, 9, 9, C_RING);
      gfx->setTextSize(1);
      gfx->setTextColor(C_TEXT_DIM);
      gfx->setCursor(x + 7, y - 3);
      gfx->print(ap.code);
    }
  }

  // sweep: a bright leading line with a fading trail behind it
  for (int i = 0; i <= 60; i++) {
    float a = (sweepDeg - i * 0.5f - 90.0f) * DEG_TO_RAD;   // 0 deg = north
    float k = 1.0f - i / 60.0f;
    uint16_t c = (i == 0) ? col(0x9F, 0xE1, 0xCB) : blend(0x1D, 0x9E, 0x75, 0.15f + 0.55f * k * k);
    gfx->drawLine(CX, CY, CX + SCOPE_R * cosf(a), CY + SCOPE_R * sinf(a), c);
  }

  // home dot
  gfx->fillCircle(CX, CY, 5, C_HOME);
}

// A small arrow pointing where the plane is heading.
// Pick a spot for a plane's label that stays fully inside the round screen:
// try right-above, left-above, right-below, left-below; otherwise slide it toward the middle.
static bool insideScope(int x, int y) {
  int dx = x - CX, dy = y - CY;
  return dx * dx + dy * dy <= (SCOPE_R - 4) * (SCOPE_R - 4);
}
static void labelSpot(int x, int y, const char *text, uint8_t size, int &lx, int &ly) {
  int w = strlen(text) * 6 * size, h = 8 * size, gap = 8 + 2 * size;
  const int cand[4][2] = { { x + gap, y - h - 4 }, { x - gap - w, y - h - 4 }, { x + gap, y + 6 }, { x - gap - w, y + 6 } };
  for (auto &c : cand) {
    if (insideScope(c[0], c[1]) && insideScope(c[0] + w, c[1]) && insideScope(c[0], c[1] + h) && insideScope(c[0] + w, c[1] + h)) {
      lx = c[0]; ly = c[1]; return;
    }
  }
  lx = cand[0][0]; ly = cand[0][1];            // nothing fits cleanly: nudge toward the center until it does
  for (int i = 0; i < 40; i++) {
    if (insideScope(lx, ly) && insideScope(lx + w, ly) && insideScope(lx, ly + h) && insideScope(lx + w, ly + h)) return;
    lx += (CX - (lx + w / 2)) / 8; ly += (CY - (ly + h / 2)) / 8;
  }
}

static void drawPlaneIcon(int x, int y, float track, uint16_t color) {
  if (track < 0) { gfx->fillCircle(x, y, 4, color); return; }
  float a = (track - 90.0f) * DEG_TO_RAD;
  float ca = cosf(a), sa = sinf(a);
  int tipX = x + 11 * ca,  tipY = y + 11 * sa;
  int lX = x - 7 * ca + 6 * -sa, lY = y - 7 * sa + 6 * ca;
  int rX = x - 7 * ca - 6 * -sa, rY = y - 7 * sa - 6 * ca;
  int bX = x - 3 * ca, bY = y - 3 * sa;
  gfx->fillTriangle(tipX, tipY, lX, lY, bX, bY, color);
  gfx->fillTriangle(tipX, tipY, rX, rY, bX, bY, color);
}

static void drawBadge(const Plane &p, float distMi, float bearing, int by) {
  char line1[32], line2[32];
  snprintf(line1, sizeof(line1), "%s %.1fmi %s", p.callsign, distMi, compass(bearing));
  const char *arrow = p.climb > 250 ? "^" : (p.climb < -250 ? "v" : "-");
  char altStr[16];
  fmt::withCommas(p.alt, altStr, sizeof(altStr));
  if (p.type[0]) snprintf(line2, sizeof(line2), "%s %sft%s %dkt", p.type, altStr, arrow, p.speed);
  else           snprintf(line2, sizeof(line2), "%sft%s %dkt", altStr, arrow, p.speed);

  int bw = 260, bh = 52, bx = CX - bw / 2;
  gfx->fillRoundRect(bx, by, bw, bh, 10, C_BADGE);
  gfx->drawRoundRect(bx, by, bw, bh, 10, C_SELECT);
  centeredText(line1, CX, by + 15, 2, C_SELECT_LT);
  centeredText(line2, CX, by + 37, 2, C_PLANE);
}

static void drawFrame(float sweepDeg, uint32_t nowMs) {
  drawScope(sweepDeg);

  xSemaphoreTake(dataLock, portMAX_DELAY);
  int n = numPlanes;
  static Plane snap[MAX_PLANES];
  memcpy(snap, planes, sizeof(Plane) * n);
  int total = totalSeen;
  uint32_t lastOk = lastGoodFetch;
  char status[48]; strlcpy(status, statusMsg, sizeof(status));
  xSemaphoreGive(dataLock);

  // pick the highlighted plane: the one chosen with the knob, else the closest
  int sel = -1; float selDist = 1e9, selBearing = 0;
  int closest = -1; float closestDist = 1e9;
  int shown = 0;
  static int px[MAX_PLANES], py[MAX_PLANES], pi[MAX_PLANES];   // planes that landed on screen
  int pm = 0, selX = 0, selY = 0; bool selOn = false;
  nTaken = 0;
  takeBox(CX - 8, CY - SCOPE_R + 4, 16, 18);          // the "N"
  // The info box normally sits at the bottom with the plane count at the top. If the box would
  // cover the selected plane (or more planes than at the top), the two swap places.
  const int BADGE_BOTTOM = 372, BADGE_TOP = 56, BADGE_W = 260, BADGE_H = 52;
  int badgeY = BADGE_BOTTOM, countY = 62;
  bool countReserved = false;
  if (!isnan(rxLat)) {                                // airport squares and their names
    for (const Airport &ap : AIRPORTS) {
      int x, y; float d;
      if (toScreen(ap.lat, ap.lon, x, y, d)) takeBox(x - 4, y - 4, 11 + 6 * strlen(ap.code), 9);
    }
  }
  if (!isnan(rxLat)) {
    for (int i = 0; i < n; i++) {
      float e, no; offsetMiles(snap[i].lat, snap[i].lon, e, no);
      float d = sqrtf(e * e + no * no);
      if (d < closestDist) { closestDist = d; closest = i; }
      if (selectedHex[0] && strcmp(snap[i].hex, selectedHex) == 0) sel = i;
    }
    if (sel < 0) { sel = closest; selectedHex[0] = 0; }

    // 1. plane icons (the selected one last, on top) and their boxes
    for (int i = 0; i < n; i++) {
      int x, y; float d;
      if (!toScreen(snap[i].lat, snap[i].lon, x, y, d)) continue;
      shown++;
      px[pm] = x; py[pm] = y; pi[pm++] = i;
      takeBox(x - 9, y - 9, 18, 18);
      if (i == sel) { selX = x; selY = y; selOn = true; continue; }
      drawPlaneIcon(x, y, snap[i].track, C_PLANE);
    }
    if (sel >= 0) {
      const Plane &p = snap[sel];
      float e, no; offsetMiles(p.lat, p.lon, e, no);
      selDist = sqrtf(e * e + no * no);
      selBearing = fmodf(atan2f(e, no) * RAD_TO_DEG + 360.0f, 360.0f);
      int selBoxStart = nTaken;
      if (selOn) {
        int ping = 6 + (nowMs / 40) % 22;             // expanding ping ring
        gfx->drawCircle(selX, selY, ping, blend(0xEF, 0x9F, 0x27, 1.0f - (ping - 6) / 22.0f));
        drawPlaneIcon(selX, selY, p.track, C_SELECT);
        // 2. the selected plane's label goes first and always shows
        placePlaneLabel(selX, selY, p.callsign, 2, C_SELECT_LT, true);
      }
      // 3. info box: score each spot. Covering the selected plane (its ping ring or label) is a big
      //    no; covering any other plane icon costs a little. Lowest score wins, bottom on a tie.
      auto score = [&](int y) {
        int sc = 0, x0 = CX - BADGE_W / 2;
        auto hit = [&](int bx, int by, int bw, int bh) {
          return x0 < bx + bw + 4 && x0 + BADGE_W + 4 > bx && y < by + bh + 4 && y + BADGE_H + 4 > by;
        };
        if (selOn && hit(selX - 28, selY - 28, 56, 56)) sc += 1000;          // selected plane + ping
        for (int k = selBoxStart; k < nTaken; k++)                            // selected plane's label
          if (hit(taken[k].x, taken[k].y, taken[k].w, taken[k].h)) sc += 1000;
        for (int k = 0; k < pm; k++)
          if (pi[k] != sel && hit(px[k] - 9, py[k] - 9, 18, 18)) sc += 10;     // other planes
        return sc;
      };
      if (score(BADGE_TOP) < score(BADGE_BOTTOM)) { badgeY = BADGE_TOP; countY = 424; }
      takeBox(CX - BADGE_W / 2, badgeY, BADGE_W, BADGE_H);
    }
    takeBox(CX - 150, countY - 8, 300, 20);           // the count line, wherever it ended up
    countReserved = true;
    // 4. other labels, closest planes first, skipping any that can't find a free spot
    if (RANGES_MI[rangeIndex] <= 50) {
      for (int k = 0; k < pm; k++) {                  // simple sort by distance from home
        for (int j = k + 1; j < pm; j++) {
          int dk = (px[k] - CX) * (px[k] - CX) + (py[k] - CY) * (py[k] - CY);
          int dj = (px[j] - CX) * (px[j] - CX) + (py[j] - CY) * (py[j] - CY);
          if (dj < dk) { int t; t = px[k]; px[k] = px[j]; px[j] = t; t = py[k]; py[k] = py[j]; py[j] = t; t = pi[k]; pi[k] = pi[j]; pi[j] = t; }
        }
      }
      for (int k = 0; k < pm; k++) {
        if (pi[k] == sel) continue;
        placePlaneLabel(px[k], py[k], snap[pi[k]].callsign, 1, C_TEXT_DIM, false);
      }
    }
  }
  // 5. ring distance labels move around anything in their way
  if (!countReserved) takeBox(CX - 150, countY - 8, 300, 20);   // the count / status line
  drawRingLabels();
  // 6. info box on top of everything
  if (sel >= 0 && !isnan(rxLat)) drawBadge(snap[sel], selDist, selBearing, badgeY);

  // top line: plane count, or what we're waiting on
  char top[48];
  bool stale = lastOk == 0 || nowMs - lastOk > 15000;
  if (status[0] && stale) {
    centeredText(status, CX, countY + 8, strlen(status) > 20 ? 1 : 2, C_WARN);  // long messages in small text so they fit
  } else {
    snprintf(top, sizeof(top), "%d in range  /  %d seen", shown, total);
    centeredText(top, CX, countY, 1, C_TEXT_DIM);
    if (n == 0) centeredText("No planes with positions yet", CX, 300, 2, C_TEXT_DIM);
  }

  gfx->flush();
}

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------
static void boardPowerOn() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  pcf.pinMode(P0, OUTPUT);
  pcf.pinMode(P2, OUTPUT);
  pcf.pinMode(P3, OUTPUT);
  pcf.pinMode(P4, OUTPUT);
  pcf.pinMode(P5, INPUT_PULLUP);
  pcf.begin();
  pcf.digitalWrite(P3, HIGH); delay(50);    // lcd power
  pcf.digitalWrite(P4, LOW);  delay(100);   // lcd reset
  pcf.digitalWrite(P4, HIGH); delay(100);
  pcf.digitalWrite(P0, LOW);  delay(100);   // touch reset
  pcf.digitalWrite(P0, HIGH); delay(100);
  pcf.digitalWrite(P2, HIGH);
  pinMode(ONBOARD_LED_PIN, OUTPUT);
  digitalWrite(ONBOARD_LED_PIN, LOW);
}

static void showMessage(const char *l1, const char *l2 = "", const char *l3 = "", const char *l4 = "") {
  gfx->fillScreen(0x0000);
  gfx->fillCircle(CX, CY, 239, C_BEZEL);
  gfx->fillCircle(CX, CY, 232, C_SCOPE);
  centeredText(l1, CX, 170, 3, C_SELECT_LT);
  centeredText(l2, CX, 230, 2, C_WHITE);
  centeredText(l3, CX, 265, 2, C_WHITE);
  centeredText(l4, CX, 300, 2, C_TEXT_DIM);
  gfx->flush();
}

static void onPortalStart(WiFiManager *) {
  showMessage("WiFi setup", "On your phone, join", "PlaneRadar-Setup", "then pick your WiFi");
}
static void onPortalSave() {
  showMessage("Saved!", "Connecting to", "your WiFi...", "(can take up to a minute)");
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("PlaneRadar starting");

  prefs.begin("radar", false);
  rangeIndex = constrain(prefs.getInt("range", 1), 0, NUM_RANGES - 1);
  swapRB = prefs.getBool("swaprb", false);
  String savedPi = prefs.getString("pi", DEFAULT_PI_ADDRESS);
  strlcpy(piAddress, savedPi.c_str(), sizeof(piAddress));

  boardPowerOn();
  screen->begin();
  panelBus->beginWrite();          // panel orientation / color order, as in Elecrow's examples
  panelBus->writeCommand(0x36);
  panelBus->write(0x08);
  panelBus->endWrite();
  gfx->begin(GFX_SKIP_OUTPUT_BEGIN);
  gfx->setTextWrap(false);           // text that runs off an edge is cut off, never wrapped to the other side
  ledcAttach(BACKLIGHT_PIN, 5000, 8);
  ledcWrite(BACKLIGHT_PIN, BACKLIGHT_LEVEL);

  pinMode(ENCODER_A_PIN, INPUT);
  pinMode(ENCODER_B_PIN, INPUT);
  xTaskCreatePinnedToCore(knobTask, "knob", 2048, NULL, 2, NULL, 0);

  showMessage("Plane Radar", "Connecting to WiFi...");

  // WiFi: connect to the saved network ourselves first, patiently, and only show the
  // "PlaneRadar-Setup" page if there's no saved network or it really won't connect.
  WiFi.mode(WIFI_STA);
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);      // look at every access point...
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);  // ...and join the strongest one, not the first one heard
  WiFi.setSleep(false);                           // no Wi-Fi power saving: faster, steadier replies
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  WiFiManager wm;
  WiFiManagerParameter piParam("pi", "Plane radar Pi address", piAddress, sizeof(piAddress) - 1);
  wm.addParameter(&piParam);
  wm.setAPCallback(onPortalStart);
  wm.setPreSaveConfigCallback(onPortalSave);
  wm.setTitle("Plane Radar");
  wm.setConnectTimeout(30);
  wm.setConfigPortalTimeout(180);   // setup page gives up after 3 minutes and the display restarts to try again

  bool online = false;
  if (wm.getWiFiIsSaved()) {
    WiFi.begin();                    // saved network name + password
    uint32_t started = millis();
    while (millis() - started < WIFI_BOOT_WAIT_MS) {
      if (WiFi.status() == WL_CONNECTED) { online = true; break; }
      char line[32];
      snprintf(line, sizeof(line), "%lus (up to %lus)", (unsigned long)((millis() - started) / 1000),
               (unsigned long)(WIFI_BOOT_WAIT_MS / 1000));
      showMessage("Plane Radar", "Connecting to WiFi...", line);
      if ((millis() - started) % 30000 < 500 && millis() - started > 1000) WiFi.reconnect();  // nudge every 30s
      delay(500);
    }
  }
  if (!online) {
    if (!wm.startConfigPortal("PlaneRadar-Setup")) {
      showMessage("WiFi failed", "Restarting to try again...");
      delay(3000);
      ESP.restart();
    }
  }
  if (strlen(piParam.getValue()) > 0 && strcmp(piParam.getValue(), piAddress) != 0) {
    strlcpy(piAddress, piParam.getValue(), sizeof(piAddress));
    prefs.putString("pi", piAddress);
  }
  Serial.printf("WiFi OK, IP %s, Pi at %s\n", WiFi.localIP().toString().c_str(), piAddress);
  showMessage("Plane Radar", "WiFi connected", "Looking for the Pi at", piAddress);

  dataLock = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(fetchTask, "fetch", 12288, NULL, 1, NULL, 0);
}

// ------------------------------------------------------------------
// Main loop: read the knob, draw a frame
// ------------------------------------------------------------------
void loop() {
  static int32_t lastSteps = 0;
  static uint32_t rangeSavedAt = 0;
  static bool rangeDirty = false;
  uint32_t now = millis();

  // knob turn = zoom
  int32_t s = knobSteps;
  if (s != lastSteps) {
    int delta = (s > lastSteps) ? 1 : -1;
    lastSteps = s;
    int next = constrain(rangeIndex + delta, 0, NUM_RANGES - 1);
    if (next != rangeIndex) { rangeIndex = next; rangeDirty = true; rangeSavedAt = now; }
  }
  if (rangeDirty && now - rangeSavedAt > 3000) { prefs.putInt("range", rangeIndex); rangeDirty = false; }

  // knob press = next plane, double press = swap colors
  int b = readButton();
  if (b == 1) {
    xSemaphoreTake(dataLock, portMAX_DELAY);
    // sort the in-range planes by distance and step to the one after the current pick
    int order[MAX_PLANES]; float dist[MAX_PLANES]; int m = 0;
    if (!isnan(rxLat)) {
      for (int i = 0; i < numPlanes; i++) {
        float e, n; offsetMiles(planes[i].lat, planes[i].lon, e, n);
        float d = sqrtf(e * e + n * n);
        if (d > RANGES_MI[rangeIndex]) continue;
        int j = m++;
        while (j > 0 && dist[j - 1] > d) { order[j] = order[j - 1]; dist[j] = dist[j - 1]; j--; }
        order[j] = i; dist[j] = d;
      }
    }
    int cur = -1;
    for (int k = 0; k < m; k++) if (selectedHex[0] && strcmp(planes[order[k]].hex, selectedHex) == 0) cur = k;
    if (m > 0) strlcpy(selectedHex, planes[order[(cur + 1 + (cur < 0 ? 1 : 0)) % m]].hex, sizeof(selectedHex));
    xSemaphoreGive(dataLock);
  } else if (b == 2) {
    swapRB = !swapRB;
    prefs.putBool("swaprb", swapRB);
  }

  float sweep = fmodf(now / 1000.0f / SWEEP_SECONDS * 360.0f, 360.0f);
  drawFrame(sweep, now);
}
