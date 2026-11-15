# WiFiShield Hardware, Libraries and Diagnostics

## Components
- ESP32 dev board ("ESP-32S", ESP32-D0WD-V3, 4 MB flash, no PSRAM)
- SmartElex 3.2" TFT, 240x320, ILI9341 display controller + XPT2046 resistive touch
  (manufacturer manual: https://robu-prod-media.s3.ap-south-1.amazonaws.com/uploads/2025/02/3.2_inch_ResistiveTouch_manual.pdf)

## Display wiring: 8-bit parallel (8080) interface
Interface mode per the manual's table: IM2=0, IM1=0, IM0=1 -> "MCU 8-bit parallel, DB15-DB8".

| TFT pin | ESP32 | Notes |
|---|---|---|
| VCC, BK_LIGHT, LEDA | 3V3 | |
| GND | GND | |
| IM0 / IM1 / IM2 | 3V3 / GND / GND | 8-bit parallel mode |
| DB8 ... DB15 | GPIO 16, 17, 18, 19, 21, 22, 23, 25 | DB8 = bit 0 (`TFT_D0`) |
| LCD_WR | GPIO 4 | write strobe |
| LCD_RS | GPIO 27 | data/command (`TFT_DC`) |
| LCD_RST | GPIO 26 | |
| LCD_RD | GPIO 32 | read strobe; enables readback diagnostics |
| LCD_CS | GND | always selected |
| DB0 ... DB7 | not connected | |

## Touch wiring: XPT2046 on its own SPI bus (HSPI)
| TFT pin | ESP32 |
|---|---|
| T_CLK | GPIO 14 |
| T_DIN | GPIO 13 |
| T_DOUT | GPIO 35 |
| T_CS | GPIO 5 |
| T_IRQ | GPIO 34 (optional; firmware polls) |

Calibration used by the firmware: raw X 300..3800, raw Y 200..3800 with Y inverted,
rotation 1 (landscape), pressure threshold 100 (idle noise measured up to ~68).

Alert LED (optional): GPIO 33.

## Arduino setup
- Board: **ESP32 Dev Module**, ESP32 Arduino core 3.3.x
- Libraries: **TFT_eSPI 2.5.43**, **ArduinoJson 7.x**
  (XPT2046_Touchscreen is no longer needed: the firmware reads the XPT2046 directly.)
- The display configuration is the sketch-local `tft_setup.h` (TFT_eSPI picks it up automatically).

### Required TFT_eSPI patch for ESP32 core 3.x
TFT_eSPI 2.5.43 calls `gpio_input_get()`, which no longer exists in core 3.x, so parallel
mode does not compile. In
`Documents\Arduino\libraries\TFT_eSPI\Processors\TFT_eSPI_ESP32.c` (function `readByte`),
replace the three lines

```c
  reg = gpio_input_get();
```

with

```c
  reg = REG_READ(GPIO_IN_REG);
```

## Signal-integrity setting (important)
The parallel bus runs over jumper wires. At the ESP32's default GPIO drive strength the fast
edges ring and couple between wires, which corrupted about 5% of drawn blocks (dropped
letters, washed-out start-ups). The firmware sets the weakest drive strength
(`GPIO_DRIVE_CAP_0`) on D0-D7, WR, DC, RD and RST **before** `tft.init()`; the stress test
then measured 0 errors in 57,600 blocks, with and without Wi-Fi activity.

## Diagnostic sketches (`esp32/tools/`)
| Sketch | Use it when | What it shows |
|---|---|---|
| `LCD_Line_Check` | wiring was changed | shorts / stuck lines on the 11 LCD signals (read-only) |
| `LCD_BitBang_Test` | screen stays white | slow, library-free init and colour fills |
| `LCD_Readback_Test` | screen white or garbled | reads the ILI9341 ID (expect `00 93 41`) and power mode (`08` -> `9C`); a bit that differs between pull-up and pull-down reads is an open wire |
| `Touch_Test` | touch misbehaves | raw X/Y/pressure on serial, dots on screen |
| `ILI9341_Parallel_Test` | quick display check | full-screen red/green/blue with TFT_eSPI |

All print to Serial Monitor at 115200 baud.
