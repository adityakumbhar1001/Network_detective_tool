#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <WiFi.h>
#include <XPT2046_Touchscreen.h>
#include <esp_system.h>
#include <new>
#include <stdarg.h>
#include <math.h>

#if __has_include("wifi_shield_config.h")
#include "wifi_shield_config.h"
#else
#define WIFISHIELD_WIFI_SSID ""
#define WIFISHIELD_WIFI_PASSWORD ""
#define WIFISHIELD_API_URL "http://10.191.116.89:3001/api/scans"
#define WIFISHIELD_SNAPSHOT_URL "http://10.191.116.89:3001/api/snapshot"
#define WIFISHIELD_DEVICE_TOKEN ""
#endif

#ifndef WIFISHIELD_SNAPSHOT_URL
#define WIFISHIELD_SNAPSHOT_URL ""
#endif

const char *WIFI_SSID = WIFISHIELD_WIFI_SSID;
const char *WIFI_PASSWORD = WIFISHIELD_WIFI_PASSWORD;
const char *DEVICE_ID = "esp32-wifi-shield-01";
const char *API_URL = WIFISHIELD_API_URL;
const char *SNAPSHOT_URL = WIFISHIELD_SNAPSHOT_URL;
const char *DEVICE_TOKEN = WIFISHIELD_DEVICE_TOKEN;

constexpr int TOUCH_CS_PIN = 4;
constexpr int ALERT_LED_PIN = 25;
constexpr int SPI_SCK_PIN = 18;
constexpr int SPI_MISO_PIN = 19;
constexpr int SPI_MOSI_PIN = 23;
constexpr uint8_t DISPLAY_ROTATION = 1;
// Tune these raw corner readings for the installed touch panel.
constexpr int TOUCH_RAW_X_MIN = 250;
constexpr int TOUCH_RAW_X_MAX = 3850;
constexpr int TOUCH_RAW_Y_MIN = 250;
constexpr int TOUCH_RAW_Y_MAX = 3850;
// Flip these options if a calibration tap reports mirrored/swapped axes.
constexpr bool TOUCH_SWAP_AXES = false;
constexpr bool TOUCH_INVERT_X = false;
constexpr bool TOUCH_INVERT_Y = false;

const unsigned long SCAN_INTERVAL_MS = 15000;
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000;
const unsigned long SCAN_RETRY_DELAY_MS = 5000;
const unsigned long TOUCH_DEBOUNCE_MS = 180;
const unsigned long STARTUP_DIAGNOSTIC_MS = 1500;
const size_t MAX_NETWORKS_PER_SCAN = 80;
const size_t MAX_DISPLAY_NETWORKS = 80;
const size_t MAX_DISPLAY_ALERTS = 40;
const size_t NETWORKS_PER_PAGE = 3;
const size_t SNAPSHOT_DOCUMENT_CAPACITY = 131072;

TFT_eSPI tft = TFT_eSPI();
XPT2046_Touchscreen touch(TOUCH_CS_PIN);
SemaphoreHandle_t dataMutex;
TaskHandle_t apiTaskHandle = nullptr;

struct NetworkRecord {
  String ssid;
  String bssid;
  String security;
  String securityStatus;
  int rssi;
  int channel;
  bool trusted;
  bool suspicious;
};

struct AlertRecord {
  String type;
  String severity;
  String ssid;
  String observedBssid;
  String trustedBssid;
  String explanation;
  String message;
  String evidence;
  String status;
  int riskScore;
  bool hasRiskScore;
};

enum Screen {
  SCREEN_HOME,
  SCREEN_NETWORKS,
  SCREEN_ALERTS,
  SCREEN_SECURITY,
  SCREEN_SETTINGS,
};

struct ScanRequest {
  String payload;
  size_t networkCount;
  uint32_t cycleId;
  unsigned long cycleStartedAt;
};

NetworkRecord networks[MAX_DISPLAY_NETWORKS];
AlertRecord securityAlerts[MAX_DISPLAY_ALERTS];
size_t networkCount = 0;
size_t securityAlertCount = 0;
size_t activeAlertCount = 0;
size_t highPriorityAlertCount = 0;
size_t criticalAlertCount = 0;
size_t highAlertCount = 0;
size_t mediumAlertCount = 0;
size_t lowAlertCount = 0;
size_t networkPage = 0;
size_t alertPage = 0;
Screen currentScreen = SCREEN_NETWORKS;
String snapshotStatus = "WAITING";
String scannedAt;
volatile bool backendReachable = false;
volatile bool snapshotChanged = true;
bool alertDataAvailable = false;
bool scanInProgress = false;
bool scanRetryPending = false;
volatile bool wifiConnectPending = false;
bool touchWasDown = false;
bool startupDiagnosticVisible = true;
unsigned long lastScanStart = 0;
unsigned long scanRetryAfter = 0;
unsigned long activeWifiScanStartedAt = 0;
unsigned long lastWifiAttempt = 0;
unsigned long lastTouchMillis = 0;
unsigned long startupDiagnosticStarted = 0;
String lastStatusSignature;
uint32_t nextScanCycleId = 0;
uint32_t activeScanCycleId = 0;
uint32_t nextErrorId = 100;
unsigned long activeScanCycleStartedAt = 0;
bool scanCycleActive = false;
volatile bool scanCycleWaitingForDisplay = false;
volatile bool wifiReconnectPending = false;
volatile bool wifiReconnectTimeoutReported = false;
bool initialWifiTimeoutReported = false;
unsigned long wifiReconnectStartedAt = 0;
String pendingScanPayload;
size_t pendingScanNetworkCount = 0;
uint32_t pendingScanCycleId = 0;
unsigned long pendingScanCycleStartedAt = 0;
unsigned long pendingScanRetryAfter = 0;
bool pendingScanUpload = false;

String securityName(wifi_auth_mode_t authMode);

void diagnosticLog(const char *severity, uint32_t cycleId,
                   const char *operation, const char *format, ...) {
  char message[420];
  va_list args;
  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);
  Serial.printf("[%lu ms][CYCLE %lu][%s][%s] %s\n",
                static_cast<unsigned long>(millis()),
                static_cast<unsigned long>(cycleId), severity, operation, message);
}

void diagnosticError(uint32_t cycleId, const char *operation, const char *details,
                     const char *category, const char *nextCheck) {
  const uint32_t errorId = nextErrorId++;
  Serial.printf("[%lu ms][CYCLE %lu][ERROR][%s][E%03lu] %s; category=%s; next check: %s\n",
                static_cast<unsigned long>(millis()),
                static_cast<unsigned long>(cycleId), operation,
                static_cast<unsigned long>(errorId), details, category, nextCheck);
}

const char *wifiStatusName(wl_status_t status) {
  switch (status) {
    case WL_IDLE_STATUS: return "IDLE";
    case WL_NO_SSID_AVAIL: return "NO_SSID";
    case WL_SCAN_COMPLETED: return "SCAN_COMPLETED";
    case WL_CONNECTED: return "CONNECTED";
    case WL_CONNECT_FAILED: return "CONNECT_FAILED";
    case WL_CONNECTION_LOST: return "CONNECTION_LOST";
    case WL_DISCONNECTED: return "DISCONNECTED";
    default: return "UNKNOWN";
  }
}

const char *wifiDisconnectReasonName(uint8_t reason) {
  switch (reason) {
    case WIFI_REASON_UNSPECIFIED: return "UNSPECIFIED";
    case WIFI_REASON_AUTH_EXPIRE: return "AUTH_EXPIRE";
    case WIFI_REASON_AUTH_FAIL: return "AUTH_FAIL";
    case WIFI_REASON_ASSOC_FAIL: return "ASSOC_FAIL";
    case WIFI_REASON_NO_AP_FOUND: return "NO_AP_FOUND";
    case WIFI_REASON_BEACON_TIMEOUT: return "BEACON_TIMEOUT";
    case WIFI_REASON_HANDSHAKE_TIMEOUT: return "HANDSHAKE_TIMEOUT";
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "4WAY_HANDSHAKE_TIMEOUT";
    case WIFI_REASON_ASSOC_LEAVE: return "ASSOC_LEAVE";
    default: return "OTHER_OR_UNKNOWN";
  }
}

String wifiDiagnostics() {
  const wl_status_t status = WiFi.status();
  String values = "mode=" + String(static_cast<int>(WiFi.getMode()));
  values += ", status=" + String(static_cast<int>(status));
  values += " (" + String(wifiStatusName(status)) + ")";
  values += ", ESP32_IP=" + WiFi.localIP().toString();
  values += ", subnet=" + WiFi.subnetMask().toString();
  values += ", gateway=" + WiFi.gatewayIP().toString();
  values += ", DNS=" + WiFi.dnsIP().toString();
  values += ", RSSI=";
  values += status == WL_CONNECTED ? String(WiFi.RSSI()) + " dBm" : "unavailable";
  return values;
}

String boundedPreview(const String &body, size_t maximumLength = 240) {
  String preview;
  preview.reserve(min(body.length(), maximumLength) + 8);
  const size_t limit = min(body.length(), maximumLength);
  for (size_t index = 0; index < limit; index++) {
    const char value = body[index];
    if (value == '\r') preview += "\\r";
    else if (value == '\n') preview += "\\n";
    else if (value == '\t') preview += "\\t";
    else if (static_cast<uint8_t>(value) < 32) preview += '.';
    else preview += value;
  }
  if (body.length() > maximumLength) preview += "...";
  return preview;
}

const char *responseBodyKind(const String &body, const String &contentType) {
  if (!body.length()) return "empty";
  String lowerType = contentType;
  lowerType.toLowerCase();
  if (lowerType.indexOf("text/html") >= 0) return "HTML";
  size_t first = 0;
  while (first < body.length() &&
         (body[first] == ' ' || body[first] == '\t' ||
          body[first] == '\r' || body[first] == '\n')) {
    first++;
  }
  if (first == body.length()) return "whitespace-only";
  if (body[first] == '<') return "HTML";
  if (body[first] == '{' || body[first] == '[') return "JSON candidate";
  return "non-JSON text";
}

String jsonRootKeys(JsonObjectConst object) {
  String keys = "[";
  bool first = true;
  for (JsonPairConst pair : object) {
    if (!first) keys += ",";
    keys += pair.key().c_str();
    first = false;
    if (keys.length() > 300) {
      keys += ",...";
      break;
    }
  }
  keys += "]";
  return keys;
}

