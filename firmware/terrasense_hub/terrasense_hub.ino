// ============================================================================
//  TerraSense Hub (ESP32): local greenhouse control + Firebase link to the app
//
//  Core 1 (loop):  sensors, FUZZY decisions, relays. Runs even with no Wi-Fi.
//  Core 0 (task):  Wi-Fi, BLE provisioning, Firebase, uploads to /live and
//                  /history, reads /controls and the plant stage from /meta/plan,
//                  registers the hub in /deviceRegistry so the app can claim it.
//
//  NO HARDCODED TARGETS
//    Every target range (temperature, soil moisture, humidity, light, light hours,
//    feeding interval) comes from the plant plan in Firebase (/meta/plan). The hub
//    downloads it every minute and keeps a copy in LOCAL STORAGE:
//      STORAGE_USB: your PC over the USB cable (run pc_usb_store.py; it also works as the serial monitor)
//      STORAGE_SD : a TF card module (set STORAGE_BACKEND below when it arrives)
//    Without a plan the hub only reads sensors and idles: no automatic actuation.
//    Manual mode and emergency stop still work.
//
//  PLANT LIBRARY (local copies)
//    When the user taps "Add to my plants" in the app, the app writes the plant's profile to
//    /library/<plantId>. The hub notices within LIBRARY_INTERVAL_MS, downloads each new profile and
//    stores it in local storage (plant_<plantId>.json), then reports the stored ids in /live/library/ids
//    straight away so the app can show "Stored on hub". When the user starts a cycle the app
//    writes /meta/plan = {plantId, startedAt}, and the stages are read from the LOCAL profile.
//    (A plan that carries its stages inline, the old format, still works.)
//
//  PHOTOPERIOD (grow light)
//    /meta/dayStart ({minutes, tzOffsetMin}) is the "start of the day" set in the app.
//    From that moment the grow light may run for the current stage's lightHours,
//    then stays off until the next day start.
//    LIGHT_FULL_PHOTOPERIOD = true  : lights stay on for the whole window.
//    LIGHT_FULL_PHOTOPERIOD = false : lights only top up light inside the window (lux-driven).
//
//  CONTROL LOGIC (automatic mode)
//    Two fuzzy inference systems (FIS) run every sensor pass:
//      - Irrigation FIS : soil moisture + temperature  -> watering duration (s)
//      - Climate FIS    : temperature + humidity + light -> fan, evaporative
//                         mister, compressor, heater, grow light (0-100 score each)
//    Each reading is converted to a "deviation from the current growth stage's
//    target range" (0 = inside the range, -1 = one range width below, +1 = above).
//    Fertilizing follows the stage's "feed every N days" schedule.
//
//  Wi-Fi setup over Bluetooth (BLE):
//    - Wi-Fi credentials are stored in flash (NVS). No credentials -> BLE is
//      always advertising so the app can send them.
//
//  Libraries: Firebase Arduino Client Library for ESP8266 and ESP32 (mobizt),
//             ArduinoJson 7.x, DHT sensor library + Adafruit Unified Sensor,
//             BH1750 (Christopher Laws), NimBLE-Arduino 2.x (h2zero),
//             eFLL "Fuzzy" (Alexandre Alves / Robotic-Cortex)
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
//  WIRING NOTES
//   - HC-SR04 ECHO outputs 5 V. Put a divider (1k + 2k) on GPIO 19.
//   - GPIO 12 and 15 are ESP32 boot-strapping pins, so the compressor and grow
//     light are on GPIO 16 and 17 here. Change the #defines if your wiring differs.
//   - TF card: use its own SPI pins (GPIO 18/19 are the ultrasonic sensor).
// ============================================================================
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <Preferences.h>
#include <time.h>
#include <initializer_list>
#include <BH1750.h>
#include <DHT.h>
#include <ArduinoJson.h>
#include <Fuzzy.h>
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
#define RELAY_EVAP        14   // Relay 5: evaporative cooling pump / mister (shown as "Humidifier")
#define RELAY_COMPRESSOR  16   // Relay 6: compressor cooling unit (part of "Cooling")
#define RELAY_HEATER      13   // Relay 7: heating element
#define RELAY_LIGHT       17   // Relay 8: supplemental grow lights

#define RELAY_ON          LOW  // active LOW
#define RELAY_OFF         HIGH

// ============================================================================
// SETTINGS (calibrate these with your own hardware)
// ============================================================================
// Soil sensors: raw ADC with the probe in AIR (0 %) and in WATER (100 %).
const int   SOIL_AIR_ADC     = 3400;
const int   SOIL_WATER_ADC   = 1400;

// Water tank: distance from the ultrasonic sensor to the water surface.
const float TANK_EMPTY_CM    = 30.0;
const float TANK_FULL_CM     = 5.0;
const float TANK_MIN_PERCENT = 10.0;   // pump is blocked below this level
const bool  REQUIRE_TANK_SENSOR_FOR_PUMP = false;

// Fuzzy -> relay conversion
const float ACT_ON_SCORE  = 30.0;   // relay turns ON above this FIS score (0-100)
const float ACT_OFF_SCORE = 15.0;   // and OFF below this (hysteresis)
const unsigned long COMPRESSOR_MIN_ON_MS  = 60UL * 1000UL;
const unsigned long COMPRESSOR_MIN_OFF_MS = 3UL * 60UL * 1000UL;   // protects the compressor
const unsigned long CLIMATE_MIN_DWELL_MS  = 30UL * 1000UL;         // fan / heater / mister
const unsigned long LIGHT_MIN_DWELL_MS    = 60UL * 1000UL;
// Cooling ladder (automatic mode): the exhaust fan always comes first. The compressor ("cooler") joins in when
//   - the temperature is far above the stage's maximum:  more than COOLER_ON_FRACTION of the stage's temperature
//     range (limited to COOLER_ON_MIN_DELTA..COOLER_ON_MAX_DELTA degrees), or
//   - the fan has had FAN_TRIAL_MS to work, the temperature is still above the maximum, and it has not fallen
//     by at least FAN_MIN_DROP degrees since the fan started (the fan alone is not enough).
// Both stop once the temperature is COOLER_RELEASE_MARGIN below the stage's maximum.
const float COOLER_ON_FRACTION    = 0.25f;
const float COOLER_ON_MIN_DELTA   = 1.5f;
const float COOLER_ON_MAX_DELTA   = 4.0f;
const unsigned long FAN_TRIAL_MS  = 4UL * 60UL * 1000UL;
const float FAN_MIN_DROP          = 0.4f;
const float COOLER_TRIAL_DELTA    = 0.5f;
const float COOLER_RELEASE_MARGIN = 0.5f;
const bool  LIGHT_FULL_PHOTOPERIOD        = true;   // true = lights on for the whole photoperiod window,
                                                    // false = only when the light is below the stage minimum

// One FIS-driven relay: hysteresis on the score plus minimum on/off times
struct Actuator {
  bool on = false;
  unsigned long changedAt = 0;
  unsigned long minOn, minOff;
  Actuator(unsigned long onMs, unsigned long offMs) : minOn(onMs), minOff(offMs) {}
};
Actuator actFan(CLIMATE_MIN_DWELL_MS, CLIMATE_MIN_DWELL_MS);
Actuator actEvap(CLIMATE_MIN_DWELL_MS, CLIMATE_MIN_DWELL_MS);
Actuator actComp(COMPRESSOR_MIN_ON_MS, COMPRESSOR_MIN_OFF_MS);
Actuator actHeat(CLIMATE_MIN_DWELL_MS, CLIMATE_MIN_DWELL_MS);
Actuator actLight(LIGHT_MIN_DWELL_MS, LIGHT_MIN_DWELL_MS);

// Irrigation
const float SOIL_TRIGGER_DEV      = -0.1f;  // water only when soil is this far below the stage minimum
                                            // (-0.1 = 10 % of the target band width below it)
const float SOIL_SENSOR_MAX_DIFF  = 40.0f;  // probes disagree by more than this (%) -> do not auto-water
const unsigned long AUTO_COOLDOWN_MS     = 10UL * 60UL * 1000UL; // min gap between automatic bursts
const unsigned long VALVE_LEAD_MS        = 500;                  // valve opens before pump, closes after
const unsigned long MANUAL_PUMP_MAX_MS   = 5UL * 60UL * 1000UL;  // safety cut-off for manual pump
const unsigned long CLOUD_STALE_MS       = 2UL * 60UL * 1000UL;  // no controls update -> leave manual mode

// Fertilizing (automatic, from the stage's feedEveryDays)
const unsigned long FERT_RUN_MS   = 8000;   // fertilizer pump ON time per feed
const unsigned long FERT_FLUSH_MS = 3000;   // water keeps flowing this long after the dose
const bool FERT_USES_IRRIGATION_LINE = true; // true = open valve + main pump during a feed so the
                                             // fertilizer is carried to the plants

