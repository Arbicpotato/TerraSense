// ============================================================================
//  TerraSense Hub (ESP32): local greenhouse control + Firebase link to the app
//
//  Core 1 (loop):  sensors, relays and automation. Runs even with no Wi-Fi.
//  Core 0 (task):  Wi-Fi, BLE provisioning, Firebase, uploads to /live and
//                  /history, reads /controls and the plant stage from /meta/plan
//                  (the plan is also saved in flash, so the cycle survives reboots and
//                  Wi-Fi loss; it ends only when the owner is removed),
//                  registers the hub in /deviceRegistry so the app can claim it.
//
//  Wi-Fi setup over Bluetooth (BLE):
//    - Wi-Fi credentials are stored in flash (NVS). No credentials -> BLE is
//      always advertising so the app can send them.
//    - If Wi-Fi is lost for a while, the hub alternates: BLE window (app can send
//      a new password), then a pause, repeating until Wi-Fi is back.
//    - Wi-Fi up -> BLE advertising stops (unless BLE_ALWAYS_ON is true, the default).
//
//  Libraries: Firebase Arduino Client Library for ESP8266 and ESP32 (mobizt),
//             ArduinoJson 7.x, DHT sensor library + Adafruit Unified Sensor,
//             BH1750 (Christopher Laws), NimBLE-Arduino 2.x (h2zero)
//
//  Board settings: if you get "Sketch too big", choose
//    Tools -> Partition Scheme -> "Minimal SPIFFS (1.9MB APP with OTA)"
//
//  secrets.h must define:
//    WIFI_SSID, WIFI_PASSWORD          (only used if USE_SECRETS_WIFI_FALLBACK)
//    FIREBASE_API_KEY, FIREBASE_DB_URL
//    DEVICE_EMAIL, DEVICE_PASSWORD     (a Firebase Auth user for the hub)
//    GH_ID_OVERRIDE                    ("" to derive the ID from the MAC)
//    CLAIM_CODE                        (UPPERCASE, e.g. "K7P2QX")
//
//  WIRING NOTE: HC-SR04 ECHO outputs 5 V. Put a divider (1k + 2k) on GPIO 19
//  so the ESP32 (3.3 V only) is not damaged.
// ============================================================================
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <Preferences.h>
#include <time.h>
#include <BH1750.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include "secrets.h"

// ============================================================================
// PINS
// ============================================================================
#define I2C_SDA           21
#define I2C_SCL           22
#define DHT_PIN           4
#define SOIL1_PIN         35
#define SOIL2_PIN         32
#define US_TRIG           18
#define US_ECHO           19

#define RELAY_MAIN_PUMP   25   // Relay 1: submersible irrigation pump
#define RELAY_VALVE_IRRIG 26   // Relay 2: irrigation solenoid valve
#define RELAY_FERT_PUMP   27   // Relay 3: fertilizer pump
#define RELAY_FAN         33   // Relay 4: exhaust fan

#define RELAY_ON          LOW  // active LOW
#define RELAY_OFF         HIGH

// ============================================================================
// SETTINGS (calibrate these with your own hardware)
// ============================================================================
// Soil sensors: raw ADC with the probe in AIR (0 %) and in WATER (100 %).
const int   SOIL_AIR_ADC     = 3400;
const int   SOIL_WATER_ADC   = 1400;

// Water tank: distance from the ultrasonic sensor to the water surface.
const float TANK_EMPTY_CM    = 30.0;   // distance when the tank is empty
const float TANK_FULL_CM     = 5.0;    // distance when the tank is full
const float TANK_MIN_PERCENT = 10.0;   // pump is blocked below this level
const bool  REQUIRE_TANK_SENSOR_FOR_PUMP = false;  // true = never pump without a valid tank reading

// Used when no plant cycle is running in the app.
const float DEFAULT_TEMP_MAX      = 28.0;   // fan ON above this (C)
const float DEFAULT_MOISTURE_MIN  = 20.0;   // irrigate below this (%)
const float FAN_HYSTERESIS        = 1.0;    // fan turns OFF at (max - this)

// Irrigation
const unsigned long AUTO_RUN_MS          = 3000;                 // one automatic watering burst
const unsigned long AUTO_COOLDOWN_MS     = 10UL * 60UL * 1000UL; // min gap between automatic bursts
const unsigned long VALVE_LEAD_MS        = 500;                  // valve opens before pump, closes after
const unsigned long MANUAL_PUMP_MAX_MS   = 5UL * 60UL * 1000UL;  // safety cut-off for manual pump
const unsigned long CLOUD_STALE_MS       = 2UL * 60UL * 1000UL;  // no controls update -> leave manual mode