String jsonItemKeys(JsonVariantConst arrayValue) {
  JsonArrayConst array = arrayValue.as<JsonArrayConst>();
  if (array.isNull() || array.size() == 0) return "[]";
  JsonObjectConst item = array[0].as<JsonObjectConst>();
  if (item.isNull()) return "(first item is not an object)";
  return jsonRootKeys(item);
}

void logJsonShape(const char *operation, uint32_t cycleId,
                  DynamicJsonDocument &document, const char *arrayName) {
  const char *rootType = document.is<JsonObject>() ? "object" :
      document.is<JsonArray>() ? "array" : "scalar/null";
  diagnosticLog("INFO", cycleId, operation, "JSON root type=%s, document capacity=%u, memory usage=%u",
                rootType, static_cast<unsigned>(document.capacity()),
                static_cast<unsigned>(document.memoryUsage()));
  if (!document.is<JsonObject>()) return;
  JsonObject root = document.as<JsonObject>();
  diagnosticLog("INFO", cycleId, operation, "root keys=%s",
                jsonRootKeys(document.as<JsonObjectConst>()).c_str());
  JsonVariant arrayValue = root[arrayName];
  const char *fieldType = arrayValue.isNull() ? "missing/null" :
      arrayValue.is<JsonArray>() ? "array" :
      arrayValue.is<JsonObject>() ? "object" :
      arrayValue.is<const char *>() ? "string" : "scalar";
  const size_t arrayLength = arrayValue.is<JsonArray>() ? arrayValue.size() : 0;
  diagnosticLog("INFO", cycleId, operation,
                "field=%s type=%s length=%u first-item-keys=%s",
                arrayName, fieldType, static_cast<unsigned>(arrayLength),
                jsonItemKeys(arrayValue.as<JsonVariantConst>()).c_str());
}

bool performHttpRequest(HTTPClient &client, const char *method, const String &url,
                        const String *payload, size_t payloadNetworkCount,
                        int expectedStatus, uint32_t cycleId,
                        String &responseBody, String &responseContentType,
                        int &statusCode, const char *deviceToken = nullptr) {
  const unsigned long startedAt = millis();
  const bool connectedBefore = WiFi.status() == WL_CONNECTED;
  const size_t payloadLength = payload ? payload->length() : 0;
  const String payloadSummary = payload
      ? "payload-bytes=" + String(payloadLength) + ", scan-networks=" +
          String(static_cast<unsigned>(payloadNetworkCount))
      : "payload=none";
  diagnosticLog("INFO", cycleId, method,
                "start method=%s url=%s WiFi-before=%s; %s; %s",
                method, url.c_str(),
                connectedBefore ? "CONNECTED" : wifiStatusName(WiFi.status()),
                wifiDiagnostics().c_str(), payloadSummary.c_str());

  if (!connectedBefore) {
    diagnosticError(cycleId, method,
                    "HTTP request not started because Wi-Fi was disconnected",
                    "confirmed local precondition: station is not connected",
                    "wait for the STA_GOT_IP event; verify SSID and router availability");
    statusCode = -1;
    diagnosticLog("INFO", cycleId, method,
                  "HTTPClient was not opened; end() was not required");
    return false;
  }

  const char *responseHeaders[] = {"Content-Type"};
  client.collectHeaders(responseHeaders, 1);
  const bool initialized = client.begin(url);
  if (!initialized) {
    diagnosticError(cycleId, method,
                    String("HTTPClient.begin returned false; url=" + url +
                           "; WiFi=" + wifiDiagnostics()).c_str(),
                    "HTTP client could not initialize the configured URL",
                    "check URL scheme/host/path and available client resources");
    client.end();
    diagnosticLog("INFO", cycleId, method,
                  "HTTPClient.end() called after begin failure; end() returns void, close result is not observable");
    statusCode = -1;
    return false;
  }

  client.addHeader("X-WifiShield-Cycle", String(cycleId));
  if (payload) client.addHeader("Content-Type", "application/json");
  if (deviceToken && deviceToken[0] != '\0') {
    client.addHeader("X-Device-Token", deviceToken);
  }
  diagnosticLog("INFO", cycleId, method, "request dispatched at=%lu ms",
                startedAt);
  statusCode = payload ? client.POST(*payload) : client.GET();
  const unsigned long duration = millis() - startedAt;

  if (statusCode < 0) {
    const String description = client.errorToString(statusCode);
    const bool connectedAfter = WiFi.status() == WL_CONNECTED;
    String details = String("method=") + method + ", url=" + url +
        ", HTTP=" + String(statusCode) + ", error=\"" + description +
        "\", duration=" + String(duration) + " ms, payload-bytes=" +
        String(payloadLength) + ", WiFi-before=CONNECTED, WiFi-after=" +
        (connectedAfter ? "CONNECTED" : wifiStatusName(WiFi.status())) +
        ", " + wifiDiagnostics();
    diagnosticError(cycleId, method, details.c_str(),
                    connectedAfter
                        ? "ROOT CAUSE NOT YET CONFIRMED: client received no HTTP status while Wi-Fi remained connected"
                        : "Wi-Fi was disconnected by the time the request failed; the exact disconnect timing is unknown",
                    connectedAfter
                        ? "check backend access logs for this cycle ID; if absent verify configured IP, port, LAN routing and firewall"
                        : "inspect STA_DISCONNECTED reason and reconnect logs, then verify the access point link");
    responseBody = "";
    responseContentType = "";
  } else {
    const int declaredLength = client.getSize();
    responseContentType = client.header("Content-Type");
    responseBody = client.getString();
    const int finalLength = client.getSize();
    const size_t actualLength = responseBody.length();
    diagnosticLog("INFO", cycleId, method,
                  "HTTP=%d duration=%lu ms content-type=%s declared-length=%d final-length=%d actual-body-length=%u body-kind=%s preview=\"%s\"",
                  statusCode, duration,
                  responseContentType.length() ? responseContentType.c_str() : "(missing)",
                  declaredLength, finalLength, static_cast<unsigned>(actualLength),
                  responseBodyKind(responseBody, responseContentType),
                  boundedPreview(responseBody).c_str());
    if (finalLength >= 0 && static_cast<size_t>(finalLength) != actualLength) {
      diagnosticError(cycleId, method,
                      String("HTTP body length mismatch; expected=" +
                             String(finalLength) + " bytes, collected=" +
                             String(static_cast<unsigned>(actualLength)) +
                             " bytes; initial Content-Length=" +
                             String(declaredLength)).c_str(),
                      "response collection is incomplete; parsing the body is unsafe",
                      "verify backend Content-Length and TCP stream closure; compare the matching backend response log");
      responseBody = "";
    }
    if (statusCode != expectedStatus) {
      diagnosticError(cycleId, method,
                      String("backend returned HTTP=" + String(statusCode) +
                             "; response was received; duration=" +
                             String(duration) + " ms; " +
                             wifiDiagnostics()).c_str(),
                      "request reached an HTTP server but returned an unexpected status",
                      "inspect the matching backend access log and response body for this cycle ID");
    }
  }

  client.end();
  diagnosticLog("INFO", cycleId, method,
                "HTTPClient.end() called; end() returns void, close result is not observable");
  return statusCode == expectedStatus;
}

void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_START) {
    Serial.printf("[wifi] station started; mode=%d status=%d (%s)\n",
                  static_cast<int>(WiFi.getMode()), static_cast<int>(WiFi.status()),
                  wifiStatusName(WiFi.status()));
  } else if (event == ARDUINO_EVENT_WIFI_STA_CONNECTED) {
    Serial.printf("[wifi] associated; mode=%d status=%d (%s)\n",
                  static_cast<int>(WiFi.getMode()), static_cast<int>(WiFi.status()),
                  wifiStatusName(WiFi.status()));
  } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    Serial.printf("[wifi] got IP %s; mode=%d status=%d (%s)\n",
                  WiFi.localIP().toString().c_str(), static_cast<int>(WiFi.getMode()),
                  static_cast<int>(WiFi.status()), wifiStatusName(WiFi.status()));
    wifiConnectPending = false;
    initialWifiTimeoutReported = false;
    if (wifiReconnectPending) {
      diagnosticLog("INFO", activeScanCycleId, "WIFI_RECONNECT",
                    "reconnected after %lu ms; %s",
                    millis() - wifiReconnectStartedAt, wifiDiagnostics().c_str());
    }
    wifiReconnectPending = false;
    wifiReconnectTimeoutReported = false;
  } else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    const uint8_t reason = info.wifi_sta_disconnected.reason;
    wifiReconnectPending = true;
    wifiReconnectTimeoutReported = false;
    wifiReconnectStartedAt = millis();
    Serial.printf("[wifi] disconnected; reason=%u (%s), mode=%d status=%d (%s); core auto-reconnect=%s\n",
                  static_cast<unsigned>(reason), wifiDisconnectReasonName(reason),
                  static_cast<int>(WiFi.getMode()), static_cast<int>(WiFi.status()),
                  wifiStatusName(WiFi.status()), WiFi.getAutoReconnect() ? "on" : "off");
    diagnosticLog("WARN", activeScanCycleId, "WIFI_RECONNECT",
                  "core reconnect path expected; waiting for STA_CONNECTED/STA_GOT_IP; cause=%u (%s)",
                  static_cast<unsigned>(reason), wifiDisconnectReasonName(reason));
    diagnosticError(activeScanCycleId, "WIFI_DISCONNECT",
                    String("STA_DISCONNECTED reason=" + String(static_cast<unsigned>(reason)) +
                           " (" + wifiDisconnectReasonName(reason) + "); " +
                           wifiDiagnostics()).c_str(),
                    "confirmed station disconnect event; underlying RF/router/authentication cause is not established by this event alone",
                    "compare the disconnect reason with AP/router logs and wait for the core STA_GOT_IP reconnect event");
  } else if (event == ARDUINO_EVENT_WIFI_SCAN_DONE) {
    diagnosticLog("INFO", activeScanCycleId, "WIFI_SCAN_EVENT",
                  "driver completion status=%u networks=%u",
                  static_cast<unsigned>(info.wifi_scan_done.status),
                  static_cast<unsigned>(info.wifi_scan_done.number));
  }
}