// Timing
const unsigned long SENSOR_INTERVAL_MS   = 5000;
const unsigned long CONTROLS_INTERVAL_MS = 1500;   // how often the hub reads the app's switches (/controls)
const unsigned long PLAN_INTERVAL_MS     = 60000;
const unsigned long LIBRARY_INTERVAL_MS  = 10000;   // how often /library is checked for newly added plants (a keys-only request)
const unsigned long LIVE_INTERVAL_MS     = 30000;
const unsigned long HISTORY_INTERVAL_MS  = 5UL * 60UL * 1000UL;
const unsigned long OWNER_INTERVAL_MS    = 15000;
const unsigned long DAYSTART_INTERVAL_MS = 30000;

// Wi-Fi / BLE behaviour
const bool          USE_SECRETS_WIFI_FALLBACK = false;
const bool          BLE_ALWAYS_ON = true;
const unsigned long WIFI_RETRY_MS     = 30000;
const unsigned long BLE_AFTER_DOWN_MS = 60000;
const unsigned long BLE_WINDOW_MS     = 120000;
const unsigned long BLE_PAUSE_MS      = 60000;
const unsigned long WIFI_JOIN_MS      = 20000;

// BLE UUIDs: must match the app (App.tsx)
#define BLE_SERVICE_UUID  "7e1a0001-5c0b-4b8e-9d3a-2f4b6c7d8e90"
#define BLE_PROV_UUID     "7e1a0002-5c0b-4b8e-9d3a-2f4b6c7d8e90"
#define BLE_STATUS_UUID   "7e1a0003-5c0b-4b8e-9d3a-2f4b6c7d8e90"

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
  bool heater = false, humidifier = false, lights = false;
  unsigned long lastOk = 0;
};

struct Targets {                // from the current stage in /meta/plan. No defaults: zeros until a plan is loaded.
  bool  havePlan = false;
  float tempMin = 0, tempMax = 0;
  float moistureMin = 0, moistureMax = 0;
  float humMin = 0, humMax = 0;
  float luxMin = 0, luxMax = 0;
  float lightHours = 0;
  int   feedEveryDays = 0;
  char  stageName[24] = "";
  char  plantName[32] = "";
  int   stageNum = 0, stageCount = 0;
  long  cycleDay = 0, cycleDays = 0;
};

struct DayCfg {                 // from /meta/dayStart (set in the app's insights page)
  bool set = false;             // false = not set, the hub uses midnight UTC
  int  minutes = 0;             // local time the day starts, in minutes after midnight
  int  tzOffsetMin = 0;         // the phone's UTC offset when it was saved (e.g. +330 for India)
};

// What the hub is doing and why. Published to /live for the app's Actions page.
// An empty text means that actuator is idle.
struct Status {
  char  mode[10] = "auto";                  // auto | manual | stopped
  char  pump[80] = "", fert[80] = "", cool[80] = "", heat[80] = "", hum[80] = "", light[80] = "";
  char  blocked[72] = "";                   // why something that should run cannot (tank low, cooldown...)
  char  warn[72] = "";                      // sensor problems
  float irrigSec = 0, fan = 0, evap = 0, comp = 0, heater = 0, lightScore = 0;   // FIS outputs
  float fertDueH = -1;                      // hours until the next scheduled feed (-1 = no schedule)
  bool  photoOpen = false;                  // grow-light window is open right now
  float photoHours = 0;                     // length of the window (the stage's light hours)
  int   photoLeftMin = 0;                   // minutes left in the window
  int   photoStartsMin = -1;                // minutes until the next window opens (-1 = unknown)
};

struct Provision {
  char ssid[33] = "";
  char pass[65] = "";
};

Sensors gSensors;
Remote  gRemote;
Targets gTargets;
Status  gStatus;
Provision gProv;
DayCfg  gDay;
volatile bool gProvPending = false;
volatile bool gPumpOn = false, gValveOn = false, gFanOn = false, gFertOn = false;
volatile bool gEvapOn = false, gCompOn = false, gHeatOn = false, gLightOn = false;
volatile bool gBleConnected = false, gBleAdvertising = false;
volatile bool gOwned = true;
volatile uint32_t gLastFeed = 0;     // epoch of the last fertilizer feed (0 = none yet)
volatile bool gFeedDirty = false;    // cloud task saves it to flash
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
String wifiSsid, wifiPass;
NimBLECharacteristic *gStatusChar = nullptr;

String ghId;
String BASE;   // "greenhouses/<ghId>"
bool registered = false;

// ============================================================================
// LOCAL STORAGE (plant plan)
//   STORAGE_USB: files live on your PC, reached over the USB cable (run pc_usb_store.py)
//   STORAGE_SD : files live on a TF card module
// ============================================================================
#define STORAGE_USB 1
#define STORAGE_SD  2
#define STORAGE_BACKEND STORAGE_USB     // change to STORAGE_SD when the TF card module is wired

const char *PLAN_FILE = "plan.json";
volatile bool gUsbBusy = false;         // loop() stays quiet on Serial during a USB exchange

#if STORAGE_BACKEND == STORAGE_USB

// Talks to pc_usb_store.py over the same USB serial port used for logging.
// No Wi-Fi needed, so the plan is available at boot and survives Wi-Fi loss.
// If the script is not running, each call waits USB_TIMEOUT_MS and then fails.
const unsigned long USB_TIMEOUT_MS = 2000;

void storageBegin() {}

uint32_t crc32Of(const String &s) {     // same CRC-32 as Python's zlib.crc32
  uint32_t c = 0xFFFFFFFF;
  for (size_t i = 0; i < s.length(); i++) {
    c ^= (uint8_t)s[i];
    for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320UL & (0 - (c & 1)));
  }
  return ~c;
}

// Waits for the PC's reply line (starts with '@'); anything else is ignored
bool usbReply(String &line) {
  unsigned long t0 = millis();
  line = "";
  while (millis() - t0 < USB_TIMEOUT_MS) {
    while (Serial.available()) {
      char c = (char)Serial.read();
      if (c == '\n') {
        line.trim();
        if (line.startsWith("@")) return true;
        line = "";
      } else if (line.length() < 80) {
        line += c;
      }
    }
    delay(2);
  }
  return false;
}

bool storageRead(const char *name, String &out) {
  gUsbBusy = true;
  while (Serial.available()) Serial.read();
  Serial.printf("\n@GET %s\n", name);
  bool ok = false;
  String line;
  if (usbReply(line) && line.startsWith("@OK ")) {
    int sp = line.indexOf(' ', 4);
    if (sp > 4) {
      int len = line.substring(4, sp).toInt();
      uint32_t crc = strtoul(line.substring(sp + 1).c_str(), nullptr, 10);
      if (len > 0 && len <= 8000) {
        String data;
        data.reserve(len);
        unsigned long t0 = millis();
        while ((int)data.length() < len && millis() - t0 < USB_TIMEOUT_MS) {
          while (Serial.available() && (int)data.length() < len) { data += (char)Serial.read(); t0 = millis(); }
          delay(1);
        }
        if ((int)data.length() == len && crc32Of(data) == crc) { out = data; ok = true; }
      }
    }
  }
  gUsbBusy = false;
  return ok;
}

bool storageWrite(const char *name, const String &data) {
  gUsbBusy = true;
  while (Serial.available()) Serial.read();
  Serial.printf("\n@PUT %s %u %lu\n", name, (unsigned)data.length(), (unsigned long)crc32Of(data));
  Serial.write((const uint8_t *)data.c_str(), data.length());
  Serial.flush();
  String line;
  bool ok = usbReply(line) && line.startsWith("@OK");
  gUsbBusy = false;
  return ok;
}

void storageRemove(const char *name) {
  gUsbBusy = true;
  while (Serial.available()) Serial.read();
  Serial.printf("\n@DEL %s\n", name);
  String line;
  usbReply(line);
  gUsbBusy = false;
}

#else  // STORAGE_SD

#include <SD.h>
#include <SPI.h>
#define SD_CS   -1   // fill in free pins (GPIO 34/36/39 are input-only: fine for MISO)
#define SD_SCK  -1
#define SD_MISO -1
#define SD_MOSI -1
SPIClass sdSpi(HSPI);

void storageBegin() {
  sdSpi.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  if (!SD.begin(SD_CS, sdSpi)) Serial.println(F("[WARNING] TF card not found, plan will not be saved"));
}

bool storageRead(const char *name, String &out) {
  File f = SD.open(String("/") + name, FILE_READ);
  if (!f) return false;
  out = f.readString();
  f.close();
  return true;
}

bool storageWrite(const char *name, const String &data) {
  File f = SD.open(String("/") + name, FILE_WRITE);
  if (!f) return false;
  size_t n = f.print(data);
  f.close();
  return n == data.length();
}

void storageRemove(const char *name) { SD.remove(String("/") + name); }

#endif

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
// FUZZY LOGIC (eFLL)
//   Every input is the deviation from the stage's target range, in range widths:
//     0 = inside the range, -1 = one range width below, +1 = one range width above.
//   So the sets below never change; only the inputs follow the plant stage.
// ============================================================================
Fuzzy *fisIrrigation = nullptr;
Fuzzy *fisClimate    = nullptr;