// Timing
const unsigned long SENSOR_INTERVAL_MS   = 5000;
const unsigned long CONTROLS_INTERVAL_MS = 3000;
const unsigned long PLAN_INTERVAL_MS     = 60000;
const unsigned long LIVE_INTERVAL_MS     = 30000;
const unsigned long HISTORY_INTERVAL_MS  = 5UL * 60UL * 1000UL;
const unsigned long OWNER_INTERVAL_MS    = 15000;   // how often the hub checks whether it is still owned

// Wi-Fi / BLE behaviour
// false = Wi-Fi comes only from the app over BLE (what you want for real users).
// true  = if nothing is stored yet, use WIFI_SSID / WIFI_PASSWORD from secrets.h.
const bool          USE_SECRETS_WIFI_FALLBACK = false;
// true  = Bluetooth is always available, so the app can change the Wi-Fi at any time.
// false = Bluetooth only opens when there is no Wi-Fi (saves power and radio time).
const bool          BLE_ALWAYS_ON = true;
const unsigned long WIFI_RETRY_MS     = 30000;   // gap between reconnect attempts
const unsigned long BLE_AFTER_DOWN_MS = 60000;   // Wi-Fi down this long -> open BLE windows
const unsigned long BLE_WINDOW_MS     = 120000;  // BLE advertising window
const unsigned long BLE_PAUSE_MS      = 60000;   // pause between BLE windows (Wi-Fi only)
const unsigned long WIFI_JOIN_MS      = 20000;   // how long to wait when trying new credentials

// BLE UUIDs: must match the app (App.tsx)
#define BLE_SERVICE_UUID  "7e1a0001-5c0b-4b8e-9d3a-2f4b6c7d8e90"
#define BLE_PROV_UUID     "7e1a0002-5c0b-4b8e-9d3a-2f4b6c7d8e90"   // app writes JSON + '\n'
#define BLE_STATUS_UUID   "7e1a0003-5c0b-4b8e-9d3a-2f4b6c7d8e90"   // app reads status text

// ============================================================================
// SHARED STATE (loop <-> cloud task)
// ============================================================================
struct Sensors {
  float temp = NAN, hum = NAN, lux = -1;
  int   soil1 = 0, soil2 = 0;
  float soilPct1 = 0, soilPct2 = 0, soilPct = 0;
  float tankDist = -1, tankPct = NAN;
};

struct Remote {                 // from /controls
  bool manual = false, emergencyStop = false;
  bool pump = false, cooler = false, fertilizer = false;
  unsigned long lastOk = 0;
};

struct Targets {                // from the current stage in /meta/plan
  bool  havePlan = false;
  float tempMax = DEFAULT_TEMP_MAX;
  float moistureMin = DEFAULT_MOISTURE_MIN;
  char  stageName[24] = "";
};

struct Provision {              // credentials received over BLE, waiting to be tried
  char ssid[33] = "";
  char pass[65] = "";
};

Sensors gSensors;
Remote  gRemote;
Targets gTargets;
Provision gProv;
volatile bool gProvPending = false;
volatile bool gPumpOn = false, gValveOn = false, gFanOn = false, gFertOn = false;
volatile bool gBleConnected = false, gBleAdvertising = false;
volatile bool gOwned = true;   // does an app account currently own this hub? (from /ownerUid)
SemaphoreHandle_t gMutex;

#define LOCK()   xSemaphoreTake(gMutex, portMAX_DELAY)
#define UNLOCK() xSemaphoreGive(gMutex)

// ============================================================================
// OBJECTS
// ============================================================================
DHT dht(DHT_PIN, DHT22);
BH1750 lightMeter;
bool bhOk = false;

FirebaseData fbdo;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;

Preferences prefs;
String wifiSsid, wifiPass;          // active Wi-Fi credentials (cloud task + setup only)
NimBLECharacteristic *gStatusChar = nullptr;

String ghId;
String BASE;   // "greenhouses/<ghId>"
bool registered = false;