const char *resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "POWERON_RESET";
    case ESP_RST_EXT: return "EXT_RESET";
    case ESP_RST_SW: return "SW_RESET";
    case ESP_RST_PANIC: return "PANIC_RESET";
    case ESP_RST_INT_WDT: return "INT_WDT_RESET";
    case ESP_RST_TASK_WDT: return "TASK_WDT_RESET";
    case ESP_RST_WDT: return "WDT_RESET";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP_RESET";
    case ESP_RST_BROWNOUT: return "BROWNOUT_RESET";
    case ESP_RST_SDIO: return "SDIO_RESET";
    default: return "UNKNOWN_RESET";
  }
}

uint16_t color(uint8_t red, uint8_t green, uint8_t blue) {
  return tft.color565(red, green, blue);
}

String clippedText(const String &value, size_t maxLength) {
  if (value.length() <= maxLength) return value;
  return value.substring(0, maxLength - 3) + "...";
}

String jsonText(JsonVariantConst value, const char *fallback = "") {
  if (value.is<const char *>()) return String(value.as<const char *>());
  if (value.is<String>()) return value.as<String>();
  return String(fallback);
}

String securityStatusLabel(const String &status) {
  if (status == "encrypted") return "Encrypted";
  if (status == "weak") return "Weak";
  if (status == "insecure") return "Open";
  return "Unknown";
}

String getSecurityStatus(const String &security) {
  if (security == "Open") return "insecure";
  if (security == "WEP" || security == "WPA" || security == "WPA/WPA2") return "weak";
  if (security == "WPA2" || security == "WPA3" || security == "WPA2/WPA3") {
    return "encrypted";
  }
  return "unknown";
}

String getSnapshotUrl(bool displayOnly = false) {
  String url;
  if (SNAPSHOT_URL[0] != '\0') {
    url = String(SNAPSHOT_URL);
  } else {
    url = API_URL;
    const int scanPath = url.lastIndexOf("/api/scans");
    if (scanPath >= 0) {
      url.remove(scanPath);
      url += "/api/snapshot";
    }
  }

  if (displayOnly) url += url.indexOf('?') >= 0 ? "&display=1" : "?display=1";
  return url;
}

String getAlertsUrl() {
  String url = getSnapshotUrl();
  const int snapshotPath = url.lastIndexOf("/api/snapshot");
  if (snapshotPath >= 0) {
    url.remove(snapshotPath);
    url += "/api/alerts";
  }
  url += url.indexOf('?') >= 0 ? "&display=1" : "?display=1";
  return url;
}

void setBackendState(bool reachable, const String &status) {
  if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
  backendReachable = reachable;
  snapshotStatus = status;
  if (dataMutex) xSemaphoreGive(dataMutex);
  snapshotChanged = true;
}

void drawStartupDiagnostic() {
  const int width = tft.width();
  const int height = tft.height();
  tft.fillScreen(color(2, 6, 23));
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(TFT_WHITE, color(2, 6, 23));
  tft.setTextFont(2);
  tft.drawCentreString("WiFiShield display test", width / 2, height / 2 - 25, 2);
  tft.setTextFont(1);
  tft.setTextColor(color(125, 211, 252), color(2, 6, 23));
  tft.drawCentreString(String(width) + " x " + String(height) +
                       "  Rotation " + String(DISPLAY_ROTATION),
                       width / 2, height / 2 + 2, 1);
  tft.setTextColor(color(203, 213, 225), color(2, 6, 23));
  tft.drawCentreString(
      WiFi.status() == WL_CONNECTED ? "Wi-Fi connected" : "Wi-Fi connecting",
      width / 2, height / 2 + 20, 1);
}

void drawStatusBar() {
  const int width = tft.width();
  tft.fillRect(0, 0, width, 38, color(15, 23, 42));
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(2);
  tft.setTextColor(TFT_WHITE, color(15, 23, 42));
  const char *title = currentScreen == SCREEN_HOME ? "WiFiShield" :
      currentScreen == SCREEN_NETWORKS ? "Networks" :
      currentScreen == SCREEN_ALERTS ? "Security Alerts" :
      currentScreen == SCREEN_SECURITY ? "Security Status" : "Settings";
  tft.drawString(title, 8, 4);

  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  String status = wifiConnected ? "WiFi OK" : "WiFi OFF";
  status += "  API ";
  status += backendReachable ? snapshotStatus : "OFFLINE";
  tft.setTextFont(1);
  tft.setTextColor(wifiConnected ? color(74, 222, 128) : color(248, 113, 113), color(15, 23, 42));
  tft.drawRightString(clippedText(status, 39), width - 7, 20, 1);
  tft.drawFastHLine(7, 36, width - 14, color(51, 65, 85));
}

void drawWifiIcon(int centerX, int centerY, uint16_t iconColor) {
  tft.drawArc(centerX, centerY, 20, 18, 225, 315, iconColor, TFT_BLACK);
  tft.drawArc(centerX, centerY, 13, 11, 225, 315, iconColor, TFT_BLACK);
  tft.drawArc(centerX, centerY, 6, 4, 225, 315, iconColor, TFT_BLACK);
  tft.fillCircle(centerX, centerY + 12, 3, iconColor);
}

void drawAlertIcon(int centerX, int centerY, uint16_t iconColor) {
  tft.drawLine(centerX, centerY - 21, centerX - 22, centerY + 17, iconColor);
  tft.drawLine(centerX - 22, centerY + 17, centerX + 22, centerY + 17, iconColor);
  tft.drawLine(centerX + 22, centerY + 17, centerX, centerY - 21, iconColor);
  tft.drawRoundRect(centerX - 2, centerY - 7, 4, 15, 2, iconColor);
  tft.fillCircle(centerX, centerY + 13, 2, iconColor);
}

void drawShieldIcon(int centerX, int centerY, uint16_t iconColor) {
  tft.drawLine(centerX, centerY - 22, centerX + 19, centerY - 14, iconColor);
  tft.drawLine(centerX + 19, centerY - 14, centerX + 16, centerY + 5, iconColor);
  tft.drawLine(centerX + 16, centerY + 5, centerX, centerY + 22, iconColor);
  tft.drawLine(centerX, centerY + 22, centerX - 16, centerY + 5, iconColor);
  tft.drawLine(centerX - 16, centerY + 5, centerX - 19, centerY - 14, iconColor);
  tft.drawLine(centerX - 19, centerY - 14, centerX, centerY - 22, iconColor);
  tft.drawLine(centerX - 8, centerY, centerX - 2, centerY + 7, iconColor);
  tft.drawLine(centerX - 2, centerY + 7, centerX + 10, centerY - 7, iconColor);
}

void drawSettingsIcon(int centerX, int centerY, uint16_t iconColor) {
  tft.drawCircle(centerX, centerY, 17, iconColor);
  tft.drawCircle(centerX, centerY, 7, iconColor);
  for (int angle = 0; angle < 360; angle += 45) {
    const float radians = angle * 0.0174533f;
    const int innerX = centerX + static_cast<int>(cos(radians) * 18);
    const int innerY = centerY + static_cast<int>(sin(radians) * 18);
    const int outerX = centerX + static_cast<int>(cos(radians) * 23);
    const int outerY = centerY + static_cast<int>(sin(radians) * 23);
    tft.drawLine(innerX, innerY, outerX, outerY, iconColor);
  }
}

void drawFeatureTile(int x, int y, int width, int height, const char *label,
                     uint16_t tileColor, uint8_t icon) {
  tft.fillRoundRect(x, y, width, height, 12, color(30, 41, 59));
  tft.drawRoundRect(x, y, width, height, 12, color(51, 65, 85));
  const int centerX = x + width / 2;
  const int iconY = y + 27;
  if (icon == 0) drawWifiIcon(centerX, iconY, tileColor);
  else if (icon == 1) drawAlertIcon(centerX, iconY, tileColor);
  else if (icon == 2) drawShieldIcon(centerX, iconY, tileColor);
  else drawSettingsIcon(centerX, iconY, tileColor);
  tft.setTextDatum(MC_DATUM);
  tft.setTextFont(2);
  tft.setTextColor(TFT_WHITE, color(30, 41, 59));
  tft.drawString(label, centerX, y + height - 15);
}

void drawHomeScreen() {
  const int width = tft.width();
  const int height = tft.height();
  drawStatusBar();

  const int margin = 9;
  const int gap = 9;
  const int tileWidth = (width - margin * 2 - gap) / 2;
  const int availableHeight = height - 38 - 31 - 17;
  const int tileHeight = (availableHeight - gap) / 2;
  const int firstY = 44;
  const int secondY = firstY + tileHeight + gap;
  drawFeatureTile(margin, firstY, tileWidth, tileHeight, "NETWORKS",
                  color(56, 189, 248), 0);
  drawFeatureTile(margin + tileWidth + gap, firstY, tileWidth, tileHeight, "ALERTS",
                  color(251, 146, 60), 1);
  drawFeatureTile(margin, secondY, tileWidth, tileHeight, "SECURITY",
                  color(74, 222, 128), 2);
  drawFeatureTile(margin + tileWidth + gap, secondY, tileWidth, tileHeight, "SETTINGS",
                  color(196, 181, 253), 3);

  tft.fillRect(0, height - 27, width, 27, color(15, 23, 42));
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(1);
  tft.setTextColor(color(203, 213, 225), color(15, 23, 42));
  String counts = "Networks " + String(networkCount);
  counts += alertDataAvailable
      ? "   Active alerts " + String(activeAlertCount)
      : "   Alerts unavailable";
  tft.drawCentreString(clippedText(counts, 48), width / 2, height - 19, 1);
}

void drawFooter(size_t page, size_t pageCount) {
  const int width = tft.width();
  const int height = tft.height();
  const int buttonY = height - 34;
  tft.fillRect(0, height - 40, width, 40, color(15, 23, 42));
  tft.drawFastHLine(7, buttonY - 3, width - 14, color(51, 65, 85));

  if (currentScreen == SCREEN_NETWORKS || currentScreen == SCREEN_ALERTS) {
    tft.fillRoundRect(7, buttonY, 62, 27, 7, color(30, 41, 59));
    tft.fillRoundRect(width - 69, buttonY, 62, 27, 7, color(30, 41, 59));
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(1);
    tft.setTextColor(page == 0 ? color(100, 116, 139) : TFT_WHITE, color(30, 41, 59));
    tft.drawString("PREV", 38, buttonY + 14);
    tft.setTextColor(page + 1 >= pageCount ? color(100, 116, 139) : TFT_WHITE, color(30, 41, 59));
    tft.drawString("NEXT", width - 38, buttonY + 14);
  }

  const int homeWidth = currentScreen == SCREEN_NETWORKS || currentScreen == SCREEN_ALERTS ? 78 : 100;
  const int homeX = (width - homeWidth) / 2;
  tft.fillRoundRect(homeX, buttonY, homeWidth, 27, 7, color(37, 99, 235));
  tft.setTextDatum(MC_DATUM);
  tft.setTextFont(1);
  tft.setTextColor(TFT_WHITE, color(37, 99, 235));
  tft.drawString("HOME", width / 2, buttonY + 14);
}