struct FisOut {
  float irrigSec = 0, fan = 0, evap = 0, comp = 0, heater = 0, light = 0;
};
FisOut gFis;   // written and read by the loop task only

float dev(float v, float lo, float hi, float minSpan) {
  float span = hi - lo;
  if (span < minSpan) span = minSpan;
  float d = 0;
  if (v < lo) d = (v - lo) / span;
  else if (v > hi) d = (v - hi) / span;
  return constrain(d, -3.0f, 3.0f);
}

// Three shapes shared by every input: Low / Ok / High
FuzzyInput *makeDevInput(int index, FuzzySet **low, FuzzySet **ok, FuzzySet **high) {
  FuzzyInput *in = new FuzzyInput(index);
  *low  = new FuzzySet(-3.0, -3.0, -0.5, 0.0);
  *ok   = new FuzzySet(-0.5,  0.0,  0.0, 0.5);
  *high = new FuzzySet( 0.0,  0.5,  3.0, 3.0);
  in->addFuzzySet(*low);
  in->addFuzzySet(*ok);
  in->addFuzzySet(*high);
  return in;
}

// Off / On shapes for the 0-100 relay scores
FuzzyOutput *makeOnOffOutput(int index, FuzzySet **off, FuzzySet **on) {
  FuzzyOutput *out = new FuzzyOutput(index);
  *off = new FuzzySet(0, 0, 0, 1);
  *on  = new FuzzySet(40, 70, 100, 100);
  out->addFuzzySet(*off);
  out->addFuzzySet(*on);
  return out;
}

void ruleSingle(Fuzzy *f, int id, FuzzySet *a, std::initializer_list<FuzzySet *> outs) {
  FuzzyRuleAntecedent *in = new FuzzyRuleAntecedent(); in->joinSingle(a);
  FuzzyRuleConsequent *out = new FuzzyRuleConsequent();
  for (FuzzySet *o : outs) out->addOutput(o);
  f->addFuzzyRule(new FuzzyRule(id, in, out));
}
void ruleAnd(Fuzzy *f, int id, FuzzySet *a, FuzzySet *b, std::initializer_list<FuzzySet *> outs) {
  FuzzyRuleAntecedent *in = new FuzzyRuleAntecedent(); in->joinWithAND(a, b);
  FuzzyRuleConsequent *out = new FuzzyRuleConsequent();
  for (FuzzySet *o : outs) out->addOutput(o);
  f->addFuzzyRule(new FuzzyRule(id, in, out));
}
void ruleOr(Fuzzy *f, int id, FuzzySet *a, FuzzySet *b, std::initializer_list<FuzzySet *> outs) {
  FuzzyRuleAntecedent *in = new FuzzyRuleAntecedent(); in->joinWithOR(a, b);
  FuzzyRuleConsequent *out = new FuzzyRuleConsequent();
  for (FuzzySet *o : outs) out->addOutput(o);
  f->addFuzzyRule(new FuzzyRule(id, in, out));
}

// ---- FIS 1: irrigation  (soil, temperature -> watering seconds) ----
void buildIrrigationFIS() {
  fisIrrigation = new Fuzzy();
  FuzzySet *sDry, *sOk, *sWet, *tCold, *tOk, *tHot;
  fisIrrigation->addFuzzyInput(makeDevInput(1, &sDry, &sOk, &sWet));
  fisIrrigation->addFuzzyInput(makeDevInput(2, &tCold, &tOk, &tHot));

  FuzzyOutput *water = new FuzzyOutput(1);            // seconds, 0..10
  FuzzySet *none   = new FuzzySet(0, 0, 0, 1);
  FuzzySet *shortW = new FuzzySet(1, 3, 3, 5);
  FuzzySet *medW   = new FuzzySet(3, 5, 5, 7);
  FuzzySet *longW  = new FuzzySet(6, 8, 10, 10);
  water->addFuzzySet(none);
  water->addFuzzySet(shortW);
  water->addFuzzySet(medW);
  water->addFuzzySet(longW);
  fisIrrigation->addFuzzyOutput(water);

  ruleSingle(fisIrrigation, 1, sWet, {none});                 // too wet: never water
  ruleSingle(fisIrrigation, 2, sOk,  {none});                 // inside the target range: no water
  ruleAnd(fisIrrigation, 3, sDry, tCold, {shortW});           // dry, cold: slow evaporation, gentle
  ruleAnd(fisIrrigation, 4, sDry, tOk,   {medW});
  ruleAnd(fisIrrigation, 5, sDry, tHot,  {longW});            // dry and hot: water the most
}

// ---- FIS 2: climate  (temperature, humidity, light -> 5 relay scores) ----
void buildClimateFIS() {
  fisClimate = new Fuzzy();
  FuzzySet *tCold, *tOk, *tHot, *hLow, *hOk, *hHigh, *lDark, *lOk, *lBright;
  fisClimate->addFuzzyInput(makeDevInput(1, &tCold, &tOk, &tHot));
  fisClimate->addFuzzyInput(makeDevInput(2, &hLow, &hOk, &hHigh));
  fisClimate->addFuzzyInput(makeDevInput(3, &lDark, &lOk, &lBright));

  // Fan has a low and a high speed set (as in the original), the rest are On/Off
  FuzzyOutput *outFan = new FuzzyOutput(1);
  FuzzySet *fanOff  = new FuzzySet(0, 0, 0, 1);
  FuzzySet *fanLow  = new FuzzySet(10, 35, 35, 60);
  FuzzySet *fanHigh = new FuzzySet(50, 80, 100, 100);
  outFan->addFuzzySet(fanOff);
  outFan->addFuzzySet(fanLow);
  outFan->addFuzzySet(fanHigh);
  fisClimate->addFuzzyOutput(outFan);

  FuzzySet *evapOff, *evapOn, *compOff, *compOn, *heatOff, *heatOn, *lightOff, *lightOn;
  fisClimate->addFuzzyOutput(makeOnOffOutput(2, &evapOff, &evapOn));
  fisClimate->addFuzzyOutput(makeOnOffOutput(3, &compOff, &compOn));
  fisClimate->addFuzzyOutput(makeOnOffOutput(4, &heatOff, &heatOn));
  fisClimate->addFuzzyOutput(makeOnOffOutput(5, &lightOff, &lightOn));

  // Temperature + humidity
  ruleSingle(fisClimate, 1, tCold, {heatOn, fanOff, compOff, evapOff});
  ruleAnd(fisClimate, 2, tHot, hLow,  {fanLow, evapOn, compOff, heatOff});     // hot & dry: evaporative cooling
  ruleAnd(fisClimate, 3, tHot, hHigh, {fanHigh, compOn, evapOff, heatOff});    // hot & humid: compressor
  ruleAnd(fisClimate, 4, tHot, hOk,   {fanLow, compOff, evapOff, heatOff});    // hot, humidity fine: ventilate
  ruleAnd(fisClimate, 5, tOk, hOk,    {fanOff, compOff, evapOff});             // everything fine
  ruleAnd(fisClimate, 6, tOk, hHigh,  {fanLow, compOff, evapOff});             // too humid: ventilate
  ruleAnd(fisClimate, 7, tOk, hLow,   {evapOn, fanOff, compOff});              // too dry: mist
  ruleOr(fisClimate, 8, tOk, tHot,    {heatOff});
  // Light
  ruleSingle(fisClimate, 9,  lDark, {lightOn});
  ruleOr(fisClimate, 10, lOk, lBright, {lightOff});
}

void buildFuzzy() {
  buildIrrigationFIS();
  buildClimateFIS();
}