// ============================================================================
// SENSOR HELPERS
// ============================================================================
float readWaterLevelCm() {
  digitalWrite(US_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(US_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(US_TRIG, LOW);
  long duration = pulseIn(US_ECHO, HIGH, 30000);
  if (duration == 0) return -1.0;
  return (duration * 0.0343) / 2.0;
}

int readSoilAveraged(int pin) {
  long sum = 0;
  for (int i = 0; i < 8; i++) { sum += analogRead(pin); delay(2); }
  return (int)(sum / 8);
}

float soilToPct(int raw) {
  float pct = (float)(SOIL_AIR_ADC - raw) * 100.0f / (float)(SOIL_AIR_ADC - SOIL_WATER_ADC);
  return constrain(pct, 0.0f, 100.0f);
}

float round1(float v) { return roundf(v * 10.0f) / 10.0f; }

void readSensors() {
  Sensors s;
  s.temp = dht.readTemperature();
  s.hum  = dht.readHumidity();
  if (isnan(s.temp) || isnan(s.hum)) { s.temp = NAN; s.hum = NAN; }

  s.lux = bhOk ? lightMeter.readLightLevel() : -1;

  s.soil1 = readSoilAveraged(SOIL1_PIN);
  s.soil2 = readSoilAveraged(SOIL2_PIN);
  s.soilPct1 = soilToPct(s.soil1);
  s.soilPct2 = soilToPct(s.soil2);
  s.soilPct  = (s.soilPct1 + s.soilPct2) / 2.0f;

  s.tankDist = readWaterLevelCm();
  if (s.tankDist >= 0) {
    float pct = (TANK_EMPTY_CM - s.tankDist) * 100.0f / (TANK_EMPTY_CM - TANK_FULL_CM);
    s.tankPct = constrain(pct, 0.0f, 100.0f);
  }

  LOCK();
  gSensors = s;
  UNLOCK();
}

// ============================================================================
// RELAYS
// ============================================================================
void setRelay(int pin, bool on, volatile bool &flag) {
  digitalWrite(pin, on ? RELAY_ON : RELAY_OFF);
  flag = on;
}

bool tankAllowsPump(const Sensors &s) {
  if (isnan(s.tankPct)) return !REQUIRE_TANK_SENSOR_FOR_PUMP;
  return s.tankPct >= TANK_MIN_PERCENT;
}

// Decides whether irrigation should run right now (auto or manual).
bool wantIrrigation(const Sensors &s, const Remote &r, const Targets &t,
                    bool manual, bool stopAll, unsigned long now) {
  static unsigned long autoRunUntil = 0, lastAutoEnd = 0, manualStart = 0;
  static bool manualLocked = false, wasManual = false;

  if (stopAll) { autoRunUntil = 0; manualStart = 0; return false; }

  if (manual != wasManual) {
    autoRunUntil = 0; manualStart = 0; manualLocked = false; wasManual = manual;
  }

  bool tankOk = tankAllowsPump(s);

  if (manual) {
    if (!r.pump) { manualStart = 0; manualLocked = false; return false; }
    if (manualLocked || !tankOk) return false;
    if (manualStart == 0) manualStart = now;
    if (now - manualStart > MANUAL_PUMP_MAX_MS) { manualLocked = true; return false; }
    return true;
  }

  // Automatic: both soil sensors must agree the soil is dry
  if (autoRunUntil == 0) {
    bool dry = s.soilPct1 < t.moistureMin && s.soilPct2 < t.moistureMin;
    bool cooled = (lastAutoEnd == 0) || (now - lastAutoEnd > AUTO_COOLDOWN_MS);
    if (dry && cooled && tankOk) autoRunUntil = now + AUTO_RUN_MS;
  }
  if (autoRunUntil != 0) {
    // rollover-safe comparison (millis wraps after ~49 days)
    if ((long)(autoRunUntil - now) > 0 && tankOk) return true;
    autoRunUntil = 0;
    lastAutoEnd = now;
  }
  return false;
}

// Valve opens first, then pump. Pump stops first, then valve closes.
void updateIrrigation(bool request, bool stopAll, unsigned long now) {
  enum State { IDLE, OPENING, RUNNING, STOPPING };
  static State st = IDLE;
  static unsigned long t0 = 0;

  if (stopAll) {
    setRelay(RELAY_MAIN_PUMP, false, gPumpOn);
    setRelay(RELAY_VALVE_IRRIG, false, gValveOn);
    st = IDLE;
    return;
  }

  switch (st) {
    case IDLE:
      if (request) { setRelay(RELAY_VALVE_IRRIG, true, gValveOn); t0 = now; st = OPENING; }
      break;
    case OPENING:
      if (!request) { setRelay(RELAY_VALVE_IRRIG, false, gValveOn); st = IDLE; }
      else if (now - t0 >= VALVE_LEAD_MS) { setRelay(RELAY_MAIN_PUMP, true, gPumpOn); st = RUNNING; }
      break;
    case RUNNING:
      if (!request) { setRelay(RELAY_MAIN_PUMP, false, gPumpOn); t0 = now; st = STOPPING; }
      break;
    case STOPPING:
      if (now - t0 >= VALVE_LEAD_MS) { setRelay(RELAY_VALVE_IRRIG, false, gValveOn); st = IDLE; }
      break;
  }
}

void runAutomation(unsigned long now) {
  Sensors s; Remote r; Targets t;
  LOCK(); s = gSensors; r = gRemote; t = gTargets; UNLOCK();

  bool stale   = (now - r.lastOk) > CLOUD_STALE_MS;
  bool stopAll = r.emergencyStop;
  bool manual  = r.manual && !stale;

  // ---- Fan ----
  static bool fanWanted = false;
  if (stopAll) {
    fanWanted = false;
  } else if (manual) {
    fanWanted = r.cooler;
  } else if (!isnan(s.temp)) {
    if (s.temp > t.tempMax) fanWanted = true;
    else if (s.temp < t.tempMax - FAN_HYSTERESIS) fanWanted = false;
  } else {
    fanWanted = false;
  }
  setRelay(RELAY_FAN, fanWanted, gFanOn);

  // ---- Fertilizer (manual only) ----
  setRelay(RELAY_FERT_PUMP, !stopAll && manual && r.fertilizer, gFertOn);

  // ---- Irrigation ----
  bool request = wantIrrigation(s, r, t, manual, stopAll, now);
  updateIrrigation(request, stopAll, now);
}

// ============================================================================
// BLE: Wi-Fi provisioning
//   App writes   {"ssid":"..","pass":"..","code":".."}\n   in small chunks
//   App reads    status: "ready" | "connecting" | "wifi_ok" | "error:..."
// ============================================================================
void setBleStatus(const char *text) {
  Serial.printf("[ble] status: %s\n", text);
  if (gStatusChar) {
    gStatusChar->setValue((uint8_t *)text, strlen(text));
    gStatusChar->notify();
  }
}

// Called from the BLE task when a full line has arrived. Never blocks:
// Wi-Fi is tried later by the cloud task.
void handleProvisionLine(const String &line) {
  static int badCodes = 0;
  static unsigned long lockedUntil = 0;

  if ((long)(lockedUntil - millis()) > 0) { setBleStatus("error:bad_code"); return; }

  JsonDocument doc;
  if (deserializeJson(doc, line)) { setBleStatus("error:bad_json"); return; }

  String code = doc["code"] | "";
  String ssid = doc["ssid"] | "";
  String pass = doc["pass"] | "";
  code.toUpperCase();

  if (code != String(CLAIM_CODE)) {
    if (++badCodes >= 5) { lockedUntil = millis() + 60000; badCodes = 0; }   // slow down guessing
    setBleStatus("error:bad_code");
    return;
  }
  badCodes = 0;

  if (ssid.length() == 0 || ssid.length() > 32 || pass.length() > 63) {
    setBleStatus("error:bad_ssid");
    return;
  }

  LOCK();
  strlcpy(gProv.ssid, ssid.c_str(), sizeof(gProv.ssid));
  strlcpy(gProv.pass, pass.c_str(), sizeof(gProv.pass));
  gProvPending = true;
  UNLOCK();
  setBleStatus("connecting");
}

class ProvCallbacks : public NimBLECharacteristicCallbacks {
  String buf;
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &connInfo) override {
    auto v = c->getValue();
    for (size_t i = 0; i < v.size(); i++) {
      char ch = (char)v.data()[i];
      if (ch == '\n') {
        String line = buf;
        buf = "";
        handleProvisionLine(line);
      } else if (buf.length() < 300) {
        buf += ch;
      } else {
        buf = "";
        setBleStatus("error:bad_json");
      }
    }
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *server, NimBLEConnInfo &connInfo) override {
    gBleConnected = true;
    gBleAdvertising = false;   // the stack stops advertising while connected
    Serial.println("[ble] phone connected");
  }
  void onDisconnect(NimBLEServer *server, NimBLEConnInfo &connInfo, int reason) override {
    gBleConnected = false;
    gBleAdvertising = false;   // manageBle() restarts it if still wanted
    Serial.println("[ble] phone disconnected");
  }
};

void startBle() {
  String name = "TerraSense-" + ghId.substring(6);   // "TS-GH-TEST01" -> "TerraSense-TEST01"
  NimBLEDevice::init(name.c_str());

  NimBLEServer *server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  server->advertiseOnDisconnect(false);

  NimBLEService *svc = server->createService(BLE_SERVICE_UUID);
  NimBLECharacteristic *prov = svc->createCharacteristic(
      BLE_PROV_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  prov->setCallbacks(new ProvCallbacks());

  gStatusChar = svc->createCharacteristic(
      BLE_STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  gStatusChar->setValue("ready");

  svc->start();

  // Advertising packet carries the service UUID; the name goes in the scan response
  // (a 128-bit UUID plus the name would not fit in one 31-byte packet).
  NimBLEAdvertisementData advData;
  advData.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
  advData.addServiceUUID(NimBLEUUID(BLE_SERVICE_UUID));
  NimBLEAdvertisementData scanData;
  scanData.setName(name.c_str());

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->setAdvertisementData(advData);
  adv->setScanResponseData(scanData);
  Serial.println("[ble] ready as " + name);
}

// Decides when BLE should advertise:
//   - never provisioned            -> always
//   - Wi-Fi up                     -> never (unless a phone is mid-session)
//   - Wi-Fi down for a while       -> repeating windows: BLE on, then a pause
void manageBle(unsigned long now, bool wifiUp) {
  static unsigned long downSince = 0;
  if (wifiUp) downSince = 0;
  else if (downSince == 0) downSince = now;

  bool want;
  if (BLE_ALWAYS_ON) {
    want = true;
  } else if (wifiUp) {
    want = false;
  } else if (wifiSsid.length() == 0) {
    want = true;
  } else {
    unsigned long down = now - downSince;
    want = down >= BLE_AFTER_DOWN_MS &&
           ((down - BLE_AFTER_DOWN_MS) % (BLE_WINDOW_MS + BLE_PAUSE_MS)) < BLE_WINDOW_MS;
  }
  if (gBleConnected) want = true;   // never cut off a phone that is connected

  if (want && !gBleAdvertising && !gBleConnected) {
    NimBLEDevice::getAdvertising()->start();
    gBleAdvertising = true;
    Serial.println("[ble] advertising ON");
  } else if (!want && gBleAdvertising) {
    NimBLEDevice::getAdvertising()->stop();
    gBleAdvertising = false;
    Serial.println("[ble] advertising OFF");
  }
}

// Tries credentials received over BLE. On success they are saved to flash.
// On failure the old network is restored so the hub is not left offline.
void applyProvisioning() {
  char ssid[33], pass[65];
  LOCK();
  strlcpy(ssid, gProv.ssid, sizeof(ssid));
  strlcpy(pass, gProv.pass, sizeof(pass));
  gProvPending = false;
  UNLOCK();

  Serial.printf("[prov] trying Wi-Fi \"%s\"\n", ssid);
  WiFi.disconnect();
  WiFi.begin(ssid, pass);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_JOIN_MS) {
    vTaskDelay(pdMS_TO_TICKS(250));
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiSsid = ssid;
    wifiPass = pass;
    prefs.putString("ssid", wifiSsid);
    prefs.putString("pass", wifiPass);
    Serial.println("[prov] Wi-Fi OK, credentials saved");
    setBleStatus("wifi_ok");
  } else {
    Serial.println("[prov] Wi-Fi failed");
    setBleStatus("error:wifi_failed");
    WiFi.disconnect();
    if (wifiSsid.length() > 0) WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  }
}

// ============================================================================
// CLOUD (runs on core 0)
// ============================================================================
void startFirebase() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // needed to work out the plant stage

  fbConfig.api_key = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;
  fbAuth.user.email = DEVICE_EMAIL;
  fbAuth.user.password = DEVICE_PASSWORD;
  fbConfig.token_status_callback = tokenStatusCallback;

  fbdo.setBSSLBufferSize(4096, 1024);
  fbdo.setResponseSize(4096);
  Firebase.reconnectWiFi(true);
  Firebase.begin(&fbConfig, &fbAuth);
}

// Publishes this hub's secret claim code so the app can claim it.
void registerDevice() {
  if (Firebase.RTDB.setString(&fbdo, "deviceRegistry/" + ghId + "/claimCode", CLAIM_CODE)) {
    registered = true;
    Serial.println("[cloud] registered " + ghId);
  } else {
    Serial.printf("[cloud] register failed: %s\n", fbdo.errorReason().c_str());
  }
}

void pollControls() {
  if (!Firebase.RTDB.get(&fbdo, BASE + "/controls")) {
    Serial.printf("[cloud] controls read failed: %s\n", fbdo.errorReason().c_str());
    return;
  }
  Remote r;
  JsonDocument doc;
  if (!deserializeJson(doc, fbdo.payload()) && doc.is<JsonObject>()) {
    r.manual        = doc["manual"] | false;
    r.emergencyStop = doc["emergencyStop"] | false;
    r.pump          = doc["pump"] | false;
    r.cooler        = doc["cooler"] | false;
    r.fertilizer    = doc["fertilizer"] | false;
  }
  r.lastOk = millis();
  LOCK(); gRemote = r; UNLOCK();
}

// ---- Plant cycle that survives reboots and Wi-Fi loss ----
// The plan is saved in flash whenever it changes in Firebase and loaded at boot. The stage keeps
// advancing by the hub's own clock while offline. Only removing the owner (see pollOwner) erases it.
String   gPlanJson = "";     // last plan read from Firebase (or loaded from flash)
uint32_t gSavedEpoch = 0;    // last real time stored in flash

void loadSavedPlan() {
  gPlanJson   = prefs.getString("plan", "");
  gSavedEpoch = prefs.getULong("epoch", 0);
}

void savePlan(const String &json) {
  if (json.length() == 0) prefs.remove("plan");
  else if (json.length() < 3500) prefs.putString("plan", json);
}

void saveClock() {
  time_t t = time(nullptr);
  if (t < 1700000000) return;            // NTP not synced yet
  gSavedEpoch = (uint32_t)t;
  prefs.putULong("epoch", gSavedEpoch);
}

// Real time once NTP has synced; before that, the saved time plus the seconds since boot.
time_t bestEpoch() {
  time_t t = time(nullptr);
  if (t > 1700000000) return t;
  if (gSavedEpoch > 0) return (time_t)(gSavedEpoch + millis() / 1000UL);
  return 0;
}

struct StageDef { int order; long days; float tempMax; float moistureMin; char name[24]; };

// Works out today's stage from the saved plan text and updates the targets
void applyPlan(const String &payload) {
  Targets t;   // defaults
  time_t nowS = bestEpoch();
  JsonDocument doc;

  if (nowS > 0 && payload.length() > 0 && !deserializeJson(doc, payload) && doc["stages"].is<JsonObject>()) {
    double startedAt = doc["startedAt"] | 0.0;
    StageDef stages[12];
    int n = 0;

    for (JsonPair kv : doc["stages"].as<JsonObject>()) {
      if (n >= 12) break;
      JsonObject s = kv.value().as<JsonObject>();
      stages[n].order = atoi(kv.key().c_str());
      stages[n].days = s["days"] | 0L;
      stages[n].tempMax = s["tempMax"] | DEFAULT_TEMP_MAX;
      stages[n].moistureMin = s["moistureMin"] | DEFAULT_MOISTURE_MIN;
      strlcpy(stages[n].name, s["name"] | "", sizeof(stages[n].name));
      n++;
    }
    // sort by the number in front of the key ("1-seedling", "2-vegetative", ...)
    for (int i = 1; i < n; i++) {
      StageDef x = stages[i]; int j = i - 1;
      while (j >= 0 && stages[j].order > x.order) { stages[j + 1] = stages[j]; j--; }
      stages[j + 1] = x;
    }

    if (n > 0 && startedAt > 0) {
      long day = (long)(((double)nowS * 1000.0 - startedAt) / 86400000.0) + 1;
      if (day < 1) day = 1;
      long end = 0;
      for (int i = 0; i < n; i++) {
        end += stages[i].days;
        if (day <= end) {
          t.havePlan = true;
          t.tempMax = stages[i].tempMax;
          t.moistureMin = stages[i].moistureMin;
          strlcpy(t.stageName, stages[i].name, sizeof(t.stageName));
          break;
        }
      }
    }
  }
  LOCK(); gTargets = t; UNLOCK();
}

void pollPlan() {
  if (!Firebase.RTDB.get(&fbdo, BASE + "/meta/plan")) {
    Serial.printf("[cloud] plan read failed: %s\n", fbdo.errorReason().c_str());
    return;                                   // failed read: keep the plan we already have
  }
  String payload = fbdo.payload();
  if (payload == "null") payload = "";        // plan stopped in the app
  if (payload != gPlanJson) {
    gPlanJson = payload;
    savePlan(payload);                        // empty text erases the saved copy
    Serial.println(payload.length() ? "[plan] saved to flash" : "[plan] cleared");
  }
  applyPlan(gPlanJson);
}

void pushLive() {
  Sensors s;
  LOCK(); s = gSensors; UNLOCK();

  FirebaseJson j;
  if (!isnan(s.temp)) j.set("temperature", round1(s.temp));
  if (!isnan(s.hum))  j.set("humidity", round1(s.hum));
  j.set("soilMoisture", round1(s.soilPct));
  j.set("soil1Raw", s.soil1);
  j.set("soil2Raw", s.soil2);
  if (s.lux >= 0)        j.set("lightLux", round1(s.lux));
  if (!isnan(s.tankPct)) j.set("waterTank", round1(s.tankPct));
  j.set("relays/pump", (bool)gPumpOn);
  j.set("relays/cooler", (bool)gFanOn);
  j.set("relays/fertilizer", (bool)gFertOn);
  j.set("updatedAt/.sv", "timestamp");

  if (!Firebase.RTDB.setJSON(&fbdo, BASE + "/live", &j)) {
    Serial.printf("[cloud] live write failed: %s\n", fbdo.errorReason().c_str());
  }
}

void pushHistory() {
  Sensors s;
  LOCK(); s = gSensors; UNLOCK();
  if (isnan(s.temp)) return;

  FirebaseJson h;
  h.set("temperature", round1(s.temp));
  if (!isnan(s.hum)) h.set("humidity", round1(s.hum));
  h.set("soilMoisture", round1(s.soilPct));
  if (s.lux >= 0) h.set("lightLux", round1(s.lux));
  h.set("ts/.sv", "timestamp");

  if (!Firebase.RTDB.pushJSON(&fbdo, BASE + "/history", &h)) {
    Serial.printf("[cloud] history write failed: %s\n", fbdo.errorReason().c_str());
  }
}

// Checks whether an app account owns this hub. While it has no owner the hub stays
// on Wi-Fi and keeps Bluetooth open, but stops uploading and following app commands.
void pollOwner() {
  if (!Firebase.RTDB.get(&fbdo, BASE + "/ownerUid")) {
    Serial.printf("[cloud] owner read failed: %s\n", fbdo.errorReason().c_str());
    return;   // keep the last known state
  }
  bool owned = (fbdo.dataType() == "string") && fbdo.stringData().length() > 0;
  if (owned == gOwned) return;

  gOwned = owned;
  if (!owned) {
    Serial.println("[cloud] no owner: uploads paused, waiting for the app to add this hub");
    // Forget the old owner's commands and plan so nothing stays stuck (e.g. emergency stop)
    LOCK(); gRemote = Remote(); gTargets = Targets(); UNLOCK();
    gPlanJson = "";      // the owner is gone, so their plant cycle ends with them
    savePlan("");
  } else {
    Serial.println("[cloud] hub has an owner again: uploads resumed");
  }
}

void cloudTask(void *) {
  unsigned long tWifi = 0, tControls = 0, tPlan = 0, tLive = 0, tHistory = 0, tReg = 0, tOwner = 0;
  unsigned long tTargets = 0, tClock = 0;
  bool fbStarted = false, uidPrinted = false;
  uint8_t lastRelays = 255;

  for (;;) {
    unsigned long now = millis();
    bool wifiUp = (WiFi.status() == WL_CONNECTED);

    // Keep the plant stage current even with no Wi-Fi, and remember the real time once an hour
    if (tTargets == 0 || now - tTargets >= 60000UL) { tTargets = now; applyPlan(gPlanJson); }
    if (time(nullptr) > 1700000000 && (tClock == 0 || now - tClock >= 3600000UL)) { tClock = now; saveClock(); }

    // BLE runs whether or not Wi-Fi works
    manageBle(now, wifiUp);
    if (gProvPending) { applyProvisioning(); continue; }

    if (!wifiUp) {
      if (wifiSsid.length() > 0 && (tWifi == 0 || now - tWifi > WIFI_RETRY_MS)) {
        tWifi = now;
        Serial.println("[wifi] reconnecting...");
        WiFi.disconnect();
        WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
      }
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    if (!fbStarted) { startFirebase(); fbStarted = true; }
    if (!Firebase.ready()) { vTaskDelay(pdMS_TO_TICKS(250)); continue; }

    if (!uidPrinted) {
      uidPrinted = true;
      Serial.printf("[cloud] hub UID: %s\n", fbAuth.token.uid.c_str());
      Serial.println("[cloud] using ID: " + ghId);
    }

    // Make the hub claimable from the app (retries every 30 s until it succeeds)
    if (!registered && (tReg == 0 || now - tReg > 30000)) { tReg = now; registerDevice(); }

    // No owner (removed from the app, or never added): stay online, Bluetooth stays open,
    // but do not upload data or read commands. Check again every few seconds.
    if (tOwner == 0 || now - tOwner >= OWNER_INTERVAL_MS) { tOwner = now; pollOwner(); }
    if (!gOwned) { vTaskDelay(pdMS_TO_TICKS(250)); continue; }

    // Push /live immediately when a relay changes, so the app doesn't lag
    uint8_t cur = (gPumpOn ? 1 : 0) | (gFanOn ? 2 : 0) | (gFertOn ? 4 : 0);
    if (cur != lastRelays) { lastRelays = cur; tLive = 0; }

    if (tControls == 0 || now - tControls >= CONTROLS_INTERVAL_MS) { tControls = now; pollControls(); }
    if (tPlan == 0     || now - tPlan     >= PLAN_INTERVAL_MS)     { tPlan = now;     pollPlan(); }
    if (tLive == 0     || now - tLive     >= LIVE_INTERVAL_MS)     { tLive = now;     pushLive(); }
    if (tHistory == 0  || now - tHistory  >= HISTORY_INTERVAL_MS)  { tHistory = now;  pushHistory(); }

    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ============================================================================
// SETUP / LOOP
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("\n=============================================="));
  Serial.println(F("         TERRASENSE HUB BOOTING"));
  Serial.println(F("=============================================="));

  // Relays: set OFF first, then become outputs
  const int relays[] = {RELAY_MAIN_PUMP, RELAY_VALVE_IRRIG, RELAY_FERT_PUMP, RELAY_FAN};
  for (int p : relays) { digitalWrite(p, RELAY_OFF); pinMode(p, OUTPUT); digitalWrite(p, RELAY_OFF); }

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setTimeOut(1000);
  dht.begin();

  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire)) {
    bhOk = true; Serial.println(F("[OK] BH1750 at 0x23"));
  } else if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x5C, &Wire)) {
    bhOk = true; Serial.println(F("[OK] BH1750 at 0x5C"));
  } else {
    Serial.println(F("[WARNING] BH1750 not found, light sensor skipped"));
  }

  pinMode(US_TRIG, OUTPUT);
  pinMode(US_ECHO, INPUT);
  digitalWrite(US_TRIG, LOW);

  // Identity
  WiFi.mode(WIFI_STA);
  if (strlen(GH_ID_OVERRIDE) > 0) {
    ghId = GH_ID_OVERRIDE;
  } else {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char buf[20];
    snprintf(buf, sizeof(buf), "TS-GH-%02X%02X%02X", mac[3], mac[4], mac[5]);
    ghId = buf;
  }
  BASE = "greenhouses/" + ghId;
  Serial.println("Greenhouse ID : " + ghId);
  Serial.println("Claim code    : " CLAIM_CODE);
  Serial.println("Registry path : deviceRegistry/" + ghId);

  gMutex = xSemaphoreCreateMutex();

  // Wi-Fi credentials saved by an earlier BLE setup
  prefs.begin("terrasense", false);
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
#ifdef WIFI_SSID
  if (wifiSsid.length() == 0 && USE_SECRETS_WIFI_FALLBACK) {
    wifiSsid = WIFI_SSID;
    wifiPass = WIFI_PASSWORD;
  }