void drawNetworkScreen() {
  const int width = tft.width();
  const int height = tft.height();
  drawStatusBar();
  const size_t pages = max(static_cast<size_t>(1),
      (networkCount + NETWORKS_PER_PAGE - 1) / NETWORKS_PER_PAGE);
  const size_t start = networkPage * NETWORKS_PER_PAGE;
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(1);
  tft.setTextColor(color(148, 163, 184), TFT_BLACK);
  String dataLabel = backendReachable ? "Backend scan" : "Cached scan";
  dataLabel += "  " + String(networkPage + 1) + "/" + String(pages);
  tft.drawString(clippedText(dataLabel, 48), 9, 41);

  if (networkCount == 0) {
    tft.setTextFont(2);
    tft.setTextColor(color(203, 213, 225), TFT_BLACK);
    tft.drawCentreString(backendReachable ? "No networks in latest scan" : "Waiting for networks",
                         width / 2, height / 2 - 8, 2);
    if (!backendReachable) {
      tft.setTextFont(1);
      tft.drawCentreString("Backend unavailable; scan will retry", width / 2, height / 2 + 17, 1);
    }
  } else {
    for (size_t index = start; index < networkCount && index < start + NETWORKS_PER_PAGE; index++) {
      const NetworkRecord &network = networks[index];
      const int rowY = 57 + static_cast<int>(index - start) * 49;
      tft.fillRoundRect(7, rowY, width - 14, 45, 7, color(30, 41, 59));
      tft.setTextFont(2);
      tft.setTextColor(TFT_WHITE, color(30, 41, 59));
      String ssid = network.ssid.length() ? network.ssid : "(hidden)";
      tft.drawString(clippedText(ssid, 25), 13, rowY + 5);
      tft.setTextFont(1);
      tft.setTextColor(color(148, 163, 184), color(30, 41, 59));
      tft.drawString(String(network.rssi) + " dBm", 13, rowY + 27);
    }
  }
  if (snapshotStatus == "STALE") {
    tft.setTextFont(1);
    tft.setTextColor(color(251, 191, 36), TFT_BLACK);
    tft.drawCentreString("Backend data is stale", width / 2, height - 47, 1);
  }
  drawFooter(networkPage, pages);
}

void drawAlertScreen() {
  const int width = tft.width();
  const int height = tft.height();
  drawStatusBar();
  const size_t pages = max(static_cast<size_t>(1), securityAlertCount);
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(1);
  tft.setTextColor(color(148, 163, 184), TFT_BLACK);
  String summary = alertDataAvailable
      ? "Active backend findings: " + String(activeAlertCount)
      : "Backend alert data unavailable";
  tft.drawString(clippedText(summary, 45), 9, 42);

  if (!backendReachable || !alertDataAvailable) {
    tft.setTextFont(2);
    tft.setTextColor(color(248, 113, 113), TFT_BLACK);
    tft.drawCentreString(!backendReachable ? "Backend offline" : "Alerts unavailable",
                         width / 2, height / 2 - 8, 2);
    tft.setTextFont(1);
    tft.setTextColor(color(203, 213, 225), TFT_BLACK);
    const char *detail = !alertDataAvailable
        ? (securityAlertCount ? "Showing cached findings" : "Network data remains available")
        : (securityAlertCount ? "Showing last cached findings" : "No current alert data available");
    tft.drawCentreString(detail,
                         width / 2, height / 2 + 16, 1);
  } else if (activeAlertCount == 0) {
    tft.setTextFont(2);
    tft.setTextColor(color(74, 222, 128), TFT_BLACK);
    tft.drawCentreString("No active detector alerts", width / 2, height / 2 - 8, 2);
    tft.setTextFont(1);
    tft.setTextColor(color(203, 213, 225), TFT_BLACK);
    tft.drawCentreString("Heuristic indicators do not confirm attacks", width / 2, height / 2 + 16, 1);
  } else {
    const AlertRecord &alert = securityAlerts[min(alertPage, securityAlertCount - 1)];
    const uint16_t alertColor = alert.severity == "Critical" || alert.severity == "High"
        ? color(248, 113, 113) : color(251, 191, 36);
    tft.fillRoundRect(8, 62, width - 16, height - 108, 9, color(30, 41, 59));
    tft.setTextColor(alertColor, color(30, 41, 59));
    tft.setTextFont(2);
    String title = alert.severity + "  " + alert.type;
    if (alert.hasRiskScore) title += "  " + String(alert.riskScore);
    tft.drawString(clippedText(title, 32), 15, 72);
    tft.setTextFont(1);
    tft.setTextColor(color(203, 213, 225), color(30, 41, 59));
    const String identity = (alert.ssid.length() ? alert.ssid : "(hidden)") +
        "  " + alert.observedBssid;
    tft.drawString(clippedText(identity, 49), 15, 99);
    tft.setTextColor(color(148, 163, 184), color(30, 41, 59));
    tft.drawString(clippedText(alert.evidence, 49), 15, 115);
    tft.setTextColor(TFT_WHITE, color(30, 41, 59));
    String explanation = alert.explanation;
    int lineY = 132;
    for (int line = 0; line < 3 && explanation.length(); line++) {
      size_t splitAt = min(static_cast<size_t>(48), explanation.length());
      if (splitAt < explanation.length()) {
        const int space = explanation.lastIndexOf(' ', splitAt);
        if (space > 0) splitAt = static_cast<size_t>(space);
      }
      tft.drawCentreString(explanation.substring(0, splitAt), width / 2, lineY, 1);
      explanation.remove(0, splitAt);
      explanation.trim();
      lineY += 14;
    }
    tft.setTextColor(color(251, 191, 36), color(30, 41, 59));
    tft.drawCentreString("Heuristic finding; not attack confirmation", width / 2, 180, 1);
  }
  if (snapshotStatus == "STALE") {
    tft.setTextColor(color(251, 191, 36), TFT_BLACK);
    tft.drawCentreString("STALE BACKEND DATA", width / 2, height - 47, 1);
  }
  drawFooter(alertPage, pages);
}

void drawSecurityScreen() {
  const int width = tft.width();
  const int height = tft.height();
  drawStatusBar();
  size_t encrypted = 0;
  size_t weak = 0;
  size_t open = 0;
  size_t unknown = 0;
  for (size_t index = 0; index < networkCount; index++) {
    const String &status = networks[index].securityStatus;
    if (status == "encrypted") encrypted++;
    else if (status == "weak") weak++;
    else if (status == "insecure") open++;
    else unknown++;
  }
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(2);
  tft.setTextColor(color(203, 213, 225), TFT_BLACK);
  tft.drawString("Observed network security", 10, 47);
  tft.setTextFont(1);
  tft.setTextColor(color(74, 222, 128), TFT_BLACK);
  tft.drawString("Encrypted  " + String(encrypted), 14, 75);
  tft.setTextColor(color(251, 191, 36), TFT_BLACK);
  tft.drawString("Weak  " + String(weak) + "     Open  " + String(open), 14, 95);
  tft.setTextColor(color(148, 163, 184), TFT_BLACK);
  tft.drawString("Unknown  " + String(unknown) + "     Networks  " + String(networkCount), 14, 115);
  tft.setTextFont(2);
  tft.setTextColor(color(203, 213, 225), TFT_BLACK);
  tft.drawString("Active backend findings", 10, 143);
  tft.setTextFont(1);
  if (alertDataAvailable) {
    tft.setTextColor(color(248, 113, 113), TFT_BLACK);
    tft.drawString("Critical " + String(criticalAlertCount) + "   High " + String(highAlertCount), 14, 169);
    tft.setTextColor(color(251, 191, 36), TFT_BLACK);
    tft.drawString("Medium " + String(mediumAlertCount) + "   Low " + String(lowAlertCount), 14, 187);
  } else {
    tft.setTextColor(color(248, 113, 113), TFT_BLACK);
    tft.drawString("Alert data unavailable", 14, 169);
  }
  tft.setTextColor(color(148, 163, 184), TFT_BLACK);
  tft.drawCentreString("Backend heuristics are warnings, not attack confirmation.",
                       width / 2, height - 54, 1);
  if (!backendReachable) {
    tft.setTextColor(color(248, 113, 113), TFT_BLACK);
    tft.drawCentreString("Security status unavailable; showing cached data",
                         width / 2, height - 43, 1);
  }
  drawFooter(0, 1);
}