// Runs both FIS with the current readings and the current stage's targets
void evaluateFuzzy(const Sensors &s, const Targets &t) {
  FisOut o;

  float soilDev = dev(s.soilPct, t.moistureMin, t.moistureMax, 10.0f);
  float tDev    = isnan(s.temp) ? 0.0f : dev(s.temp, t.tempMin, t.tempMax, 4.0f);
  float hDev    = isnan(s.hum)  ? 0.0f : dev(s.hum, t.humMin, t.humMax, 10.0f);
  // light spans decades, so it is judged on a log scale
  float lDev    = (s.lux < 0) ? 0.0f
                : dev(log10f(s.lux + 1.0f), log10f(t.luxMin + 1.0f), log10f(t.luxMax + 1.0f), 0.3f);

  fisIrrigation->setInput(1, soilDev);
  fisIrrigation->setInput(2, tDev);
  fisIrrigation->fuzzify();
  o.irrigSec = fisIrrigation->defuzzify(1);

  fisClimate->setInput(1, tDev);
  fisClimate->setInput(2, hDev);
  fisClimate->setInput(3, lDev);
  fisClimate->fuzzify();
  o.fan    = fisClimate->defuzzify(1);
  o.evap   = fisClimate->defuzzify(2);
  o.comp   = fisClimate->defuzzify(3);
  o.heater = fisClimate->defuzzify(4);
  o.light  = fisClimate->defuzzify(5);

  gFis = o;
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

bool decide(Actuator &a, float score, bool allowed, unsigned long now) {
  bool want = a.on ? (score > ACT_OFF_SCORE) : (score > ACT_ON_SCORE);
  if (!allowed) want = false;
  if (want != a.on) {
    unsigned long dwell = a.on ? a.minOn : a.minOff;
    if (!allowed || a.changedAt == 0 || now - a.changedAt >= dwell) { a.on = want; a.changedAt = now; }
  }
  return a.on;
}

bool forceAct(Actuator &a, bool on, unsigned long now) {
  if (a.on != on) { a.on = on; a.changedAt = now; }
  return a.on;
}

// Decides whether irrigation should run right now (auto or manual).
bool wantIrrigation(const Sensors &s, const Remote &r, const Targets &t,
                    bool manual, bool stopAll, unsigned long now, Status &st) {
  static unsigned long autoRunUntil = 0, lastAutoEnd = 0, manualStart = 0;
  static bool manualLocked = false, wasManual = false;

  if (stopAll) { autoRunUntil = 0; manualStart = 0; return false; }

  if (manual != wasManual) {
    autoRunUntil = 0; manualStart = 0; manualLocked = false; wasManual = manual;
  }

  bool tankOk = tankAllowsPump(s);
  if (!tankOk) {
    if (isnan(s.tankPct)) strlcpy(st.blocked, "No water-tank reading, pump blocked", sizeof(st.blocked));
    else snprintf(st.blocked, sizeof(st.blocked), "Water tank low (%.0f%%), pump blocked", s.tankPct);
  }

  if (manual) {
    if (!r.pump) { manualStart = 0; manualLocked = false; return false; }
    if (manualLocked) { strlcpy(st.blocked, "Manual pump auto-stopped after 5 min", sizeof(st.blocked)); return false; }
    if (!tankOk) return false;
    if (manualStart == 0) manualStart = now;
    if (now - manualStart > MANUAL_PUMP_MAX_MS) { manualLocked = true; return false; }
    strlcpy(st.pump, "Manual · irrigation running", sizeof(st.pump));
    return true;
  }

  // ---- automatic: fuzzy irrigation ----
  float soilDev = dev(s.soilPct, t.moistureMin, t.moistureMax, 10.0f);
  bool sensorsAgree = fabsf(s.soilPct1 - s.soilPct2) <= SOIL_SENSOR_MAX_DIFF;
  if (!sensorsAgree) strlcpy(st.warn, "Soil probes disagree, auto-watering paused", sizeof(st.warn));

  if (autoRunUntil == 0 && soilDev <= SOIL_TRIGGER_DEV && sensorsAgree && tankOk) {
    bool cooled = (lastAutoEnd == 0) || (now - lastAutoEnd > AUTO_COOLDOWN_MS);
    if (!cooled) {
      unsigned long left = AUTO_COOLDOWN_MS - (now - lastAutoEnd);
      snprintf(st.blocked, sizeof(st.blocked), "Soil dry · next watering in %lu min", left / 60000UL + 1);
    } else if (gFis.irrigSec >= 1.0f) {
      autoRunUntil = now + (unsigned long)(gFis.irrigSec * 1000.0f);
    }
  }
  if (autoRunUntil != 0) {
    if ((long)(autoRunUntil - now) > 0 && tankOk) {
      snprintf(st.pump, sizeof(st.pump), "Watering · soil %.0f%% is below the %.0f%% target (%lus left)",
               s.soilPct, t.moistureMin, (autoRunUntil - now) / 1000UL + 1);
      return true;
    }
    autoRunUntil = 0;
    lastAutoEnd = now;
  }
  return false;
}

// Scheduled fertilizing. Returns whether the fertilizer pump should run;
// needLine = also keep the irrigation line flowing so the dose reaches the plants.
bool wantFertilizer(const Sensors &s, const Remote &r, const Targets &t, bool manual, bool stopAll,
                    bool irrigating, unsigned long now, Status &st, bool &needLine) {
  static unsigned long pumpUntil = 0, flushUntil = 0;
  needLine = false;

  if (stopAll) { pumpUntil = 0; flushUntil = 0; return false; }
  if (manual) {
    pumpUntil = 0; flushUntil = 0;
    if (r.fertilizer) { strlcpy(st.fert, "Manual · fertilizer pump running", sizeof(st.fert)); return true; }
    return false;
  }

  time_t ep = bestEpochForFeed();
  bool tankOk = tankAllowsPump(s);

  if (t.havePlan && t.feedEveryDays > 0 && ep > 0) {
    if (gLastFeed == 0) { gLastFeed = (uint32_t)ep; gFeedDirty = true; }   // first feed is one interval after the start
    int64_t dueIn = (int64_t)gLastFeed + (int64_t)t.feedEveryDays * 86400 - (int64_t)ep;
    st.fertDueH = dueIn > 0 ? (float)dueIn / 3600.0f : 0.0f;

    if (pumpUntil == 0 && flushUntil == 0 && dueIn <= 0) {
      if (!tankOk) strlcpy(st.blocked, "Feeding due · waiting for water in the tank", sizeof(st.blocked));
      else if (s.soilPct < t.moistureMin) strlcpy(st.blocked, "Feeding due · waiting until the soil is watered", sizeof(st.blocked));
      else if (!irrigating) { pumpUntil = now + FERT_RUN_MS; flushUntil = pumpUntil + FERT_FLUSH_MS; }
    }
  }

  bool pump = false;
  if (pumpUntil != 0) {
    if ((long)(pumpUntil - now) > 0 && tankOk) {
      pump = true;
      snprintf(st.fert, sizeof(st.fert), "Fertilizing · scheduled feed (every %d days)", t.feedEveryDays);
    } else {
      pumpUntil = 0;
      if (ep > 0) { gLastFeed = (uint32_t)ep; gFeedDirty = true; }
    }
  }
  if (flushUntil != 0) {
    if ((long)(flushUntil - now) > 0 && tankOk) needLine = FERT_USES_IRRIGATION_LINE;
    else flushUntil = 0;
  }
  return pump;
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
  Sensors s; Remote r; Targets t; DayCfg d;
  LOCK(); s = gSensors; r = gRemote; t = gTargets; d = gDay; UNLOCK();

  bool stale   = (now - r.lastOk) > CLOUD_STALE_MS;
  bool stopAll = r.emergencyStop;
  bool manual  = r.manual && !stale;

  Status st;
  strlcpy(st.mode, stopAll ? "stopped" : (manual ? "manual" : "auto"), sizeof(st.mode));
  st.irrigSec = gFis.irrigSec; st.fan = gFis.fan; st.evap = gFis.evap;
  st.comp = gFis.comp; st.heater = gFis.heater; st.lightScore = gFis.light;

  // ---- No plant plan loaded: nothing to control to, so everything automatic stays off ----
  if (!stopAll && !manual && !t.havePlan) {
    strlcpy(st.warn, "No plant plan loaded, automation idle", sizeof(st.warn));
    setRelay(RELAY_FAN, forceAct(actFan, false, now), gFanOn);
    setRelay(RELAY_EVAP, forceAct(actEvap, false, now), gEvapOn);
    setRelay(RELAY_COMPRESSOR, forceAct(actComp, false, now), gCompOn);
    setRelay(RELAY_HEATER, forceAct(actHeat, false, now), gHeatOn);
    setRelay(RELAY_LIGHT, forceAct(actLight, false, now), gLightOn);
    setRelay(RELAY_FERT_PUMP, false, gFertOn);
    updateIrrigation(false, false, now);
    LOCK(); gStatus = st; UNLOCK();
    return;
  }

  if (!stopAll && !manual) {
    if (isnan(s.temp)) strlcpy(st.warn, "DHT22 not reading, climate control paused", sizeof(st.warn));
    else if (!bhOk && !LIGHT_FULL_PHOTOPERIOD) strlcpy(st.warn, "Light sensor missing, grow light disabled", sizeof(st.warn));
  }

  // ---- Photoperiod: the day starts at the owner's "start of the day" (/meta/dayStart); the grow light
  //      may only run for the stage's light hours after that moment, then stays off until the next day ----
  float capH = t.lightHours;                       // from the plan (validated > 0 when a plan is loaded)
  if (capH > 24.0f) capH = 24.0f;
  time_t ep = bestEpochForFeed();
  bool photoOpen = false;
  int photoLeftMin = 0, photoStartsMin = -1;
  if (ep > 0) {
    long localMin = (long)(ep / 60) + d.tzOffsetMin;
    int nowMin = (int)(((localMin % 1440) + 1440) % 1440);   // local minute of the day
    int since  = (nowMin - d.minutes + 1440) % 1440;         // minutes since the day started
    int windowMin = (int)(capH * 60.0f + 0.5f);
    if (since < windowMin) { photoOpen = true; photoLeftMin = windowMin - since; }
    else photoStartsMin = 1440 - since;
  }
  st.photoOpen = photoOpen && t.havePlan;
  st.photoHours = capH;
  st.photoLeftMin = photoLeftMin;
  st.photoStartsMin = photoStartsMin;
  if (!stopAll && !manual && t.havePlan && ep == 0 && !st.warn[0])
    strlcpy(st.warn, "Clock not set yet, grow light stays off", sizeof(st.warn));

  // ---- Cooling ladder: fan first, compressor when the temperature is far above the range or the fan is not enough ----
  static unsigned long fanTrialStart = 0;
  static float fanTrialTemp = NAN;
  static bool coolerNeeded = false;
  float fanScore = gFis.fan, compScore = gFis.comp;
  if (!stopAll && !manual && !isnan(s.temp)) {
    float excess = s.temp - t.tempMax;                         // degrees above the stage's maximum
    float span = t.tempMax - t.tempMin;
    if (span < 4.0f) span = 4.0f;
    float onDelta = constrain(span * COOLER_ON_FRACTION, COOLER_ON_MIN_DELTA, COOLER_ON_MAX_DELTA);

    if (excess > 0) {
      fanScore = fmaxf(fanScore, 60.0f);                       // over the limit: the fan runs first
      if (fanTrialStart == 0) { fanTrialStart = now; fanTrialTemp = s.temp; }
      bool farAbove  = excess >= onDelta;
      bool fanFailed = (now - fanTrialStart >= FAN_TRIAL_MS) && excess >= COOLER_TRIAL_DELTA &&
                       (fanTrialTemp - s.temp) < FAN_MIN_DROP;
      if (farAbove || fanFailed) coolerNeeded = true;
    } else {
      if (!coolerNeeded) fanTrialStart = 0;
      if (s.temp <= t.tempMax - COOLER_RELEASE_MARGIN) { coolerNeeded = false; fanTrialStart = 0; }
    }
    if (coolerNeeded) {
      compScore = fmaxf(compScore, 80.0f);
      fanScore  = fmaxf(fanScore, 80.0f);                      // the fan keeps running beside the compressor
    }
  } else {
    coolerNeeded = false;
    fanTrialStart = 0;
  }
  st.fan = fanScore;
  st.comp = compScore;

  // ---- Climate: fan, evaporative mister, compressor, heater, grow light ----
  bool fanOn, evapOn, compOn, heatOn, lightOn;
  if (stopAll) {
    fanOn = forceAct(actFan, false, now);   evapOn = forceAct(actEvap, false, now);
    compOn = forceAct(actComp, false, now); heatOn = forceAct(actHeat, false, now);
    lightOn = forceAct(actLight, false, now);
  } else if (manual) {
    fanOn   = forceAct(actFan, r.cooler, now);
    compOn  = forceAct(actComp, false, now);
    heatOn  = forceAct(actHeat, r.heater && !actComp.on, now);
    evapOn  = forceAct(actEvap, r.humidifier && !actHeat.on, now);
    lightOn = forceAct(actLight, r.lights, now);
  } else {
    // compressor and heater never run together; mister never runs with the heater
    compOn  = decide(actComp, compScore, !actHeat.on, now);
    heatOn  = decide(actHeat, gFis.heater, !actComp.on, now);
    fanOn   = decide(actFan, fanScore, true, now);
    evapOn  = decide(actEvap, gFis.evap, !actHeat.on, now);
    bool lightAllowed = t.havePlan && photoOpen && (LIGHT_FULL_PHOTOPERIOD || s.lux >= 0);
    float lightScore  = LIGHT_FULL_PHOTOPERIOD ? 100.0f : gFis.light;
    lightOn = decide(actLight, lightScore, lightAllowed, now);
  }
  setRelay(RELAY_FAN, fanOn, gFanOn);
  setRelay(RELAY_EVAP, evapOn, gEvapOn);
  setRelay(RELAY_COMPRESSOR, compOn, gCompOn);
  setRelay(RELAY_HEATER, heatOn, gHeatOn);
  setRelay(RELAY_LIGHT, lightOn, gLightOn);

  // ---- Why: text for the app ----
  if (fanOn || compOn) {
    if (manual) strlcpy(st.cool, "Manual · exhaust fan running", sizeof(st.cool));
    else if (compOn && coolerNeeded) snprintf(st.cool, sizeof(st.cool), "Compressor + fan · %.1f°C is %.1f°C above the %.0f°C limit", s.temp, s.temp - t.tempMax, t.tempMax);
    else if (compOn) snprintf(st.cool, sizeof(st.cool), "Compressor + fan · hot and humid (%.1f°C, %.0f%% RH)", s.temp, s.hum);
    else if (s.temp > t.tempMax) snprintf(st.cool, sizeof(st.cool), "Exhaust fan · %.1f°C is above the %.0f°C limit", s.temp, t.tempMax);
    else if (s.hum > t.humMax) snprintf(st.cool, sizeof(st.cool), "Exhaust fan · humidity %.0f%% is above %.0f%%", s.hum, t.humMax);
    else strlcpy(st.cool, "Exhaust fan · ventilating", sizeof(st.cool));
  }
  if (heatOn) {
    if (manual) strlcpy(st.heat, "Manual · heater running", sizeof(st.heat));
    else snprintf(st.heat, sizeof(st.heat), "Heating · %.1f°C is below the %.0f°C minimum", s.temp, t.tempMin);
  }
  if (evapOn) {
    if (manual) strlcpy(st.hum, "Manual · mister running", sizeof(st.hum));
    else if (s.temp > t.tempMax) snprintf(st.hum, sizeof(st.hum), "Evaporative cooling · hot and dry (%.1f°C, %.0f%% RH)", s.temp, s.hum);
    else snprintf(st.hum, sizeof(st.hum), "Misting · humidity %.0f%% is below the %.0f%% minimum", s.hum, t.humMin);
  }
  if (lightOn) {
    if (manual) strlcpy(st.light, "Manual · grow lights on", sizeof(st.light));
    else if (LIGHT_FULL_PHOTOPERIOD)
      snprintf(st.light, sizeof(st.light), "Photoperiod · grow lights on, %dh %02dm left of %.1f h",
               photoLeftMin / 60, photoLeftMin % 60, capH);
    else snprintf(st.light, sizeof(st.light), "Grow lights · %.0f lx below %.0f lx min (%dh %02dm left)",
                  s.lux, t.luxMin, photoLeftMin / 60, photoLeftMin % 60);
  }

  // ---- Irrigation + fertilizer ----
  bool irr = wantIrrigation(s, r, t, manual, stopAll, now, st);
  bool needLine = false;
  bool fertPump = wantFertilizer(s, r, t, manual, stopAll, irr, now, st, needLine);
  if (needLine && !st.pump[0]) strlcpy(st.pump, "Flushing fertilizer through the line", sizeof(st.pump));
  setRelay(RELAY_FERT_PUMP, fertPump && !stopAll, gFertOn);
  updateIrrigation(irr || needLine, stopAll, now);

  LOCK(); gStatus = st; UNLOCK();
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
    if (++badCodes >= 5) { lockedUntil = millis() + 60000; badCodes = 0; }
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
    gBleAdvertising = false;
    Serial.println("[ble] phone connected");
  }
  void onDisconnect(NimBLEServer *server, NimBLEConnInfo &connInfo, int reason) override {
    gBleConnected = false;
    gBleAdvertising = false;
    Serial.println("[ble] phone disconnected");
  }
};

