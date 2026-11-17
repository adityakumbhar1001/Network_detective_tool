# WiFiShield – Project Summary

## 1. What it is
WiFiShield is a **passive Wi-Fi security monitor**. An ESP32 scans nearby 2.4 GHz access
points every 15 seconds, shows the results on its own touchscreen, and sends them to a
backend that classifies each network's security and looks for signs of attacks such as an
**evil twin** (a fake access point copying a trusted network's name), a **security
downgrade**, or **suspicious signal changes**. A web dashboard shows the same data with
more detail.

It is **passive only**: it reads the beacons and probe responses that access points
broadcast publicly. It never transmits deauthentication frames, never jams, never
connects to other networks and never captures anyone's traffic.

## 2. System architecture

```
 ┌──────────────── ESP32 device ────────────────┐        ┌──────── Laptop ────────┐
 │ Wi-Fi radio ──scan──► firmware ──► 3.2" TFT   │  HTTP  │ Node.js backend :3001  │
 │                         ▲   │      (ILI9341)   │ ─────► │  • validates scans      │
 │ XPT2046 touch ──────────┘   │                  │  JSON  │  • classifies security  │
 │                             └─ backend task ───┼──────► │  • detector rules       │
 │   UDP broadcast "WIFISHIELD_DISCOVER" ─────────┼──────► │  • stores trusted AP    │
 │   ◄──────────── "WIFISHIELD_API 3001" ─────────┼─────── │  • UDP discovery        │
 └───────────────────────────────────────────────┘        └──────────┬─────────────┘
                                                                      │ /api (proxy)
                                                           ┌──────────▼─────────────┐
                                                           │ React dashboard :5173  │
                                                           └────────────────────────┘
```

Three parts:
1. **ESP32 firmware** (`esp32/wifi_shield_esp32/`): Arduino C++. Scans, draws the touch UI,
   uploads scans, downloads the analysed snapshot.
2. **Backend** (`server/`): Node.js using only built-in modules. REST API, detection
   engine, persistence, LAN discovery, health score. 25 automated tests.
3. **Dashboard** (`src/`): React + Vite. Pages: Dashboard, Networks, Signal Heatmap,
   Security, Channels, Survey History.

## 3. Hardware

| Component | Role |
|---|---|
| ESP32 dev board (ESP32-D0WD-V3, dual core, 4 MB flash) | scanner, display driver, network client |
| SmartElex 3.2" TFT 240x320, **ILI9341** controller | display, driven over an **8-bit parallel** bus (8 data lines + WR/RS/RST/RD) |
| **XPT2046** resistive touch controller | touch input on its own SPI bus |

Why parallel and not SPI: the module's interface is selected by its IM pins; 8-bit parallel
(IM = 0 0 1, DB15-DB8 per the manufacturer's manual) moves a byte per write strobe and
redraws a full screen in tens of milliseconds. Full wiring:
`esp32/HARDWARE_AND_LIBRARIES.md`.

## 4. Data flow (one 15-second cycle)
1. **Scan** – the ESP32 runs an asynchronous Wi-Fi scan (~3 s, hidden networks included,
   up to 80 networks): SSID, BSSID (MAC), RSSI (dBm), channel, security mode.
2. **Local display** – results are shown immediately on the touchscreen.
3. **Upload** – a separate FreeRTOS task POSTs the scan as JSON to `POST /api/scans`
   (answer **201**). Keeping HTTP on its own task keeps the touch UI responsive.
4. **Analysis** – the backend validates every field, classifies security, runs the
   detector against the trusted access point and the signal history, and stores the result.
5. **Snapshot** – the ESP32 fetches `GET /api/snapshot?display=1` (answer **200**) and shows
   the backend's verdicts: per-network status, alert list, counts.
6. **Dashboard** – the browser polls the same API every 3 s, so both screens agree.

If the backend is unreachable, the device keeps scanning and showing local results
("API OFFLINE"), searches for the backend again, and resumes uploading on the next cycle.
If Wi-Fi drops before an upload, that scan is kept and sent once Wi-Fi returns.

## 5. Security classification

The ESP32 reports both the **security mode** and the **ciphers** (pairwise and group) from
each beacon; the cipher decides mixed modes.

| Advertised mode | Cipher | Status | Warning (risk score) |
|---|---|---|---|
| Open | – | **insecure** | Open network (90) |
| WEP | – | **weak** | WEP is broken (85) |
| WPA (v1) | any | **weak** | WPA1 deprecated (75) |
| WPA/WPA2 mixed, or WPA2 | TKIP allowed (pairwise or group) | **weak** | still allows TKIP (65) |
| WPA/WPA2 mixed | AES (CCMP) only | **encrypted** | – |
| WPA/WPA2 mixed | not reported (old firmware) | **weak** | TKIP cannot be ruled out (55) |
| WPA2, WPA2/WPA3, WPA3 (personal and enterprise) | AES | **encrypted** | – |
| OWE (Enhanced Open) | – | encrypted (does not authenticate the AP) | – |
| WAPI, DPP, anything unrecognised | – | unknown | Unknown security (45) |
| Open, but the name is a known campus network (VIT_Student, VIT_Staff, VIT_TPO, VIT_VIP, VIT) | – | **portal** | Open campus Wi-Fi with a browser sign-in: use HTTPS only (30, Low) |

Example from testing: the home router "Aditya Yadnik" advertises WPA/WPA2 with pairwise
`TKIP/CCMP` and group `TKIP` → correctly **weak**; fix on the router by selecting
**WPA2-PSK with AES** only (or WPA2/WPA3). Windows shows it as "WPA2/CCMP" because that is
what the laptop itself negotiated, not everything the router accepts.

**Grouping and tips:** notices that repeat for every access point of one network (the campus
portal notice) are combined into one alert per network with an access-point count, e.g.
"(7 access points)". WPA2/WPA3 transition mode is not an alert: it is shown as a blue
informational tip under Security Status, because most phone hotspots and home routers use it
and it does not count against the health score.

**Dashboard note:** the "Anomaly Score" card and the "Security Status" box show the first
per-network security warning and its fixed risk score; "Suspicious APs" counts those
security warnings. Detector findings (evil twin, downgrade, RSSI) are listed under
"Backend Detection Alerts".

## 6. Detection rules
Every finding has a **risk score 0-100** and a severity: **Critical ≥ 85, High ≥ 65,
Medium ≥ 40, Low < 40**. Each finding explains its evidence and states that it is an
indicator, not proof.

| Rule | Triggered when | Typical score |
|---|---|---|
| **Suspicious duplicate AP** (evil twin) | another BSSID advertises the *trusted* SSID | 45 base, +22 weaker security than expected, +5 different channel, +12 signal far from the trusted baseline, +12 signal anomaly. A BSSID from the trusted router's own address block scores 20 (likely its second radio). |
| **Security downgrade** | the trusted SSID appears with weaker security than expected (e.g. WPA2 → Open) | 65, +27 if it became Open, +8 if also a duplicate, +8 with a signal anomaly |
| **RSSI anomaly** | an AP's signal moves ≥ 20 dB from its rolling 12-scan baseline in **two consecutive scans** | 48, +12 duplicate, +18 downgrade |
| **Duplicate SSID warning** | an untrusted SSID is advertised by several different routers | 30 (Low – often legitimate mesh/repeaters). Not raised for campus network names, nor for an SSID whose access points all use known campus hardware prefixes. |
| **Campus vendor mismatch** | an access point on a campus SSID has a vendor prefix that is not a known campus prefix and not shared by at least two APs of the group | 60 (+15 if its security differs from the group's). By default needs ≥ 3 APs and a differing security setting; if `WIFISHIELD_CAMPUS_OUIS` is set, any other prefix is reported. |
| Per-network warnings | open / weak / unknown security | shown on cards and dashboard |

**Trusted access point:** set once in Dashboard → Security. It is the baseline for the
evil-twin and downgrade rules (SSID, BSSID, expected security, baseline RSSI and channel).

**Latest-scan reporting:** alerts shown are only those detected in the most recent scan;
history is kept on disk but stale findings are not displayed.

## 7. Firmware features worth mentioning
- Touch UI: Home (4 tiles), Networks (3 per page, PREV/NEXT), Alerts (one finding per
  page), Security (counts by status + active findings), Settings (device diagnostics).
- Flicker-free updates: redraws only what changed; unchanged screens are not redrawn.
- **Two configured Wi-Fi networks**; joins whichever is in range, re-checks after 30 s offline.
- **Automatic backend discovery** over UDP broadcast – no IP address in the code.
- Memory safety: fixed a per-cycle memory leak; a guard restarts the device cleanly if
  memory ever runs low instead of silently stopping.
- Structured serial logs (`[time][CYCLE n][LEVEL][STAGE]`) for every step.
- **Health score and channel advice** shown on the Security screen (see section 9a).
- Networks that share a name and security are merged into one card with an AP count.
- Optional battery reading on GPIO 33 (divider); with no cell it shows "USB". The battery
  circuit is optional and not needed for the demo; wiring diagrams are in `esp32/diagrams/`.

## 8. Backend API
| Endpoint | Purpose |
|---|---|
| `POST /api/scans` | receive a scan (validated: MAC format, RSSI −127..0, channel, ≤ 200 networks, no duplicate BSSIDs; optional device token) |
| `GET /api/snapshot` | latest networks, classifications, alerts, tips, health score, channel advice, history |
| `GET /api/health` | `live` (scan < 30 s old), `stale`, or `waiting` |
| `GET /api/alerts`, `PUT /api/alerts/:id` | list findings; mark Acknowledged / Resolved |
| `GET/PUT /api/trusted-network` | read / set the trusted access point |
| UDP 3001 | answers ESP32 discovery broadcasts |

## 9. What is shown where
- **Device Networks screen** (3 per page, strongest first): name, verdict badge
  (SECURE / WEAK / OPEN / TRUSTED / SUSPICIOUS), signal, channel, security mode;
  "(not in last scan)" for networks kept from the last minute.
- **Dashboard cards**: APs detected, trusted AP set or not, number of **security warnings**,
  and the **highest risk score** across all warnings and detector findings.
- **Dashboard Security Status**: every security warning with its specific reason and risk;
  detector findings (evil twin, downgrade, RSSI) under "Backend Detection Alerts".
- **Network list memory**: networks heard within the last 60 s stay listed (dimmed on the
  dashboard) so weak, distant APs do not flicker in and out between scans. Detection still
  uses only the latest scan.

## 9a. Network health score and best channel
- **Health score (0-100):** starts at 100 and loses points for open networks (6 each, max 36),
  weak encryption (3 each, max 18), campus portals (1 each, max 5) and active detector
  findings (Critical 20, High 12, Medium 5, Low 1; max 45). Labels: **Good ≥ 80, Fair ≥ 60,
  Poor < 60**. It describes the surroundings, not internet speed.
- **Least crowded channel:** the least loaded of the non-overlapping 2.4 GHz channels
  1, 6 and 11, counting stronger neighbouring signals more.
- Both are shown on the device (Security screen) and on the dashboard.

## 10. Scan range – measured
Four scan settings were compared on the device (active 100–300 ms and 150–600 ms per
channel, passive 360 ms and 600 ms): **all found exactly the same networks**, and transmit
power is already at the 19.5 dBm maximum. The limit is the receiver and the dev board's
small PCB antenna, not software; networks around −90 dBm sit at the edge (e.g. a neighbour
at −94 dBm appears in some scans only). Practical hardware improvements, in order of effect:
1. Keep the ESP32's antenna end (the zig-zag trace past the metal shield) clear of the TFT,
   jumper wires, hands and metal; point it upward.
2. Use an **ESP32-WROOM-32U** module/board with an external 2.4 GHz antenna (u.FL/IPEX),
   typically several dB better than the PCB antenna.
3. For 5 GHz visibility, a dual-band chip is required (the ESP32's radio is 2.4 GHz only).

## 11. Limitations (be upfront about these)
- **2.4 GHz only** – the ESP32 radio cannot see 5 GHz networks.
- **Passive detection** – an attacker who clones the exact BSSID *and* security of the real
  AP is indistinguishable in beacons; deauthentication attacks are not detected (that would
  need promiscuous packet capture – a possible extension).
- **RSSI is noisy** (±5 dB normal); the 20 dB / two-scan rule trades sensitivity for fewer
  false alarms. Moving the device itself changes RSSI.
- Weak, distant APs can be missed in a single scan and reappear in the next.
- Duplicate SSIDs are often legitimate (mesh, repeaters) – therefore warnings, not alarms.

## 12. Likely questions and answers
- **How do you detect an evil twin?** A second BSSID advertising the trusted SSID raises a
  suspicious-duplicate finding; weaker security, a different channel or an unusual signal
  level raise its score.
- **Can it be fooled?** Yes, by a perfect clone of BSSID and security; we state this limit.
  It also cannot see 5 GHz.
- **Why a backend instead of doing everything on the ESP32?** History, persistence, the
  dashboard and heavier rules live on the PC; the ESP32 stays responsive and still works
  offline with local results.
- **How does the ESP32 find the server?** UDP broadcast discovery; the backend replies
  with its port and the ESP32 uses the sender's address.
- **Is this legal/ethical?** It only listens to public broadcast information and never
  transmits attacks or joins other networks.
- **How did you make the display reliable?** See `CHANGES_AND_IMPROVEMENTS.md` – an open
  data wire found by reading the controller's registers back, and signal ringing fixed by
  lowering GPIO drive strength (measured 5% → 0% corrupted writes).

## 13. Running it
See `DEMO_GUIDE.md`: `npm install` once, then `npm run server` and `npm run dev`, power
the ESP32, open http://localhost:5173.
