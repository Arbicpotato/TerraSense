// ============================================================================
//  TerraSense Hub (ESP32): local greenhouse control + Firebase link to the app
//
//  Core 1 (loop):  sensors, relays and automation. Runs even with no Wi-Fi.
//  Core 0 (task):  Wi-Fi, Firebase, uploads to /live and /history,
//                  reads /controls and the active plant stage from /meta/plan,
//                  registers the hub in /deviceRegistry so the app can claim it.
//
//  Libraries: Firebase Arduino Client Library for ESP8266 and ESP32 (mobizt),
//             ArduinoJson 7.x, DHT sensor library + Adafruit Unified Sensor,
//             BH1750 (Christopher Laws)
//
//  secrets.h must define:
//    WIFI_SSID, WIFI_PASSWORD
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
#include <time.h>
#include <BH1750.h>
#include <DHT.h>
#include <ArduinoJson.h>
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

Sensors gSensors;
Remote  gRemote;
Targets gTargets;
volatile bool gPumpOn = false, gValveOn = false, gFanOn = false, gFertOn = false;
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

struct StageDef { int order; long days; float tempMax; float moistureMin; char name[24]; };

void pollPlan() {
  if (!Firebase.RTDB.get(&fbdo, BASE + "/meta/plan")) {
    Serial.printf("[cloud] plan read failed: %s\n", fbdo.errorReason().c_str());
    return;
  }

  Targets t;   // defaults
  JsonDocument doc;
  time_t nowS = time(nullptr);

  if (!deserializeJson(doc, fbdo.payload()) && doc["stages"].is<JsonObject>() && nowS > 1700000000) {
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
  h.set("ts/.sv", "timestamp");

  if (!Firebase.RTDB.pushJSON(&fbdo, BASE + "/history", &h)) {
    Serial.printf("[cloud] history write failed: %s\n", fbdo.errorReason().c_str());
  }
}

void cloudTask(void *) {
  unsigned long tWifi = 0, tControls = 0, tPlan = 0, tLive = 0, tHistory = 0;
  bool fbStarted = false;
  uint8_t lastRelays = 255;

  for (;;) {
    unsigned long now = millis();

    if (WiFi.status() != WL_CONNECTED) {
      if (tWifi == 0 || now - tWifi > 30000) {
        tWifi = now;
        Serial.println("[wifi] reconnecting...");
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      }
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    if (!fbStarted) { startFirebase(); fbStarted = true; }
    if (!Firebase.ready()) { vTaskDelay(pdMS_TO_TICKS(250)); continue; }

    static bool uidPrinted = false;
if (!uidPrinted) {
  uidPrinted = true;
  Serial.printf("[cloud] hub UID: %s\n", fbAuth.token.uid.c_str());
  Serial.println("[cloud] using ID: " + ghId);
}
    

    // Make the hub claimable from the app (retries until it succeeds)
    static unsigned long tReg = 0;
  if (!registered && (tReg == 0 || now - tReg > 30000)) { tReg = now; registerDevice(); }

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

  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " not yet (will keep trying in the background)");

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
    Serial.printf("Relays: pump=%d valve=%d fan=%d fert=%d | wifi=%s\n",
                  gPumpOn, gValveOn, gFanOn, gFertOn, WiFi.status() == WL_CONNECTED ? "ok" : "down");
  }

  runAutomation(now);   // every pass, so valve/pump timing stays accurate
  delay(20);
}