void startBle() {
  String name = "TerraSense-" + ghId.substring(6);
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
  if (gBleConnected) want = true;

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
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  fbConfig.api_key = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;
  fbAuth.user.email = DEVICE_EMAIL;
  fbAuth.user.password = DEVICE_PASSWORD;
  fbConfig.token_status_callback = tokenStatusCallback;

  fbdo.setBSSLBufferSize(4096, 1024);
  fbdo.setResponseSize(8192);   // large enough for a plan with many stages
  Firebase.reconnectWiFi(true);
  Firebase.begin(&fbConfig, &fbAuth);
}

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
    r.heater        = doc["heater"] | false;
    r.humidifier    = doc["humidifier"] | false;
    r.lights        = doc["lights"] | false;
  }
  r.lastOk = millis();
  LOCK(); gRemote = r; UNLOCK();
}

// ---- Plant plan: downloaded from Firebase, kept in local storage (PC or TF card) ----
String   gPlanJson = "";
uint32_t gSavedEpoch = 0;

// ---- Plant library: profiles the user downloaded in the app are copied to local storage ----
//   Firebase  /library/<plantId>   full profile {name, stages{...}}, written by the app on download
//   Local     plant_<plantId>.json, listed in library.idx
//   /meta/plan = {plantId, startedAt} when a cycle starts: the stages then come from the LOCAL file
String gLibIds = ",";        // ids already stored locally, e.g. ",tomato,basil,"
String gProfileJson = "";    // the active plant's profile (read from local storage)
String gProfileId = "";

