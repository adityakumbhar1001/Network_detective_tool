# WiFiShield

Wi-Fi scan dashboard backed by an ESP32 and a local API. See [ESP32_SETUP.md](ESP32_SETUP.md) for startup and device connection steps.

- [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md) – architecture, detection rules, limits, Q&A
- [CHANGES_AND_IMPROVEMENTS.md](CHANGES_AND_IMPROVEMENTS.md) – what changed and how accuracy improved
- [DEMO_GUIDE.md](DEMO_GUIDE.md) – step-by-step demo and troubleshooting
- [esp32/HARDWARE_AND_LIBRARIES.md](esp32/HARDWARE_AND_LIBRARIES.md) – wiring, libraries, diagnostic sketches

## Run Locally

Prerequisite: Node.js 20.19+ or 22.12+.

```powershell
npm install
npm run server
```

In a second PowerShell terminal, run `npm run dev` and open the local URL printed by Vite. The API listens on port 3001 by default. Before the first ESP32 scan arrives, the frontend shows demo data.

Run validation with:

```powershell
npm test
npm run lint
npm run build
```

## ESP32 Configuration

Copy `esp32/wifi_shield_esp32/wifi_shield_config.example.h` to `esp32/wifi_shield_esp32/wifi_shield_config.h`, then set the Wi-Fi SSID/password (optionally a second network). The ESP32 finds the backend by UDP discovery on port 3001, so the API URL is only a starting guess. The local config file is ignored by Git. Do not use `localhost` in the ESP32 API URL.

The firmware scans every 15 seconds and sends the existing `deviceId`, optional `scannedAt`, and `networks` fields (`ssid`, `bssid`, `rssi`, `channel`, `security`). The payload format is unchanged.

To require a device token, set the same token in the firmware config and backend environment:

```powershell
$env:DEVICE_TOKEN = "use-a-long-random-token"
npm run server
```

## Trusted Access Point

In **Security**, select a scanned network, confirm its SSID and BSSID, choose its expected security mode, and save it as trusted. When available, the backend captures its observed RSSI and channel as baseline evidence. Trusted configuration, alert records, and recent RSSI observations are stored in `.wifi-shield-state.json` by default; set `WIFISHIELD_STATE_FILE` to use another path.

For startup configuration without the frontend:

```powershell
$env:TRUSTED_SSID = "HomeWiFi"
$env:TRUSTED_BSSID = "AA:BB:CC:11:22:33"
$env:TRUSTED_SECURITY = "WPA2"
npm run server
```

RSSI anomaly threshold defaults to 20 dB and is configurable with `RSSI_ANOMALY_THRESHOLD_DB`.

## API

- `POST /api/scans` accepts the current ESP32 payload and returns HTTP 201 with the existing accepted/device/time/network/alert-count response.
- `GET /api/snapshot` returns current scan data, existing history/channel/heatmap data, `securityAlerts`, and the trusted baseline.
- `GET /api/health` reports whether the latest scan is live, stale, or waiting.
- `GET /api/history` returns in-memory survey history.
- `GET /api/alerts` returns event IDs, timestamps, types, SSID/BSSIDs, severity, risk score, explanation, evidence, and status.
- `GET /api/trusted-network` returns the current trusted baseline.
- `PUT /api/trusted-network` configures a baseline. Example: `{"ssid":"HomeWiFi","bssid":"AA:BB:CC:11:22:33","expectedSecurity":"WPA2"}`.
- `PUT /api/alerts/{id}` accepts `{"status":"Acknowledged"}` or `{"status":"Resolved"}`.

Supported security values: `Open`, `WEP`, `WPA`, `WPA2`, `WPA/WPA2`, `WPA3`, `WPA2/WPA3`, and `Unknown`. Unknown values do not receive an assumed strength; mixed modes are compared conservatively.

## Alert Meanings And Limitations

- **Duplicate SSID warning:** multiple BSSIDs advertise one SSID. Without a trusted baseline this is a warning, not an attack classification.
- **Suspicious duplicate AP:** an untrusted BSSID advertises the trusted SSID. Mesh nodes, repeaters, and dual-band routers are legitimate possible explanations.
- **Security downgrade:** a trusted SSID is observed with a known weaker mode. An open network replacing a WPA2/WPA3 baseline is high priority.
- **RSSI anomaly:** signal strength differs from a recent baseline by the configured threshold across repeated observations. RSSI alone does not prove an attack.

Severity bands are Low (0-39), Medium (40-64), High (65-84), and Critical (85-100). Repeated unchanged observations update one event. Resolved events are not reopened until the condition clears and reappears.

WiFiShield is a passive, rule-based indicator system. Radio conditions, BSSID changes, and legitimate network topologies can affect findings; alerts do not independently confirm an attack. It does not transmit deauthentication frames, disconnect clients, or jam networks. Latest scan and survey history are in memory and reset when the backend restarts; trusted configuration, alerts, and RSSI observations are persisted.

