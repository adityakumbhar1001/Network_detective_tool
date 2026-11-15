# ESP32 Setup

The ESP32 scans nearby access points and sends each result to the WiFiShield API. The browser reads updated results from the API every three seconds.

## Start The App

From the project directory, run the API in one PowerShell terminal:

```powershell
npm install
npm run server
```

Run the frontend in a second terminal:

```powershell
npm run dev
```

Open the Vite URL shown by `npm run dev`. Until the first ESP32 scan arrives, the screens show demo data and indicate whether the API is reachable.

## Configure The ESP32

1. Copy `esp32/wifi_shield_esp32/wifi_shield_config.example.h` to `esp32/wifi_shield_esp32/wifi_shield_config.h`.
2. Set `WIFISHIELD_WIFI_SSID` and `WIFISHIELD_WIFI_PASSWORD` in the local header, and optionally a second network in `WIFISHIELD_WIFI_SSID_2` / `WIFISHIELD_WIFI_PASSWORD_2`. At start-up the ESP32 joins whichever configured network is in range (2.4 GHz only). The ESP32 and the backend PC must be on the same network.
3. The backend's IP does not need to be configured: the firmware broadcasts a discovery request on UDP port 3001 and the backend answers, so the API address follows the PC to any network. `WIFISHIELD_API_URL` is only the starting guess. Do not use `localhost`; from the ESP32 that points back to the ESP32 itself.
4. Open `esp32/wifi_shield_esp32/wifi_shield_esp32.ino` in Arduino IDE. Install ArduinoJson and TFT_eSPI (see `esp32/HARDWARE_AND_LIBRARIES.md` for the display setup and the one-line TFT_eSPI patch needed with ESP32 core 3.x), select **ESP32 Dev Module**, start the API, allow Node.js through the PC firewall (TCP and UDP 3001) if prompted, and upload the sketch.

The local config header is excluded from Git. If it is missing, the sketch compiles with placeholder values and will not connect until configured.

The sketch scans every 15 seconds and posts up to 80 nearby 2.4 GHz networks with their SSID, BSSID, RSSI, channel, and advertised encryption mode. Serial Monitor reports the API response code; a `201` means the scan was accepted.

## Optional Device Token

The API listens on the LAN so the ESP32 can reach it. Keep it on a trusted local network and do not expose this development server to the public internet. To require a token, start the backend in PowerShell with:

```powershell
$env:DEVICE_TOKEN = "use-a-long-random-token"
npm run server
```

Set the same value as `WIFISHIELD_DEVICE_TOKEN` in the local firmware config; the device sends it as `X-Device-Token`.

To compare scans against a known access point, use the Security page to select a scanned AP and save its SSID, BSSID, and expected security mode. Alternatively, set all three environment variables before starting the backend:

```powershell
$env:TRUSTED_SSID = "HomeWiFi"
$env:TRUSTED_BSSID = "AA:BB:CC:11:22:33"
$env:TRUSTED_SECURITY = "WPA2"
npm run server
```

The backend stores trusted AP configuration, alert records, and recent RSSI observations in `.wifi-shield-state.json`. Set `WIFISHIELD_STATE_FILE` to use a different location. The RSSI anomaly threshold defaults to 20 dB and can be changed with `RSSI_ANOMALY_THRESHOLD_DB`. Latest scan data and survey history are in memory and reset when the backend restarts.

## API Contract

The ESP32 sketch sends `POST /api/scans` with JSON in this shape:

```json
{
  "deviceId": "esp32-wifi-shield-01",
  "networks": [
    {
      "ssid": "LabWiFi",
      "bssid": "AA:BB:CC:11:22:33",
      "rssi": -48,
      "channel": 6,
      "security": "WPA2"
    }
  ]
}
```

`GET /api/snapshot` returns the latest networks, existing snapshot alerts, `securityAlerts`, trusted access point, channel counts, signal readings, and history. `GET /api/health` reports API/device status. `GET /api/alerts` returns detector findings. `GET /api/trusted-network` returns the configured baseline. `PUT /api/trusted-network` configures it, and `PUT /api/alerts/{id}` accepts `Acknowledged` or `Resolved` status.

Duplicate SSIDs without a trusted baseline are warnings; they are not classified as confirmed attacks. Security downgrades compare known security modes conservatively. RSSI anomalies require repeated deviations around the configured threshold. These passive indicators can have legitimate explanations and do not independently confirm an attack. WiFiShield never transmits deauthentication frames, disconnects clients, or jams networks.