bool validPlantId(const String &id) {       // becomes part of a file name, so keep it simple
  if (id.length() == 0 || id.length() > 40) return false;
  for (size_t i = 0; i < id.length(); i++) {
    char c = id[i];
    if (!(isalnum((unsigned char)c) || c == '_' || c == '-')) return false;
  }
  return true;
}

String profileFile(const String &id) { return "plant_" + id + ".json"; }

// plantId of a new-format plan ("" for the old inline-stages format or no plan)
String planPlantId(const String &planJson) {
  JsonDocument d;
  if (planJson.length() == 0 || deserializeJson(d, planJson)) return "";
  if (d["stages"].is<JsonObject>()) return "";
  String id = d["plantId"] | "";
  return validPlantId(id) ? id : String("");
}

// Copies one profile from Firebase /library into local storage (cloud task only)
bool downloadProfile(const String &id, String *keep = nullptr) {
  if (!validPlantId(id)) return false;
  if (!Firebase.RTDB.get(&fbdo, BASE + "/library/" + id)) {
    Serial.printf("[library] read %s failed: %s\n", id.c_str(), fbdo.errorReason().c_str());
    return false;
  }
  String json = fbdo.payload();
  if (json.length() < 10 || json == "null") return false;
  if (json.length() > 7900) {   // storageRead() refuses files over 8000 bytes, so never store one that could not be read back
    Serial.printf("[library] %s is too large (%u bytes), skipped\n", id.c_str(), (unsigned)json.length());
    return false;
  }
  if (!storageWrite(profileFile(id).c_str(), json)) {
    Serial.printf("[library] could not store %s locally (is the PC script running?)\n", id.c_str());
    return false;
  }
  if (gLibIds.indexOf("," + id + ",") < 0) {
    gLibIds += id + ",";
    storageWrite("library.idx", gLibIds);
  }
  if (keep) *keep = json;
  JsonDocument pd;
  String pname = id;
  if (!deserializeJson(pd, json)) pname = String(pd["name"] | id.c_str());
  Serial.println();
  Serial.println(F("=============== PLANT PROFILE DOWNLOADED ==============="));
  Serial.printf("  Plant : %s (id: %s)\n", pname.c_str(), id.c_str());
  Serial.printf("  Saved : %s in local storage (%u bytes)\n", profileFile(id).c_str(), (unsigned)json.length());
  Serial.println(F("========================================================"));
  return true;
}

// Downloads every profile in /library that is not stored locally yet. Returns how many were stored.
int syncLibrary() {
  if (!Firebase.RTDB.getShallowData(&fbdo, BASE + "/library")) {
    Serial.printf("[library] list failed: %s\n", fbdo.errorReason().c_str());
    return 0;
  }
  JsonDocument doc;
  if (deserializeJson(doc, fbdo.payload()) || !doc.is<JsonObject>()) return 0;   // empty library
  int fetched = 0;
  for (JsonPair kv : doc.as<JsonObject>()) {
    String id = kv.key().c_str();
    if (!validPlantId(id) || gLibIds.indexOf("," + id + ",") >= 0) continue;
    if (downloadProfile(id) && ++fetched >= 3) break;   // a few per pass keeps the cloud task responsive
  }
  return fetched;
}

// Makes gProfileJson match the plan's plantId: from local storage first, from Firebase only if missing
void ensureProfile(bool canDownload) {
  String id = planPlantId(gPlanJson);
  if (id == gProfileId && (id.length() == 0 || gProfileJson.length() > 0)) return;
  gProfileId = id;
  gProfileJson = "";
  if (id.length() == 0) return;
  if (storageRead(profileFile(id).c_str(), gProfileJson)) {
    Serial.printf("[plan] profile \"%s\" loaded from local storage\n", id.c_str());
  } else if (canDownload && downloadProfile(id, &gProfileJson)) {
    Serial.printf("[plan] profile \"%s\" was not local yet, downloaded now\n", id.c_str());
  } else {
    Serial.printf("[plan] profile \"%s\" not available yet\n", id.c_str());
  }
}

// setup(): only the saved clock (tiny, stays in NVS). The plan itself is loaded from local storage.
void loadSavedPlan() {
  gSavedEpoch = prefs.getULong("epoch", 0);
}

// Returns true when the plan (or its removal) reached local storage
bool savePlan(const String &json) {
  if (json.length() == 0) { storageRemove(PLAN_FILE); return true; }
  return storageWrite(PLAN_FILE, json);
}

// Loads the plan from local storage (once, at boot)
void loadStoredPlan() {
  String s;
  if (storageRead("library.idx", s) && s.length() > 1) gLibIds = s;
  if (storageRead(PLAN_FILE, s) && s.length() > 0) {
    gPlanJson = s;
    ensureProfile(false);                 // the plant's profile comes from local storage too
    applyPlan(gPlanJson);
    Serial.println("[plan] loaded from local storage");
  } else {
    Serial.println("[plan] nothing in local storage yet");
  }
}

void saveClock() {
  time_t t = time(nullptr);
  if (t < 1700000000) return;
  gSavedEpoch = (uint32_t)t;
  prefs.putULong("epoch", gSavedEpoch);
}

time_t bestEpoch() {
  time_t t = time(nullptr);
  if (t > 1700000000) return t;
  if (gSavedEpoch > 0) return (time_t)(gSavedEpoch + millis() / 1000UL);
  return 0;
}

// Same as bestEpoch(); a named wrapper so the control code above can call it
time_t bestEpochForFeed() { return bestEpoch(); }

// ---- Start of the day (/meta/dayStart), cached in flash like the plan ----
void loadSavedDay() {
  DayCfg d;
  d.set         = prefs.getBool("dsSet", false);
  d.minutes     = prefs.getInt("dsMin", 0);
  d.tzOffsetMin = prefs.getInt("dsTz", 0);
  LOCK(); gDay = d; UNLOCK();
}

void clearSavedDay() {
  prefs.remove("dsSet"); prefs.remove("dsMin"); prefs.remove("dsTz");
}

void pollDayStart() {
  if (!Firebase.RTDB.get(&fbdo, BASE + "/meta/dayStart")) {
    Serial.printf("[cloud] dayStart read failed: %s\n", fbdo.errorReason().c_str());
    return;
  }
  DayCfg d;   // not set -> midnight UTC
  String payload = fbdo.payload();
  JsonDocument doc;
  if (payload != "null" && !deserializeJson(doc, payload) && doc.is<JsonObject>()) {
    int m = doc["minutes"] | -1;
    if (m >= 0 && m < 1440) {
      d.set = true;
      d.minutes = m;
      d.tzOffsetMin = doc["tzOffsetMin"] | 0;
    }
  }

  DayCfg old;
  LOCK(); old = gDay; UNLOCK();
  if (d.set == old.set && d.minutes == old.minutes && d.tzOffsetMin == old.tzOffsetMin) return;

  LOCK(); gDay = d; UNLOCK();
  if (d.set) {
    prefs.putBool("dsSet", true);
    prefs.putInt("dsMin", d.minutes);
    prefs.putInt("dsTz", d.tzOffsetMin);
    Serial.printf("[day] day starts at %02d:%02d (UTC%+d min), photoperiod follows it\n",
                  d.minutes / 60, d.minutes % 60, d.tzOffsetMin);
  } else {
    clearSavedDay();
    Serial.println("[day] no start time set, using midnight UTC");
  }
}

struct StageDef {
  int order; long days;
  float tempMin, tempMax, moistureMin, moistureMax, humMin, humMax, luxMin, luxMax, lightHours;
  int feedEveryDays;
  char name[24];
};