#endif

  // Plant cycle saved before the last power-off: use it straight away, even with no Wi-Fi
  loadSavedPlan();
  applyPlan(gPlanJson);
  Serial.println(gPlanJson.length() ? "Saved plan    : loaded from flash" : "Saved plan    : none");

  startBle();

  WiFi.setAutoReconnect(true);
  if (wifiSsid.length() > 0) {
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    Serial.print("Connecting to Wi-Fi \"" + wifiSsid + "\"");
    for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
    Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " not yet (will keep trying in the background)");
  } else {
    Serial.println("No Wi-Fi saved: waiting for setup from the app over Bluetooth");
  }

  xTaskCreatePinnedToCore(cloudTask, "cloud", 24576, nullptr, 1, nullptr, 0);

  Serial.println(F("=== LOCAL CONTROL RUNNING ===\n"));
}

void loop() {
  static unsigned long tSensors = 0;
  unsigned long now = millis();

  if (tSensors == 0 || now - tSensors >= SENSOR_INTERVAL_MS) {
    tSensors = now;
    readSensors();

    Sensors s;
    Targets t;
    LOCK(); s = gSensors; t = gTargets; UNLOCK();
    Serial.println(F("----------------------------------------------"));
    if (isnan(s.temp)) Serial.println(F("Temp/Hum : DHT22 read failure"));
    else Serial.printf("Temp %.1f C | Hum %.1f %%\n", s.temp, s.hum);
    Serial.printf("Soil %d / %d ADC -> %.0f %% / %.0f %%\n", s.soil1, s.soil2, s.soilPct1, s.soilPct2);
    if (s.lux >= 0) Serial.printf("Light %.0f lux\n", s.lux);
    if (isnan(s.tankPct)) Serial.println(F("Tank : no sensor reading"));
    else Serial.printf("Tank %.1f cm -> %.0f %%\n", s.tankDist, s.tankPct);
    Serial.printf("Targets: %s | fan above %.1f C, irrigate below %.0f %%\n",
                  t.havePlan ? t.stageName : "defaults (no plant cycle)", t.tempMax, t.moistureMin);
    Serial.printf("Relays: pump=%d valve=%d fan=%d fert=%d | wifi=%s ble=%s owner=%s\n",
                  gPumpOn, gValveOn, gFanOn, gFertOn,
                  WiFi.status() == WL_CONNECTED ? "ok" : "down",
                  gBleConnected ? "connected" : (gBleAdvertising ? "advertising" : "off"),
                  gOwned ? "yes" : "none");
  }

  runAutomation(now);   // every pass, so valve/pump timing stays accurate
  delay(20);
}
