# WiFiShield – Demo Day Guide

Project folder (called **PROJECT** below):
`C:\Users\Adityadnik\Downloads\wifibackend\wifibackend\Network_detective_tool`

The ESP32 already has the final firmware. It knows both networks ("Aditya Yadnik" and "AK"),
joins whichever is in range, and finds the laptop running the backend by itself —
**no code or IP changes are needed on demo day.**

---

## 1. Connect the laptop to AK
Connect this laptop to the **AK** Wi-Fi. The ESP32 needs AK to offer **2.4 GHz**
(phone hotspots: turn off "5 GHz only" / enable "2.4 GHz" or "maximise compatibility").

## 2–3. Quick start (recommended)
Double-click **`Start_WiFiShield.bat`** in the PROJECT folder. It opens two windows
("WiFiShield backend" and "WiFiShield dashboard") and then the dashboard in the browser.
Close those two windows to stop. The manual steps below do the same thing.

## 2. Start the backend (terminal 1)
Open **Command Prompt** or **PowerShell** and run:

```
cd "C:\Users\Adityadnik\Downloads\wifibackend\wifibackend\Network_detective_tool"
npm run server
```

You should see both lines:
```
WiFiShield discovery listening on udp://0.0.0.0:3001
WiFiShield API listening on http://0.0.0.0:3001
```
If Windows shows a firewall prompt for Node.js, click **Allow** (tick both Private and Public).
Leave this window open.

## 3. Start the dashboard (terminal 2)
Open a **second** terminal:

```
cd "C:\Users\Adityadnik\Downloads\wifibackend\wifibackend\Network_detective_tool"
npm run dev
```

Open **http://localhost:5173** in the browser. Leave this window open too.

## 4. Power the ESP32
Plug the ESP32 into the laptop's USB (or press its **EN** button if already plugged in).
A phone charger or power bank on the ESP32's USB port also works. The battery circuit is
optional; with no cell the corner of the screen shows "USB".

What you should see, in order:
1. Display: white → brief coloured noise → white → "WiFiShield display test" → Networks screen.
   (This start-up sequence is normal.)
2. Within ~10 s: status bar shows **WiFi OK**.
3. Within ~25 s: status bar shows **API LIVE**; networks appear on the display.
4. Dashboard badge (top right) turns **ESP32 LIVE**; Detected Networks fills in.
   The ESP32 scans every 15 seconds.

## 5. Set the trusted network (do this once, ~1 minute)
Evil-twin and downgrade detection compare every scan against one known-good access point.
Without it, WiFiShield can only flag weak/open security and generic duplicate names.

1. Wait until the dashboard shows **ESP32 LIVE** and AK appears in Detected Networks.
2. Dashboard → **Security** → **Trusted Access Point**.
3. *Scanned network*: choose **AK** (the entry with the strongest signal if there are several).
4. *Expected security mode*: choose what AK really uses (usually **WPA2**).
5. Save. From the next scan, a second AP using the name "AK", or AK appearing with weaker
   security, is reported on the display and dashboard.

This setting is kept by the backend, so it only needs doing once per network.

## 6. Demo flow on the touchscreen
- **HOME** → four tiles: Networks, Alerts, Security, Settings.
- **Networks**: 3 networks per page; **PREV / NEXT** move between pages (grey = no more pages).
- **Alerts**: one backend finding per page; PREV / NEXT move between findings.
- **Security**: counts of encrypted / weak / open / portal networks, the **health score**
  (Good / Fair / Poor), the least crowded channel and active findings.
- **Settings**: device ID, Wi-Fi status, the ESP32's IP, and the backend address it discovered.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| Display says **WiFi OFF** | AK must be 2.4 GHz and in range. If the ESP32 started near the other network, it re-checks which network is in range every 30 s — or press **EN** to restart it. |
| **API OFFLINE** but WiFi OK | Check terminal 1 is still running. Laptop and ESP32 must be on the same network. The ESP32 searches for the backend every 10 s, so wait ~15 s. |
| Dashboard says **ESP32 STALE** | No scan arrived in the last 30 s — see the two rows above. |
| `npm` is not recognised | Close and reopen the terminal (Node.js was installed after it was opened). |
| Display white or garbled | Press **EN**. If it stays white, a jumper has lost contact: upload `Documents\Arduino\LCD_Readback_Test` and check its serial output (expects `00 93 41`). |

**Logs:** Arduino IDE → Tools → Serial Monitor at **115200** baud shows every step
(`WIFI_SELECT`, `DISCOVERY`, `POST_SCANS HTTP=201`, …). Close it before uploading.

**Alerts show only the latest scan:** the display, the dashboard's "Backend Detection Alerts"
and the Security screen list only findings detected in the most recent scan. Old findings
disappear with the next scan (including right after an ESP32 reset). "0 active" simply means
nothing suspicious is in range at that moment. If the dashboard briefly shows
"DEMO DATA" right after opening, wait 3 seconds — it switches to live data on its first refresh.