// Works out today's stage from the plan text and updates the targets.
// All-or-nothing: if the current stage has any invalid range, no plan is loaded (the hub idles).
void applyPlan(const String &payload) {
  Targets t;   // zeros, havePlan = false
  time_t nowS = bestEpoch();
  JsonDocument doc, prof;
  JsonObject stageObj;                      // where the stage table comes from
  const char *plantName = "";

  if (nowS > 0 && payload.length() > 0 && !deserializeJson(doc, payload)) {
    if (doc["stages"].is<JsonObject>()) {   // old format: the stages are inside the plan
      stageObj = doc["stages"].as<JsonObject>();
      plantName = doc["plantName"] | "";
      if (!plantName[0]) plantName = doc["plant"] | "";
      if (!plantName[0]) plantName = doc["name"] | "";
    } else if (gProfileJson.length() > 0 && !deserializeJson(prof, gProfileJson) && prof["stages"].is<JsonObject>()) {
      stageObj = prof["stages"].as<JsonObject>();   // new format: stages come from the LOCAL profile
      plantName = prof["name"] | "";
      if (!plantName[0]) plantName = doc["plantId"] | "";
    }
  }

  if (!stageObj.isNull()) {
    double startedAt = doc["startedAt"] | 0.0;
    StageDef stages[12];
    int n = 0;

    for (JsonPair kv : stageObj) {
      if (n >= 12) break;
      JsonObject s = kv.value().as<JsonObject>();
      stages[n].order = atoi(kv.key().c_str());
      stages[n].days = s["days"] | 0L;
      stages[n].tempMin = s["tempMin"] | 0.0f;
      stages[n].tempMax = s["tempMax"] | 0.0f;
      stages[n].moistureMin = s["moistureMin"] | 0.0f;
      stages[n].moistureMax = s["moistureMax"] | 0.0f;
      stages[n].humMin = s["humidityMin"] | 0.0f;
      stages[n].humMax = s["humidityMax"] | 0.0f;
      stages[n].luxMin = s["luxMin"] | 0.0f;
      stages[n].luxMax = s["luxMax"] | 0.0f;
      stages[n].lightHours = s["lightHours"] | 0.0f;
      stages[n].feedEveryDays = s["feedEveryDays"] | 0;
      strlcpy(stages[n].name, s["name"] | "", sizeof(stages[n].name));
      n++;
    }
    for (int i = 1; i < n; i++) {
      StageDef x = stages[i]; int j = i - 1;
      while (j >= 0 && stages[j].order > x.order) { stages[j + 1] = stages[j]; j--; }
      stages[j + 1] = x;
    }

    if (n > 0 && startedAt > 0) {
      long total = 0;
      for (int i = 0; i < n; i++) total += stages[i].days;
      long day = (long)(((double)nowS * 1000.0 - startedAt) / 86400000.0) + 1;
      if (day < 1) day = 1;
      long end = 0;
      for (int i = 0; i < n; i++) {
        end += stages[i].days;
        if (day <= end) {
          const StageDef &g = stages[i];
          bool valid = g.tempMax > g.tempMin && g.moistureMax > g.moistureMin &&
                       g.humMax > g.humMin && g.luxMax > g.luxMin && g.lightHours > 0;
          if (!valid) {
            Serial.printf("[plan] stage %d has an invalid range, plan ignored\n", i + 1);
            break;
          }
          t.havePlan = true;
          t.stageNum = i + 1; t.stageCount = n; t.cycleDay = day; t.cycleDays = total;
          strlcpy(t.plantName, plantName, sizeof(t.plantName));
          t.tempMin = g.tempMin;         t.tempMax = g.tempMax;
          t.moistureMin = g.moistureMin; t.moistureMax = g.moistureMax;
          t.humMin = g.humMin;           t.humMax = g.humMax;
          t.luxMin = g.luxMin;           t.luxMax = g.luxMax;
          t.lightHours = g.lightHours;
          t.feedEveryDays = g.feedEveryDays;
          strlcpy(t.stageName, g.name, sizeof(t.stageName));
          Serial.printf("[plan] %s | stage %d/%d \"%s\" | day %ld/%ld | temp %.1f-%.1f | soil %.0f-%.0f | hum %.0f-%.0f | lux %.0f-%.0f | light %.1f h | feed every %d d\n",
                        t.plantName, t.stageNum, t.stageCount, t.stageName, t.cycleDay, t.cycleDays,
                        t.tempMin, t.tempMax, t.moistureMin, t.moistureMax, t.humMin, t.humMax,
                        t.luxMin, t.luxMax, t.lightHours, t.feedEveryDays);
          break;
        }
      }
    }
  }
  LOCK(); gTargets = t; UNLOCK();
}