void drawSettingsScreen() {
  const int width = tft.width();
  const int height = tft.height();
  drawStatusBar();
  tft.setTextDatum(TL_DATUM);
  tft.setTextFont(2);
  tft.setTextColor(color(203, 213, 225), TFT_BLACK);
  tft.drawString("Device diagnostics (read-only)", 10, 49);
  tft.setTextFont(1);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.drawString("Device ID: " + String(DEVICE_ID), 12, 72);
  tft.drawString(String("Wi-Fi: ") + (WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected"),
                 12, 91);
  tft.drawString("Wi-Fi IP: " + String(WiFi.status() == WL_CONNECTED
      ? WiFi.localIP().toString() : "unavailable"), 12, 110);
  tft.drawString(String("Backend: ") + (backendReachable ? snapshotStatus : "Offline"),
                 12, 129);
  tft.drawString("Scan interval: " + String(SCAN_INTERVAL_MS / 1000) + " seconds", 12, 148);
  tft.drawString("API: " + clippedText(getSnapshotUrl(), 42), 12, 167);
  tft.drawString("Display: " + String(width) + " x " + String(height) +
      "  Rotation: " + String(DISPLAY_ROTATION), 12, 186);
  drawFooter(0, 1);
}

void renderCurrentScreen() {
  const bool renderingCycleUpdate = scanCycleWaitingForDisplay;
  const uint32_t cycleId = activeScanCycleId;
  if (renderingCycleUpdate) {
    diagnosticLog("INFO", cycleId, "TFT_UPDATE", "start screen=%d",
                  static_cast<int>(currentScreen));
  }
  if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
  tft.fillScreen(color(2, 6, 23));
  switch (currentScreen) {
    case SCREEN_HOME: drawHomeScreen(); break;
    case SCREEN_NETWORKS: drawNetworkScreen(); break;
    case SCREEN_ALERTS: drawAlertScreen(); break;
    case SCREEN_SECURITY: drawSecurityScreen(); break;
    case SCREEN_SETTINGS: drawSettingsScreen(); break;
  }
  if (dataMutex) xSemaphoreGive(dataMutex);
  if (renderingCycleUpdate) {
    diagnosticLog("INFO", cycleId, "TFT_UPDATE", "complete screen=%d",
                  static_cast<int>(currentScreen));
    scanCycleWaitingForDisplay = false;
    scanCycleActive = false;
    diagnosticLog("INFO", cycleId, "SCAN_CYCLE",
                  "complete duration=%lu ms networks=%u active-alerts=%u",
                  millis() - activeScanCycleStartedAt,
                  static_cast<unsigned>(networkCount),
                  static_cast<unsigned>(activeAlertCount));
  }
}

void setLocalScanResults(int found) {
  if (found < 0) return;
  if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
  networkCount = min(static_cast<size_t>(found), MAX_DISPLAY_NETWORKS);
  for (size_t index = 0; index < networkCount; index++) {
    networks[index].ssid = WiFi.SSID(index);
    networks[index].bssid = WiFi.BSSIDstr(index);
    networks[index].rssi = WiFi.RSSI(index);
    networks[index].channel = WiFi.channel(index);
    networks[index].security = securityName(WiFi.encryptionType(index));
    networks[index].securityStatus = getSecurityStatus(networks[index].security);
    networks[index].trusted = false;
    networks[index].suspicious = false;
  }
  if (dataMutex) xSemaphoreGive(dataMutex);
  snapshotChanged = true;
}

void populateAlertData(JsonArray sourceAlerts, uint32_t cycleId) {
  if (sourceAlerts.isNull()) return;

  if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
  securityAlertCount = 0;
  activeAlertCount = 0;
  highPriorityAlertCount = 0;
  criticalAlertCount = 0;
  highAlertCount = 0;
  mediumAlertCount = 0;
  lowAlertCount = 0;
  for (JsonObject alert : sourceAlerts) {
    const String status = jsonText(alert["status"], "New");
    if (status == "Resolved") continue;

    activeAlertCount++;
    const String severity = jsonText(alert["severity"], "Unknown");
    if (severity == "Critical") criticalAlertCount++;
    else if (severity == "High") highAlertCount++;
    else if (severity == "Medium") mediumAlertCount++;
    else lowAlertCount++;
    if (severity == "Critical" || severity == "High") highPriorityAlertCount++;
    if (securityAlertCount >= MAX_DISPLAY_ALERTS) continue;

    AlertRecord &target = securityAlerts[securityAlertCount++];
    target.type = jsonText(alert["type"], "DETECTION");
    target.severity = severity;
    target.ssid = jsonText(alert["ssid"]);
    target.observedBssid = jsonText(alert["observedBssid"]);
    target.trustedBssid = jsonText(alert["trustedBssid"]);
    target.message = jsonText(alert["message"]);
    target.explanation = jsonText(alert["explanation"]);
    if (!target.explanation.length()) {
      if (target.message.length()) target.explanation = target.message;
      else target.explanation = "Backend finding; details unavailable.";
    }
    target.status = status;
    target.hasRiskScore = alert["riskScore"].is<int>();
    target.riskScore = alert["riskScore"] | 0;
    target.evidence = "";
    JsonObject evidence = alert["evidence"].as<JsonObject>();
    if (!evidence.isNull()) {
      const String observedSecurity = jsonText(evidence["observedSecurity"]);
      const String expectedSecurity = jsonText(evidence["expectedSecurity"]);
      if (observedSecurity.length()) target.evidence += "Security " + observedSecurity;
      if (expectedSecurity.length()) {
        if (target.evidence.length()) target.evidence += "; ";
        target.evidence += "expected " + expectedSecurity;
      }
      if (evidence["rssi"].is<int>()) {
        if (target.evidence.length()) target.evidence += "; ";
        target.evidence += "RSSI " + String(evidence["rssi"].as<int>()) + " dBm";
      }
      if (evidence["rssiDeviationDb"].is<float>() || evidence["rssiDeviationDb"].is<int>()) {
        if (target.evidence.length()) target.evidence += "; ";
        target.evidence += "change " + String(evidence["rssiDeviationDb"].as<float>(), 1) + " dB";
      }
    }
  }
  alertDataAvailable = true;
  if (dataMutex) xSemaphoreGive(dataMutex);
  digitalWrite(ALERT_LED_PIN, highPriorityAlertCount ? HIGH : LOW);
  snapshotChanged = true;
  diagnosticLog("INFO", cycleId, "JSON_ALERTS",
                "loaded=%u active=%u critical=%u high=%u medium=%u low=%u LED=%s",
                static_cast<unsigned>(securityAlertCount),
                static_cast<unsigned>(activeAlertCount),
                static_cast<unsigned>(criticalAlertCount),
                static_cast<unsigned>(highAlertCount),
                static_cast<unsigned>(mediumAlertCount),
                static_cast<unsigned>(lowAlertCount),
                highPriorityAlertCount ? "ON" : "OFF");
}

void markAlertDataUnavailable() {
  if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
  alertDataAvailable = false;
  if (dataMutex) xSemaphoreGive(dataMutex);
  snapshotChanged = true;
}

bool populateSnapshot(DynamicJsonDocument &snapshot, uint32_t cycleId,
                      bool &alertsApplied) {
  alertsApplied = false;
  JsonArray sourceNetworks = snapshot["networks"].as<JsonArray>();
  JsonArray sourceAlerts = snapshot["securityAlerts"].as<JsonArray>();
  logJsonShape("JSON_SNAPSHOT_NETWORKS", cycleId, snapshot, "networks");
  if (!snapshot.is<JsonObject>()) {
    diagnosticError(cycleId, "JSON_SNAPSHOT",
                    "response root is not an object",
                    "backend response root type does not match snapshot contract",
                    "inspect the bounded HTTP body preview and the backend /api/snapshot response");
    return false;
  }
  if (!snapshot["networks"].is<JsonArray>()) {
    const String keys = jsonRootKeys(snapshot.as<JsonObjectConst>());
    const String observedType = snapshot["networks"].isNull() ? "missing/null" :
        snapshot["networks"].is<JsonObject>() ? "object" :
        snapshot["networks"].is<const char *>() ? "string" : "scalar";
    diagnosticError(cycleId, "JSON_SNAPSHOT",
                    String("expected root key networks as array; observed type=" +
                           observedType + "; root keys=" + keys).c_str(),
                    "confirmed snapshot schema mismatch for networks",
                    "inspect server/index.js makeSnapshot() and the logged raw response preview");
    return false;
  }

  if (dataMutex) xSemaphoreTake(dataMutex, portMAX_DELAY);
  networkCount = 0;
  for (JsonObject network : sourceNetworks) {
    if (networkCount >= MAX_DISPLAY_NETWORKS) break;
    NetworkRecord &target = networks[networkCount++];
    target.ssid = jsonText(network["ssid"]);
    target.bssid = jsonText(network["bssid"]);
    target.rssi = network["rssi"] | 0;
    target.channel = network["channel"] | 0;
    target.security = jsonText(network["security"], "Unknown");
    target.securityStatus = jsonText(network["securityStatus"], "unknown");
    target.trusted = network["trusted"] | false;
    target.suspicious = network["suspicious"] | false;
  }

  scannedAt = jsonText(snapshot["scannedAt"]);
  const String status = jsonText(snapshot["status"], "waiting");
  snapshotStatus = status == "stale" ? "STALE" :
      status == "live" ? "LIVE" : "WAITING";
  backendReachable = true;
  networkPage = 0;
  alertPage = 0;
  if (dataMutex) xSemaphoreGive(dataMutex);
  diagnosticLog("INFO", cycleId, "JSON_SNAPSHOT",
                "snapshot applied network count=%u scannedAt=%s receivedAt=%s status=%s",
                static_cast<unsigned>(networkCount), scannedAt.c_str(),
                jsonText(snapshot["receivedAt"], "(missing)").c_str(),
                snapshotStatus.c_str());
  if (!snapshot["securityAlerts"].is<JsonArray>()) {
    const String keys = jsonRootKeys(snapshot.as<JsonObjectConst>());
    const String observedType = snapshot["securityAlerts"].isNull() ? "missing/null" :
        snapshot["securityAlerts"].is<JsonObject>() ? "object" :
        snapshot["securityAlerts"].is<const char *>() ? "string" : "scalar";
    diagnosticError(cycleId, "JSON_SNAPSHOT",
                    String("networks accepted; expected optional securityAlerts array; observed type=" +
                           observedType + "; root keys=" + keys).c_str(),
                    "confirmed alert field mismatch or omission; networks remain usable",
                    "check server/index.js makeSnapshot() and GET /api/alerts fallback");
    markAlertDataUnavailable();
  } else {
    logJsonShape("JSON_SNAPSHOT_ALERTS", cycleId, snapshot, "securityAlerts");
    populateAlertData(sourceAlerts, cycleId);
    alertsApplied = true;
  }
  snapshotChanged = true;
  return true;
}

void fetchAlertsFallback(uint32_t cycleId) {
  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(5000);
  String responseBody;
  String contentType;
  int statusCode = -1;
  const String url = getAlertsUrl();
  if (!performHttpRequest(http, "GET_ALERTS", url, nullptr, 0, HTTP_CODE_OK,
                          cycleId, responseBody, contentType, statusCode)) {
    markAlertDataUnavailable();
    return;
  }
  if (!responseBody.length()) {
    diagnosticError(cycleId, "JSON_ALERTS",
                    "HTTP response body length=0; JSON parsing skipped",
                    "confirmed empty response body",
                    "inspect backend GET /api/alerts response generation and server access log");
    markAlertDataUnavailable();
    return;
  }

  DynamicJsonDocument alertsDocument(SNAPSHOT_DOCUMENT_CAPACITY);
  const DeserializationError error = deserializeJson(alertsDocument, responseBody);
  if (error) {
    diagnosticError(cycleId, "JSON_ALERTS",
                    String("ArduinoJson deserializeJson failed: " + String(error.c_str()) +
                           "; body-length=" + String(responseBody.length()) +
                           "; capacity=" + String(alertsDocument.capacity()) +
                           "; overflowed=" + String(alertsDocument.overflowed() ? "yes" : "no") +
                           "; body-kind=" + responseBodyKind(responseBody, contentType) +
                           "; preview=\"" + boundedPreview(responseBody) + "\"").c_str(),
                    error == DeserializationError::NoMemory
                        ? "document capacity exhausted while parsing the response"
                        : "response body is not valid JSON according to ArduinoJson",
                    error == DeserializationError::NoMemory
                        ? "compare body length and document capacity; inspect alert volume before increasing allocation"
                        : "inspect the raw preview and backend GET /api/alerts response");
    markAlertDataUnavailable();
    return;
  }

  if (alertsDocument.overflowed()) {
    diagnosticError(cycleId, "JSON_ALERTS",
                    "ArduinoJson document reports overflow after successful deserialization",
                    "document capacity was exceeded",
                    "inspect alert array size and memory usage before changing the document capacity");
    markAlertDataUnavailable();
    return;
  }
  logJsonShape("JSON_ALERTS", cycleId, alertsDocument, "alerts");
  if (!alertsDocument.is<JsonObject>()) {
    diagnosticError(cycleId, "JSON_ALERTS",
                    "response root is not an object",
                    "backend /api/alerts root type does not match {alerts: []}",
                    "inspect the logged root type and raw response preview");
    markAlertDataUnavailable();
    return;
  }
  JsonArray sourceAlerts = alertsDocument["alerts"].as<JsonArray>();
  if (!alertsDocument["alerts"].is<JsonArray>()) {
    const String keys = jsonRootKeys(alertsDocument.as<JsonObjectConst>());
    diagnosticError(cycleId, "JSON_ALERTS",
                    String("expected root key alerts as array; observed type=" +
                           String(alertsDocument["alerts"].isNull() ? "missing/null" : "wrong type") +
                           "; root keys=" + keys).c_str(),
                    "confirmed /api/alerts schema mismatch",
                    "inspect server/index.js GET /api/alerts response and the backend access log");
    markAlertDataUnavailable();
    return;
  }
  populateAlertData(sourceAlerts, cycleId);
}

String makeScanPayload(size_t count, uint32_t cycleId) {
  DynamicJsonDocument document(32768);
  document["deviceId"] = DEVICE_ID;
  JsonArray scanNetworks = document.createNestedArray("networks");
  for (size_t index = 0; index < count; index++) {
    JsonObject network = scanNetworks.createNestedObject();
    network["ssid"] = WiFi.SSID(index);
    network["bssid"] = WiFi.BSSIDstr(index);
    network["rssi"] = WiFi.RSSI(index);
    network["channel"] = WiFi.channel(index);
    network["security"] = securityName(WiFi.encryptionType(index));
  }
  if (document.overflowed()) {
    diagnosticError(cycleId, "SCAN_PAYLOAD",
                    "ArduinoJson scan payload document overflowed; scan results were not serialized",
                    "scan payload document capacity exceeded",
                    "reduce MAX_NETWORKS_PER_SCAN or inspect payload document capacity");
    return "";
  }
  String payload;
  const size_t expectedLength = measureJson(document);
  const size_t written = serializeJson(document, payload);
  if (written != expectedLength || !payload.length()) {
    diagnosticError(cycleId, "SCAN_PAYLOAD",
                    String("serializeJson length mismatch; expected=" +
                           String(expectedLength) + " written=" + String(written) +
                           " actual-string-length=" + String(payload.length())).c_str(),
                    "scan payload serialization did not produce the complete JSON body",
                    "inspect heap availability and ArduinoJson document overflow");
    return "";
  }
  diagnosticLog("INFO", cycleId, "SCAN_PAYLOAD",
                "serialized deviceId=%s networks=%u payload-bytes=%u; network identifiers omitted from logs",
                DEVICE_ID, static_cast<unsigned>(count),
                static_cast<unsigned>(payload.length()));
  return payload;
}

void finishCycleWithoutDisplay(uint32_t cycleId, const char *reason) {
  diagnosticLog("INFO", cycleId, "TFT_UPDATE",
                "skipped because no new backend snapshot was applied; reason=%s", reason);
  scanCycleActive = false;
  diagnosticLog("INFO", cycleId, "SCAN_CYCLE",
                "complete with skipped stage; duration=%lu ms reason=%s",
                millis() - activeScanCycleStartedAt, reason);
}

void inspectPostResponse(const String &body, uint32_t cycleId, int statusCode) {
  if (!body.length()) {
    diagnosticError(cycleId, "JSON_POST_SCANS",
                    "HTTP response body length=0; POST status was received",
                    "backend replied without a body; transport itself completed",
                    "inspect the matching backend route response; HTTP 201 still indicates accepted scan");
    return;
  }
  DynamicJsonDocument document(2048);
  const DeserializationError error = deserializeJson(document, body);
  if (error) {
    diagnosticError(cycleId, "JSON_POST_SCANS",
                    String("ArduinoJson error=" + String(error.c_str()) +
                           "; HTTP=" + String(statusCode) +
                           "; preview=\"" + boundedPreview(body) + "\"").c_str(),
                    "scan POST response body is not valid JSON",
                    "compare the response preview with the existing POST /api/scans response contract");
    return;
  }
  if (!document.is<JsonObject>()) {
    diagnosticError(cycleId, "JSON_POST_SCANS",
                    "successful HTTP response root is not an object",
                    "POST response shape differs from the backend contract",
                    "inspect the logged response preview and server/index.js POST /api/scans route");
    return;
  }
  diagnosticLog("INFO", cycleId, "JSON_POST_SCANS",
                "valid response object keys=%s accepted=%s networks=%d",
                jsonRootKeys(document.as<JsonObjectConst>()).c_str(),
                document["accepted"] | false ? "true" : "false",
                document["networks"] | -1);
}

void backendTask(void *parameter) {
  ScanRequest *request = static_cast<ScanRequest *>(parameter);
  const uint32_t cycleId = request->cycleId;
  diagnosticLog("INFO", cycleId, "HTTP_POST_SCANS",
                "cycle enters backend task after scan; networks=%u payload-bytes=%u",
                static_cast<unsigned>(request->networkCount),
                static_cast<unsigned>(request->payload.length()));
  HTTPClient postClient;
  postClient.setConnectTimeout(3000);
  postClient.setTimeout(5000);
  String postBody;
  String postContentType;
  int statusCode = -1;
  const bool postSucceeded = performHttpRequest(
      postClient, "POST_SCANS", String(API_URL), &request->payload,
      request->networkCount, HTTP_CODE_CREATED, cycleId,
      postBody, postContentType, statusCode, DEVICE_TOKEN);
  if (postSucceeded) {
    diagnosticLog("INFO", cycleId, "HTTP_POST_SCANS",
                  "scan accepted by HTTP status=%d", statusCode);
    inspectPostResponse(postBody, cycleId, statusCode);
  } else {
    diagnosticLog("WARN", cycleId, "HTTP_POST_SCANS",
                  "POST unsuccessful; proceeding to snapshot GET to preserve existing refresh behavior");
  }

  HTTPClient snapshotClient;
  snapshotClient.setConnectTimeout(3000);
  snapshotClient.setTimeout(5000);
  String snapshotBody;
  String snapshotContentType;
  int snapshotCode = -1;
  const bool snapshotRequestSucceeded = performHttpRequest(
      snapshotClient, "GET_SNAPSHOT", getSnapshotUrl(true), nullptr, 0,
      HTTP_CODE_OK, cycleId, snapshotBody, snapshotContentType, snapshotCode);
  bool snapshotApplied = false;
  if (!snapshotRequestSucceeded) {
    setBackendState(false, "OFFLINE");
  } else if (!snapshotBody.length()) {
    diagnosticError(cycleId, "JSON_SNAPSHOT",
                    "HTTP response body length=0; JSON parsing skipped",
                    "confirmed empty snapshot response body",
                    "inspect backend GET /api/snapshot response generation and its correlated access log");
    setBackendState(true, "BAD DATA");
  } else {
    DynamicJsonDocument snapshot(SNAPSHOT_DOCUMENT_CAPACITY);
    const DeserializationError error = deserializeJson(snapshot, snapshotBody);
    if (error) {
      diagnosticError(cycleId, "JSON_SNAPSHOT",
                      String("ArduinoJson deserializeJson error=" +
                             String(error.c_str()) +
                             "; body-length=" + String(snapshotBody.length()) +
                             "; content-type=" + snapshotContentType +
                             "; document-capacity=" + String(snapshot.capacity()) +
                             "; memory-usage=" + String(snapshot.memoryUsage()) +
                             "; overflowed=" + String(snapshot.overflowed() ? "yes" : "no") +
                             "; body-kind=" + responseBodyKind(snapshotBody, snapshotContentType) +
                             "; preview=\"" + boundedPreview(snapshotBody) + "\"").c_str(),
                      error == DeserializationError::NoMemory
                          ? "ArduinoJson reported NoMemory while parsing the unfiltered snapshot; no filter was used"
                          : "response body is invalid JSON or has a truncated/unsupported representation",
                      error == DeserializationError::NoMemory
                          ? "compare response size/document capacity and alert/history volume; consider a filtered fallback only after confirming memory limits"
                          : "inspect the bounded body preview and correlated backend HTTP status/content-type");
      setBackendState(true, "BAD DATA");
    } else if (snapshot.overflowed()) {
      diagnosticError(cycleId, "JSON_SNAPSHOT",
                      String("document overflow after parse; capacity=" +
                             String(snapshot.capacity()) + "; usage=" +
                             String(snapshot.memoryUsage()) + "; body-length=" +
                             String(snapshotBody.length())).c_str(),
                      "ArduinoJson document overflowed without a deserialization error",
                      "inspect snapshot size and document capacity before reducing the response contract");
      setBackendState(true, "BAD DATA");
    } else {
      logJsonShape("JSON_SNAPSHOT", cycleId, snapshot, "networks");
      logJsonShape("JSON_SNAPSHOT", cycleId, snapshot, "securityAlerts");
      bool snapshotAlertsApplied = false;
      snapshotApplied = populateSnapshot(snapshot, cycleId, snapshotAlertsApplied);
      if (!snapshotAlertsApplied) {
        diagnosticLog("INFO", cycleId, "JSON_SNAPSHOT",
                      "network snapshot applied; detector alert array unavailable, trying existing /api/alerts fallback");
      }
      // A missing alert field does not invalidate usable network data.
      if (!snapshotAlertsApplied) snapshotApplied = false;
      if (!snapshotApplied) {
        if (!snapshot["networks"].is<JsonArray>()) setBackendState(true, "BAD DATA");
      }
    }
  }

  if (snapshotRequestSucceeded && !snapshotApplied) {
    diagnosticLog("INFO", cycleId, "HTTP_ALERTS",
                  "starting existing /api/alerts fallback because snapshot alerts were not applied");
    fetchAlertsFallback(cycleId);
  } else if (!snapshotRequestSucceeded) {
    diagnosticLog("INFO", cycleId, "HTTP_ALERTS",
                  "fallback skipped because snapshot transport/status failed; existing alert cache retained");
  }

  scanCycleWaitingForDisplay = true;
  snapshotChanged = true;
  diagnosticLog("INFO", cycleId, "SCAN_CYCLE",
                "backend stages finished; POST success=%s HTTP_POST=%d; snapshot success=%s HTTP_SNAPSHOT=%d",
                postSucceeded ? "yes" : "no", statusCode,
                snapshotRequestSucceeded ? "yes" : "no", snapshotCode);
  delete request;
  apiTaskHandle = nullptr;
  vTaskDelete(nullptr);
}

void startBackendRequest(size_t count, uint32_t cycleId,
                         const String *queuedPayload = nullptr) {
  if (apiTaskHandle) {
    diagnosticError(cycleId, "BACKEND_TASK",
                    "backend task already exists; overlapping scan request was not started",
                    "confirmed task overlap guard prevented a second request",
                    "inspect scan-cycle logs and task completion for the active cycle");
    scanCycleWaitingForDisplay = true;
    snapshotChanged = true;
    return;
  }
  String payload = queuedPayload ? *queuedPayload : makeScanPayload(count, cycleId);
  if (!payload.length()) {
    finishCycleWithoutDisplay(cycleId, "scan payload serialization failed");
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (!queuedPayload) {
      pendingScanPayload = payload;
      pendingScanNetworkCount = count;
      pendingScanCycleId = cycleId;
      pendingScanCycleStartedAt = activeScanCycleStartedAt;
      pendingScanRetryAfter = millis();
      pendingScanUpload = true;
    }
    diagnosticError(cycleId, "BACKEND_TASK",
                    String("POST deferred with serialized scan payload retained; " +
                           wifiDiagnostics()).c_str(),
                    "confirmed Wi-Fi disconnected before POST; scan results are queued, not discarded",
                    "wait for STA_GOT_IP; firmware will submit the queued scan before starting another scan");
    return;
  }
  ScanRequest *request = new (std::nothrow) ScanRequest{
      payload, count, cycleId,
      queuedPayload ? pendingScanCycleStartedAt : activeScanCycleStartedAt};
  if (!request) {
    diagnosticError(cycleId, "BACKEND_TASK",
                    "heap allocation for ScanRequest returned null",
                    "confirmed heap allocation failure",
                    "inspect free heap and reduce simultaneous response/document memory");
    if (!queuedPayload) {
      pendingScanPayload = payload;
      pendingScanNetworkCount = count;
      pendingScanCycleId = cycleId;
      pendingScanCycleStartedAt = activeScanCycleStartedAt;
      pendingScanUpload = true;
    }
    pendingScanRetryAfter = millis() + SCAN_RETRY_DELAY_MS;
    finishCycleWithoutDisplay(cycleId, "ScanRequest allocation failed");
    return;
  }
  const unsigned payloadLength = static_cast<unsigned>(request->payload.length());
  if (xTaskCreate(backendTask, "wifiBackend", 12288, request, 1, &apiTaskHandle) != pdPASS) {
    delete request;
    apiTaskHandle = nullptr;
    diagnosticError(cycleId, "BACKEND_TASK",
                    "xTaskCreate returned failure for wifiBackend (stack=12288 bytes)",
                    "confirmed backend task creation failure",
                    "inspect free heap, available task stack/heap and task creation return value");
    if (!queuedPayload) {
      pendingScanPayload = payload;
      pendingScanNetworkCount = count;
      pendingScanCycleId = cycleId;
      pendingScanCycleStartedAt = activeScanCycleStartedAt;
    }
    pendingScanUpload = true;
    pendingScanRetryAfter = millis() + SCAN_RETRY_DELAY_MS;
    finishCycleWithoutDisplay(cycleId, "backend task creation failed");
    return;
  }
  if (queuedPayload) {
    pendingScanPayload = "";
    pendingScanUpload = false;
  }
  diagnosticLog("INFO", cycleId, "BACKEND_TASK",
                "created wifiBackend task; scan networks=%u payload-bytes=%u",
                static_cast<unsigned>(count),
                payloadLength);
}

String securityName(wifi_auth_mode_t authMode) {
  switch (authMode) {
    case WIFI_AUTH_OPEN: return "Open";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA";
    case WIFI_AUTH_WPA2_PSK:
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2";
    case WIFI_AUTH_WPA3_PSK: return "WPA3";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3";
    default: return "Unknown";
  }
}

void connectToNetwork() {
  if (!WIFI_SSID || WIFI_SSID[0] == '\0') {
    wifiConnectPending = false;
    diagnosticError(0, "WIFI_CONFIG",
                    "configured SSID is empty; WiFi.begin was not called",
                    "confirmed missing Wi-Fi network configuration",
                    "set WIFISHIELD_WIFI_SSID in the local wifi_shield_config.h; do not share its password");
    return;
  }
  wifiConnectPending = true;
  lastWifiAttempt = millis();
  diagnosticLog("INFO", 0, "WIFI_CONNECT",
                "initial connection attempt; SSID configured=yes; password omitted; %s",
                wifiDiagnostics().c_str());
  const wl_status_t beginStatus = WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  diagnosticLog("INFO", 0, "WIFI_CONNECT",
                "WiFi.begin returned=%d (%s); auto-reconnect=%s; %s",
                static_cast<int>(beginStatus), wifiStatusName(beginStatus),
                WiFi.getAutoReconnect() ? "on" : "off", wifiDiagnostics().c_str());
}

void scheduleScanRetry(uint32_t cycleId, const char *phase, int result) {
  scanRetryPending = true;
  scanRetryAfter = millis() + SCAN_RETRY_DELAY_MS;
  const String details = String("WiFi.scanNetworks/scanComplete phase=") + phase +
      ", return=" + String(result) +
      (result == WIFI_SCAN_FAILED ? " (WIFI_SCAN_FAILED=-2)" : "") +
      ", scanInProgress=" + (scanInProgress ? "true" : "false") +
      ", apiTaskActive=" + (apiTaskHandle ? "true" : "false") +
      ", retry-after=" + String(scanRetryAfter) + " ms uptime, " + wifiDiagnostics();
  diagnosticError(cycleId, "WIFI_SCAN", details.c_str(),
                  "driver returned WIFI_SCAN_FAILED; current state is logged, but driver-level cause is not exposed by this API",
                  "check the preceding scan-start and driver scan-event logs; confirm no external code controls Wi-Fi and capture repeated reset reasons");
  finishCycleWithoutDisplay(cycleId, "WiFi scan failed");
}

void beginScan(uint32_t cycleId) {
  if (scanInProgress || apiTaskHandle || wifiConnectPending) {
    diagnosticError(cycleId, "WIFI_SCAN",
                    String("scan skipped by guard; scanInProgress=" +
                           String(scanInProgress ? "true" : "false") +
                           " apiTaskActive=" + (apiTaskHandle ? "true" : "false") +
                           " connectionPending=" + (wifiConnectPending ? "true" : "false")).c_str(),
                    "confirmed existing scan/task/connection guard blocked a new scan",
                    "inspect the active scan/task completion log before retrying");
    finishCycleWithoutDisplay(cycleId, "scan precondition guard");
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    scanRetryPending = true;
    scanRetryAfter = millis() + SCAN_RETRY_DELAY_MS;
    diagnosticLog("WARN", cycleId, "WIFI_SCAN",
                  "scan deferred until Wi-Fi is connected; status=%d (%s)",
                  static_cast<int>(WiFi.status()), wifiStatusName(WiFi.status()));
    return;
  }
  if (WiFi.getMode() != WIFI_STA) {
    diagnosticError(cycleId, "WIFI_SCAN",
                    String("scan not started outside station mode; mode=" +
                           String(static_cast<int>(WiFi.getMode()))).c_str(),
                    "confirmed Wi-Fi mode is not WIFI_STA",
                    "check station initialization before scanning");
    scanRetryPending = true;
    scanRetryAfter = millis() + SCAN_RETRY_DELAY_MS;
    return;
  }

  scanRetryPending = false;
  activeWifiScanStartedAt = millis();
  diagnosticLog("INFO", cycleId, "WIFI_SCAN", "start; Wi-Fi connected; asynchronous scan requested");
  const int result = WiFi.scanNetworks(true, true);
  if (result == WIFI_SCAN_RUNNING) {
    scanInProgress = true;
  } else if (result >= 0) {
    diagnosticLog("INFO", cycleId, "WIFI_SCAN",
                  "completed immediately; networks=%d", result);
    setLocalScanResults(result);
    for (int index = 0; index < result; index++) {
      Serial.printf("[SCAN][CYCLE %lu] SSID=\"%s\" RSSI=%d dBm CH=%d security=%s BSSID=%s\n",
                    static_cast<unsigned long>(cycleId), WiFi.SSID(index).c_str(),
                    WiFi.RSSI(index), WiFi.channel(index),
                    securityName(WiFi.encryptionType(index)).c_str(),
                    WiFi.BSSIDstr(index).c_str());
    }
    startBackendRequest(min(static_cast<size_t>(result), MAX_NETWORKS_PER_SCAN), cycleId);
    WiFi.scanDelete();
  } else {
    scheduleScanRetry(cycleId, "start", result);
    WiFi.scanDelete();
  }
}

void pollScan() {
  if (!scanInProgress) return;
  const int result = WiFi.scanComplete();
  if (result == WIFI_SCAN_RUNNING) return;

  scanInProgress = false;
  if (result < 0) {
    scheduleScanRetry(activeScanCycleId, "completion", result);
    WiFi.scanDelete();
    return;
  }

  diagnosticLog("INFO", activeScanCycleId, "WIFI_SCAN",
                "complete; networks=%d duration=%lu ms",
                result, millis() - activeWifiScanStartedAt);
  setLocalScanResults(result);
  for (int index = 0; index < result; index++) {
    Serial.printf("[SCAN][CYCLE %lu] SSID=\"%s\" RSSI=%d dBm CH=%d security=%s BSSID=%s\n",
                  static_cast<unsigned long>(activeScanCycleId), WiFi.SSID(index).c_str(),
                  WiFi.RSSI(index), WiFi.channel(index),
                  securityName(WiFi.encryptionType(index)).c_str(),
                  WiFi.BSSIDstr(index).c_str());
  }
  startBackendRequest(min(static_cast<size_t>(result), MAX_NETWORKS_PER_SCAN),
                      activeScanCycleId);
  WiFi.scanDelete();
}

void mapTouchPoint(const TS_Point &point, int &screenX, int &screenY) {
  int rawX = point.x;
  int rawY = point.y;
  if (TOUCH_SWAP_AXES) {
    const int temporary = rawX;
    rawX = rawY;
    rawY = temporary;
  }
  int mappedX = map(rawX, TOUCH_RAW_X_MIN, TOUCH_RAW_X_MAX, 0, tft.width() - 1);
  int mappedY = map(rawY, TOUCH_RAW_Y_MIN, TOUCH_RAW_Y_MAX, 0, tft.height() - 1);
  if (TOUCH_INVERT_X) mappedX = tft.width() - 1 - mappedX;
  if (TOUCH_INVERT_Y) mappedY = tft.height() - 1 - mappedY;
  screenX = constrain(mappedX, 0, tft.width() - 1);
  screenY = constrain(mappedY, 0, tft.height() - 1);
}

void changePage(int direction) {
  if (currentScreen == SCREEN_NETWORKS) {
    const size_t pages = max(static_cast<size_t>(1),
        (networkCount + NETWORKS_PER_PAGE - 1) / NETWORKS_PER_PAGE);
    if (direction < 0 && networkPage > 0) networkPage--;
    else if (direction > 0 && networkPage + 1 < pages) networkPage++;
  } else if (currentScreen == SCREEN_ALERTS) {
    const size_t pages = max(static_cast<size_t>(1), securityAlertCount);
    if (direction < 0 && alertPage > 0) alertPage--;
    else if (direction > 0 && alertPage + 1 < pages) alertPage++;
  }
  renderCurrentScreen();
}

void handleTouch(int x, int y) {
  const int width = tft.width();
  const int height = tft.height();
  if (currentScreen == SCREEN_HOME) {
    const int margin = 9;
    const int gap = 9;
    const int tileWidth = (width - margin * 2 - gap) / 2;
    const int tileHeight = (height - 38 - 31 - 17 - gap) / 2;
    const int firstY = 44;
    const int secondY = firstY + tileHeight + gap;
    if (x >= margin && x < margin + tileWidth && y >= firstY && y < firstY + tileHeight) {
      currentScreen = SCREEN_NETWORKS;
    } else if (x >= margin + tileWidth + gap && x < width - margin &&
               y >= firstY && y < firstY + tileHeight) {
      currentScreen = SCREEN_ALERTS;
    } else if (x >= margin && x < margin + tileWidth &&
               y >= secondY && y < secondY + tileHeight) {
      currentScreen = SCREEN_SECURITY;
    } else if (x >= margin + tileWidth + gap && x < width - margin &&
               y >= secondY && y < secondY + tileHeight) {
      currentScreen = SCREEN_SETTINGS;
    } else {
      return;
    }
    renderCurrentScreen();
    return;
  }

  const int buttonY = height - 34;
  if (y < buttonY - 3 || y > height - 4) return;
  if (x >= width / 2 - 55 && x <= width / 2 + 55) {
    currentScreen = SCREEN_HOME;
    renderCurrentScreen();
  } else if (currentScreen == SCREEN_NETWORKS || currentScreen == SCREEN_ALERTS) {
    changePage(x < width / 2 ? -1 : 1);
  }
}

void pollTouch() {
  if (!touch.touched()) {
    touchWasDown = false;
    return;
  }
  if (touchWasDown || millis() - lastTouchMillis < TOUCH_DEBOUNCE_MS) return;
  touchWasDown = true;
  lastTouchMillis = millis();

  const TS_Point point = touch.getPoint();
  const bool coordinatesInRange =
      point.x >= TOUCH_RAW_X_MIN && point.x <= TOUCH_RAW_X_MAX &&
      point.y >= TOUCH_RAW_Y_MIN && point.y <= TOUCH_RAW_Y_MAX;
  if (point.z < 400 || !coordinatesInRange) {
    Serial.printf("[TOUCH] rejected raw X=%d Y=%d Z=%d; check XPT2046 SPI/wiring and calibrate with measured panel corners\n",
                  point.x, point.y, point.z);
    return;
  }

  int x = 0;
  int y = 0;
  mapTouchPoint(point, x, y);
  Serial.printf("[TOUCH] raw X=%d Y=%d Z=%d -> screen X=%d Y=%d\n",
                point.x, point.y, point.z, x, y);
  handleTouch(x, y);
}

void setup() {
  Serial.begin(115200);
  pinMode(TFT_CS, OUTPUT);
  digitalWrite(TFT_CS, HIGH);
  pinMode(TOUCH_CS_PIN, OUTPUT);
  digitalWrite(TOUCH_CS_PIN, HIGH);
  pinMode(TFT_RST, OUTPUT);
  digitalWrite(TFT_RST, HIGH);
  delay(10);
  digitalWrite(TFT_RST, LOW);
  delay(20);
  digitalWrite(TFT_RST, HIGH);
  delay(120);

  SPI.begin(SPI_SCK_PIN, SPI_MISO_PIN, SPI_MOSI_PIN);
  tft.init();
  tft.setRotation(DISPLAY_ROTATION);
  tft.fillScreen(color(2, 6, 23));
  drawStartupDiagnostic();
  Serial.printf("[TFT] initialized with ILI9341; size=%d x %d rotation=%u CS=%d DC=%d RESET=%d SCK=%d MOSI=%d MISO=%d\n",
                tft.width(), tft.height(), DISPLAY_ROTATION,
                TFT_CS, TFT_DC, TFT_RST, SPI_SCK_PIN, SPI_MOSI_PIN, SPI_MISO_PIN);

  touch.begin(SPI);
  touch.setRotation(DISPLAY_ROTATION);
  Serial.printf("[TOUCH] XPT2046 initialized on shared SPI; CS=%d; using polling because IRQ is optional\n",
                TOUCH_CS_PIN);

  dataMutex = xSemaphoreCreateMutex();
  if (!dataMutex) {
    diagnosticError(0, "SNAPSHOT_MUTEX",
                    "xSemaphoreCreateMutex returned null",
                    "confirmed allocation failure; snapshot synchronization is unavailable",
                    "check free heap before enabling backend snapshot updates");
  }
  WiFi.onEvent(onWiFiEvent);
  const bool stationStarted = WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  diagnosticLog(stationStarted ? "INFO" : "ERROR", 0, "WIFI_INIT",
                "station mode %s; mode=%d status=%d (%s)",
                stationStarted ? "started" : "failed",
                static_cast<int>(WiFi.getMode()), static_cast<int>(WiFi.status()),
                wifiStatusName(WiFi.status()));
  connectToNetwork();
  lastScanStart = millis();
  startupDiagnosticStarted = millis();
}

void loop() {
  const unsigned long now = millis();
  if (startupDiagnosticVisible && now - startupDiagnosticStarted >= STARTUP_DIAGNOSTIC_MS) {
    startupDiagnosticVisible = false;
    renderCurrentScreen();
  }
  pollTouch();
  pollScan();

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnectPending = false;
  } else if (wifiConnectPending && now - lastWifiAttempt >= WIFI_CONNECT_TIMEOUT_MS) {
    wifiConnectPending = false;
    diagnosticError(0, "WIFI_CONNECT",
                    String("connection wait expired; status=" +
                           String(static_cast<int>(WiFi.status())) +
                           " (" + wifiStatusName(WiFi.status()) + ")").c_str(),
                    "Wi-Fi did not connect within the initial wait",
                    "verify the local SSID/password configuration and router availability");
  }

  const bool retryReady = scanRetryPending &&
      static_cast<int32_t>(now - scanRetryAfter) >= 0;
  const bool intervalElapsed = now - lastScanStart >= SCAN_INTERVAL_MS;
  if ((retryReady || intervalElapsed) &&
      WiFi.getMode() == WIFI_STA && WiFi.status() == WL_CONNECTED &&
      !wifiConnectPending && !scanInProgress && !apiTaskHandle &&
      !pendingScanUpload) {
    scanRetryPending = false;
    lastScanStart = now;
    activeScanCycleId = ++nextScanCycleId;
    activeScanCycleStartedAt = now;
    diagnosticLog("INFO", activeScanCycleId, "SCAN_CYCLE",
                  "start; interval=%lu ms; Wi-Fi ready",
                  static_cast<unsigned long>(SCAN_INTERVAL_MS));
    beginScan(activeScanCycleId);
  }

  if (pendingScanUpload && WiFi.status() == WL_CONNECTED &&
      static_cast<int32_t>(now - pendingScanRetryAfter) >= 0 &&
      !apiTaskHandle) {
    diagnosticLog("INFO", pendingScanCycleId, "HTTP_POST_SCANS",
                  "retrying retained scan; network-count=%u",
                  static_cast<unsigned>(pendingScanNetworkCount));
    startBackendRequest(pendingScanNetworkCount, pendingScanCycleId,
                        &pendingScanPayload);
  }

  if (snapshotChanged && !startupDiagnosticVisible) {
    snapshotChanged = false;
    renderCurrentScreen();
  }
  delay(10);
}