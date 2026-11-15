# WiFiShield – Before vs Now: Changes, Fixes and Accuracy Improvements

## 1. Summary table

| Area | Before | Now |
|---|---|---|
| Display | Solid **white screen**; never showed anything | Works at full speed; 0 corrupted writes in stress testing |
| Display start-up | Sometimes washed-out with only a thin correct strip | Clean on every boot |
| Text on screen | Letters dropped ("iFi OFF", "netwo k") | Correct |
| Touch | Untested; library threshold too stiff | Calibrated (Y axis fixed), lighter touch (pressure 100 vs 400) |
| Idle flicker | Full-screen redraw twice every 15 s | Only changed content is redrawn |
| Security screen | Text overflowed screen and was hidden by footer | Fits |
| PREV/NEXT | Flickered even with nothing to page | Only redraw when the page changes |
| Backend link | Stopped after ~5 cycles (memory leak) | Runs indefinitely; memory flat |
| Network/IP | One network, PC IP hard-coded | Two networks, backend found automatically |
| Credentials | Wi-Fi passwords written in the firmware source | Only in a git-ignored local config |
| Alerts | 42 old findings shown forever, even after reset | Only findings from the latest scan |
| Security classification | 8 of 17 ESP32 security modes recognised | 15 of 17 (WAPI and DPP stay "Unknown") |
| WPA/WPA2 verdict | Every WPA/WPA2 network called "outdated" (score 75) | Decided by the reported cipher: AES-only = encrypted; TKIP allowed = weak, with the exact reason |
| Duplicate-SSID warnings | A router's own extra radios flagged as duplicates | Recognised as one router |
| Network list | Only the last scan; weak APs flickered in and out; unsorted | Networks heard in the last 60 s, strongest first, marked when missed by the latest scan |
| Device Networks screen | Name and signal only; page jumped back to 1 every 15 s | Verdict badge, signal, channel, security; current page kept |
| Dashboard wording | "Suspicious APs" counted security warnings; "Anomaly Score" was only the first warning's score; status box showed one warning; sidebar always said "Demo Mode" | "Security Warnings", "Highest Risk" (max over all findings), all warnings listed, sidebar shows the real connection state; hidden networks named |
| Backend tests / lint | 14 tests; 2 lint errors | 21 tests passing; lint clean |

## 2. How the display problem was solved (evidence-based)
The original firmware drove the display over SPI and shared GPIO 5 between the display and
the touch controller. After moving to the 8-bit parallel interface the screen stayed white.
Each step changed one thing and measured the result:

1. **Manufacturer manual** confirmed the interface pins: IM2/IM1/IM0 = 0/0/1 selects
   8-bit parallel on DB15–DB8, matching the wiring.
2. **Line check** (all 11 signal lines, ESP32 internal pull-ups/downs): no shorts, nothing stuck.
3. **Slow, library-free initialisation**: still white → the problem was not the TFT_eSPI
   library or its speed.
4. **Readback test** (LCD_RD moved to GPIO 32 so the controller can answer): the controller
   answered, but **bit 4 floated**. That bit is DB12 (GPIO 21): an open jumper wire.
   With bit 4 missing, the "Sleep Out" command `0x11` arrived as `0x01` = **software reset**,
   so the panel never woke up. Replacing that one jumper → ID `00 93 41`, power mode `9C`,
   full-colour output.
5. **Glitches under real use** (dropped letters, washed-out boots): a stress test drew 4,800
   blocks and read every one back. Errors depended on the GPIO **drive strength**:

   | ESP32 drive strength | Corrupted blocks at full speed |
   |---|---|
   | 3 (strongest) | ~740 / 4800 |
   | 2 (default) | 236–387 / 4800 |
   | 1 | 23–43 / 4800 |
   | **0 (weakest)** | **0 / 4800** (0 of 57,600 across all runs, Wi-Fi on and off) |

   Fast edges were ringing on the jumper wires. The firmware now sets the weakest drive
   strength **before** the display initialises, so the panel's power/voltage settings are
   also sent cleanly (that was the cause of the washed-out boots).

## 3. Firmware changes
- **Parallel display configuration** (`tft_setup.h`) with readback enabled (`TFT_RD 32`).
- **Bus drive strength** set to the minimum before and after `tft.init()`.
- **Touch rewritten** to read the XPT2046 directly: same command sequence as the library,
  adjustable pressure threshold (100), a consistency check that rejects readings whose three
  samples disagree, measured calibration with Y inverted. Edge touches are clamped instead of
  rejected.