void pollPlan() {
  static bool planDirty = false;   // true until the current plan has reached local storage

  if (!Firebase.RTDB.get(&fbdo, BASE + "/meta/plan")) {
    Serial.printf("[cloud] plan read failed: %s\n", fbdo.errorReason().c_str());
    return;
  }
  String payload = fbdo.payload();
  if (payload == "null") payload = "";
  if (payload != gPlanJson) {
    gPlanJson = payload;
    planDirty = true;
    gLastFeed = 0; gFeedDirty = true;         // a new (or stopped) plan restarts the feeding schedule
    Serial.println(payload.length() ? "[plan] new plan from Firebase" : "[plan] cleared");
  }
  if (planDirty && savePlan(gPlanJson)) {     // retried every minute if the PC / card was unavailable
    planDirty = false;
    Serial.println("[plan] stored locally");
  }
  ensureProfile(true);

  // Announce cycle start / stop (a plan with a new plant or a new start date is a new cycle)
  static String lastCycleKey = "";
  static bool firstPass = true;
  JsonDocument pj;
  String pid = "", pname = "";
  double started = 0;
  bool haveCycle = gPlanJson.length() > 0 && !deserializeJson(pj, gPlanJson);
  if (haveCycle) {
    pid = String(pj["plantId"] | "");
    pname = String(pj["name"] | "");
    started = pj["startedAt"] | 0.0;
    if (pname.length() == 0) pname = pid;
  }
  String key = haveCycle ? pid + "@" + String(started, 0) : String("");
  if (key != lastCycleKey || firstPass) {
    const char *src = gProfileJson.length() > 0 ? "LOCAL profile file (plant_<id>.json)"
                    : pj["stages"].is<JsonObject>() ? "stages inside the plan (old format)"
                    : "NOT AVAILABLE yet: the hub idles until the profile is stored";
    Serial.println();
    if (haveCycle) {
      Serial.println(firstPass ? F("=============== PLANT CYCLE RUNNING (resumed) ===============")
                               : F("=============== PLANT CYCLE STARTED ===============") );
      Serial.printf("  Plant : %s%s%s\n", pname.c_str(), pid.length() ? " (id: " : "", pid.length() ? (pid + ")").c_str() : "");
      time_t st = (time_t)(started / 1000.0);
      if (st > 1700000000) { char buf[32]; strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M UTC", gmtime(&st)); Serial.printf("  Start : %s\n", buf); }
      Serial.printf("  Stages: %s\n", src);
      Serial.println(F("==========================================================="));
    } else if (!firstPass) {
      Serial.println(F("=============== PLANT CYCLE STOPPED ==============="));
      Serial.println(F("  Automation idles until a new cycle is started."));
      Serial.println(F("==================================================="));
    }
    lastCycleKey = key;
    firstPass = false;
  }

  applyPlan(gPlanJson);
}

void pushLive() {
  Sensors s; Status st; Targets t; DayCfg d;
  LOCK(); s = gSensors; st = gStatus; t = gTargets; d = gDay; UNLOCK();

  FirebaseJson j;
  if (!isnan(s.temp)) j.set("temperature", round1(s.temp));
  if (!isnan(s.hum))  j.set("humidity", round1(s.hum));
  j.set("soilMoisture", round1(s.soilPct));
  j.set("soil1Raw", s.soil1);
  j.set("soil2Raw", s.soil2);
  if (s.lux >= 0)        j.set("lightLux", round1(s.lux));
  if (!isnan(s.tankPct)) j.set("waterTank", round1(s.tankPct));

  // What is physically switched on
  j.set("relays/pump", (bool)gPumpOn);
  j.set("relays/valve", (bool)gValveOn);
  j.set("relays/cooler", (bool)(gFanOn || gCompOn));
  j.set("relays/fan", (bool)gFanOn);
  j.set("relays/compressor", (bool)gCompOn);
  j.set("relays/heater", (bool)gHeatOn);
  j.set("relays/humidifier", (bool)gEvapOn);
  j.set("relays/lights", (bool)gLightOn);
  j.set("relays/fertilizer", (bool)gFertOn);

  // What the hub is doing and why (for the app's Actions page)
  j.set("mode", String(st.mode));
  if (st.pump[0])  j.set("actions/pump", String(st.pump));
  if (st.fert[0])  j.set("actions/fertilizer", String(st.fert));
  if (st.cool[0])  j.set("actions/cooler", String(st.cool));
  if (st.heat[0])  j.set("actions/heater", String(st.heat));
  if (st.hum[0])   j.set("actions/humidifier", String(st.hum));
  if (st.light[0]) j.set("actions/lights", String(st.light));
  if (st.blocked[0]) j.set("blocked", String(st.blocked));
  if (st.warn[0])    j.set("warn", String(st.warn));
  j.set("fis/irrigationSec", round1(st.irrigSec));
  j.set("fis/fan", round1(st.fan));
  j.set("fis/humidifier", round1(st.evap));
  j.set("fis/compressor", round1(st.comp));
  j.set("fis/heater", round1(st.heater));
  j.set("fis/lights", round1(st.lightScore));
  if (st.fertDueH >= 0) j.set("fertDueH", round1(st.fertDueH));

  // The plant data the hub actually loaded and is controlling to
  j.set("plan/active", t.havePlan);
  j.set("plan/plant", String(t.plantName));
  j.set("plan/stage", String(t.stageName));
  j.set("plan/stageNum", t.stageNum);
  j.set("plan/stageCount", t.stageCount);
  j.set("plan/day", (int)t.cycleDay);
  j.set("plan/totalDays", (int)t.cycleDays);
  j.set("plan/tempMin", round1(t.tempMin));         j.set("plan/tempMax", round1(t.tempMax));
  j.set("plan/moistureMin", round1(t.moistureMin)); j.set("plan/moistureMax", round1(t.moistureMax));
  j.set("plan/humMin", round1(t.humMin));           j.set("plan/humMax", round1(t.humMax));
  j.set("plan/luxMin", round1(t.luxMin));           j.set("plan/luxMax", round1(t.luxMax));
  j.set("plan/lightHours", round1(t.lightHours));
  j.set("plan/feedEveryDays", t.feedEveryDays);
  j.set("plan/profileId", gProfileId);                 // which local profile the hub is using
  j.set("plan/profileLocal", gProfileJson.length() > 0);
  j.set("library/ids", gLibIds);                       // plants stored locally, e.g. ",tomato,basil,"

  // Day start the hub is using (the app compares this with what was saved) and the photoperiod window
  j.set("dayStart/minutes", d.minutes);
  j.set("dayStart/tzOffsetMin", d.tzOffsetMin);
  j.set("photo/open", st.photoOpen);
  j.set("photo/hours", round1(st.photoHours));
  if (st.photoOpen) j.set("photo/leftMin", st.photoLeftMin);
  else if (st.photoStartsMin >= 0) j.set("photo/startsInMin", st.photoStartsMin);

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

void pollOwner() {
  if (!Firebase.RTDB.get(&fbdo, BASE + "/ownerUid")) {
    Serial.printf("[cloud] owner read failed: %s\n", fbdo.errorReason().c_str());
    return;
  }
  bool owned = (fbdo.dataType() == "string") && fbdo.stringData().length() > 0;
  if (owned == gOwned) return;

  gOwned = owned;
  if (!owned) {
    Serial.println("[cloud] no owner: uploads paused, waiting for the app to add this hub");
    LOCK(); gRemote = Remote(); gTargets = Targets(); gDay = DayCfg(); UNLOCK();
    clearSavedDay();
    gPlanJson = "";
    gProfileJson = ""; gProfileId = "";
    savePlan("");
    gLastFeed = 0; gFeedDirty = true;
  } else {
    Serial.println("[cloud] hub has an owner again: uploads resumed");
  }
}

void cloudTask(void *) {
  unsigned long tWifi = 0, tControls = 0, tPlan = 0, tLive = 0, tHistory = 0, tReg = 0, tOwner = 0;
  unsigned long tTargets = 0, tClock = 0, tDay = 0, tLib = 0;
  bool fbStarted = false, uidPrinted = false;
  uint16_t lastRelays = 0xFFFF;

  for (;;) {
    unsigned long now = millis();
    bool wifiUp = (WiFi.status() == WL_CONNECTED);

    if (tTargets == 0 || now - tTargets >= 60000UL) { tTargets = now; applyPlan(gPlanJson); }
    if (time(nullptr) > 1700000000 && (tClock == 0 || now - tClock >= 3600000UL)) { tClock = now; saveClock(); }

    // Feeding schedule is saved to flash from here (flash access stays on this core)
    if (gFeedDirty) {
      gFeedDirty = false;
      if (gLastFeed) prefs.putULong("feedAt", gLastFeed); else prefs.remove("feedAt");
    }

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

    if (!registered && (tReg == 0 || now - tReg > 30000)) { tReg = now; registerDevice(); }

    if (tOwner == 0 || now - tOwner >= OWNER_INTERVAL_MS) { tOwner = now; pollOwner(); }
    if (!gOwned) { vTaskDelay(pdMS_TO_TICKS(250)); continue; }

    // Push /live immediately when any relay changes, so the Actions page doesn't lag
    uint16_t cur = (gPumpOn ? 1 : 0) | (gFanOn ? 2 : 0) | (gFertOn ? 4 : 0) | (gEvapOn ? 8 : 0)
                 | (gCompOn ? 16 : 0) | (gHeatOn ? 32 : 0) | (gLightOn ? 64 : 0) | (gValveOn ? 128 : 0);
    // A change of mode (auto / manual / stopped) is also reported straight away, so the app does not sit on
    // "waiting for the hub" until the next 30 s update
    char modeNow[10];
    LOCK(); strlcpy(modeNow, gStatus.mode, sizeof(modeNow)); UNLOCK();
    uint16_t modeBits = strcmp(modeNow, "manual") == 0 ? 1 : (strcmp(modeNow, "stopped") == 0 ? 2 : 0);
    cur |= (uint16_t)(modeBits << 8);
    if (cur != lastRelays) { lastRelays = cur; tLive = 0; }

    if (tDay == 0 || now - tDay >= DAYSTART_INTERVAL_MS) { tDay = now; pollDayStart(); }
    if (tControls == 0 || now - tControls >= CONTROLS_INTERVAL_MS) { tControls = now; pollControls(); }
    if (tLib == 0      || now - tLib      >= LIBRARY_INTERVAL_MS)  { tLib = now;      if (syncLibrary() > 0) tLive = 0; }   // new plants first (and tell the app right away),
    if (tPlan == 0     || now - tPlan     >= PLAN_INTERVAL_MS)     { tPlan = now;     pollPlan(); }      // then the plan
    if (tLive == 0     || now - tLive     >= LIVE_INTERVAL_MS)     { tLive = now;     pushLive(); }
    if (tHistory == 0  || now - tHistory  >= HISTORY_INTERVAL_MS)  { tHistory = now;  pushHistory(); }

    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

// ============================================================================
// SETUP / LOOP
// ============================================================================
void setup() {
  Serial.setRxBufferSize(8192);          // a whole plan from the PC must fit
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("\n=============================================="));
  Serial.println(F("         TERRASENSE HUB BOOTING"));
  Serial.println(F("=============================================="));

  // Relays: set OFF first, then become outputs
  const int relays[] = {RELAY_MAIN_PUMP, RELAY_VALVE_IRRIG, RELAY_FERT_PUMP, RELAY_FAN,
                        RELAY_EVAP, RELAY_COMPRESSOR, RELAY_HEATER, RELAY_LIGHT};
  for (int p : relays) { digitalWrite(p, RELAY_OFF); pinMode(p, OUTPUT); digitalWrite(p, RELAY_OFF); }
  actComp.changedAt = millis();   // compressor must wait its minimum off-time after power-up

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

  prefs.begin("terrasense", false);
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
#ifdef WIFI_SSID
  if (wifiSsid.length() == 0 && USE_SECRETS_WIFI_FALLBACK) {
    wifiSsid = WIFI_SSID;
    wifiPass = WIFI_PASSWORD;
  }
#endif

  storageBegin();
  loadSavedPlan();                       // the saved clock
  gLastFeed = prefs.getULong("feedAt", 0);
  loadSavedDay();
  loadStoredPlan();                      // USB and TF card need no Wi-Fi, so the plan is available at boot
  applyPlan(gPlanJson);

  buildFuzzy();
  Serial.println(F("[OK] Fuzzy engines (irrigation + climate) built"));

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
    if (t.havePlan) evaluateFuzzy(s, t); else gFis = FisOut();   // no plan: nothing to evaluate against

    if (!gUsbBusy) {
    Serial.println(F("----------------------------------------------"));
    if (isnan(s.temp)) Serial.println(F("Temp/Hum : DHT22 read failure"));
    else Serial.printf("Temp %.1f C | Hum %.1f %%\n", s.temp, s.hum);
    Serial.printf("Soil %d / %d ADC -> %.0f %% / %.0f %%\n", s.soil1, s.soil2, s.soilPct1, s.soilPct2);
    if (s.lux >= 0) Serial.printf("Light %.0f lux\n", s.lux);
    if (isnan(s.tankPct)) Serial.println(F("Tank : no sensor reading"));
    else Serial.printf("Tank %.1f cm -> %.0f %%\n", s.tankDist, s.tankPct);
    if (t.havePlan)
      Serial.printf("Targets: %s | temp %.0f-%.0f C | soil %.0f-%.0f %% | hum %.0f-%.0f %% | light %.0f-%.0f lx\n",
                    t.stageName, t.tempMin, t.tempMax, t.moistureMin, t.moistureMax,
                    t.humMin, t.humMax, t.luxMin, t.luxMax);
    else
      Serial.println(F("Targets: NO PLAN LOADED (automation idle)"));
    Serial.printf("FIS    : water %.1f s | fan %.0f | mist %.0f | comp %.0f | heat %.0f | light %.0f\n",
                  gFis.irrigSec, gFis.fan, gFis.evap, gFis.comp, gFis.heater, gFis.light);
    Serial.printf("Relays : pump=%d valve=%d fan=%d mist=%d comp=%d heat=%d light=%d fert=%d\n",
                  gPumpOn, gValveOn, gFanOn, gEvapOn, gCompOn, gHeatOn, gLightOn, gFertOn);
    Serial.printf("Link   : wifi=%s ble=%s owner=%s\n",
                  WiFi.status() == WL_CONNECTED ? "ok" : "down",
                  gBleConnected ? "connected" : (gBleAdvertising ? "advertising" : "off"),
                  gOwned ? "yes" : "none");
    }
  }

  runAutomation(now);   // every pass, so valve/pump timing stays accurate
  delay(20);
}