- **Pin conflict fixed**: the alert LED was on GPIO 32 (now the display's RD line) and was
  never configured as an output → moved to GPIO 33 and initialised.
- **Memory leak fixed**: the backend task ended with `vTaskDelete()`, which never returns,
  so the ~25 KB response and two HTTP clients were never freed (**~30 KB lost per cycle**,
  upload stopped after ~5 cycles). The work now runs in its own function so everything is
  freed. Measured: free memory steady at ~192 KB over 20+ cycles.
- **Memory guard**: if memory is ever too low or the backend task cannot start three times,
  the device logs it and restarts cleanly.
- **Two Wi-Fi networks** with automatic choice of whichever is in range; re-check after
  30 s offline.
- **UDP backend discovery**: no PC IP address needed in the code; tested by starting from a
  deliberately wrong IP – the device found the backend and its first upload succeeded.
- **Flicker removal**: a fingerprint of what each screen shows; unchanged screens are not
  redrawn, value-only changes are drawn in place without clearing the screen.
- **UI fixes**: Security screen text shortened/repositioned to fit 320 px and stay above the
  footer; PREV/NEXT no longer redraw when there is no other page.
- **Credentials removed from source**: the firmware falls back to empty placeholders; real
  values live only in the git-ignored `wifi_shield_config.h`.

## 4. Backend changes
- **Latest-scan alerts**: only findings detected in the most recent scan are reported to the
  device, the dashboard and `/api/alerts`; old findings vanish after the next scan (e.g. an
  ESP32 reset). Full history remains in the state file.
- **Same-router detection** (`sameRouterBssids`): BSSIDs with the same vendor prefix
  (ignoring the locally-administered bit) differing in at most one of the last three bytes
  are treated as one router.
- **OWE / Enhanced Open** classified as encrypted, ranked between Open and WPA2.
- **UDP discovery responder** on port 3001 (Node built-in `dgram`, no new dependencies).
- **Cipher-aware classification**: the firmware now sends each network's pairwise and group
  cipher; WPA/WPA2 with AES only is "encrypted", anything allowing TKIP is "weak", and each
  warning states its specific reason and risk score instead of a generic "outdated".
- **Tests**: 6 new tests (latest-only alerts, same-router recognition, no false duplicate
  warning, lower-risk same-router duplicate on the trusted SSID, OWE ranking, cipher-based
  classification). 20/20 pass.

## 5. How accuracy increased

| Accuracy aspect | Before | Now | How we know |
|---|---|---|---|
| What the display shows matches the data | ~5% of writes corrupted; whole screens wrong on some boots | 0 errors | 57,600-block readback stress test; register readback |
| Security modes classified correctly | 8 / 17 | 15 / 17 | ESP-IDF auth-mode list vs. firmware mapping |
| Mixed-mode (WPA/WPA2) verdict | label only; AES-only networks wrongly "weak" | uses pairwise + group cipher from the beacon | home router: `TKIP/CCMP` + group `TKIP` → weak (correct); AES-only BSSID → encrypted; unit test covers 4 cases |
| False duplicate / evil-twin warnings from one router | every multi-BSSID router flagged | suppressed (trusted SSID still reported, at Low) | unit tests + the real router (`24:0B:88…` / `26:0B:88…`) |
| Alerts reflect current conditions | 42 stale findings | only the latest scan's | live check after reset: 0 stale alerts |
| Data actually reaching the backend | stopped after ~5 cycles | continuous | memory log over 20+ cycles; dashboard "ESP32 LIVE" |
| Touch registers light presses | needed firm press (400) | 100, with noise rejection | idle noise measured ≤ 68; 0 false touches in 30 s |
| Weak, distant networks stay visible | disappeared whenever one scan missed them | kept for 60 s, marked "not in last scan" | live: a −94 dBm neighbour stays listed between scans; unit test |
| Scan range | – | already at the hardware limit | 4 scan settings measured: identical results; TX power already 19.5 dBm max |

What was **not** changed on purpose: the detection thresholds (20 dB, two consecutive
outliers) – they are conservative to avoid false alarms from normal ±5 dB RSSI noise.

## 6. Remaining limits (hardware/method)
2.4 GHz only; passive scanning cannot detect a perfect BSSID+security clone or
deauthentication attacks; RSSI is noisy and changes when the device moves; range is set by
the dev board's PCB antenna (an ESP32-WROOM-32U with an external antenna would hear
further). Evil-twin and downgrade detection require the trusted access point to be set in
Dashboard → Security.
