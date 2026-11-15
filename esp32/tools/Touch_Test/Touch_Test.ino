// XPT2046 touch test. Display uses the verified parallel setup (tft_setup.h, unchanged).
// Touch runs on its own SPI bus (HSPI): CLK 14, DOUT(MISO) 35, DIN(MOSI) 13, CS 5.
// T_IRQ (GPIO34) is only read with digitalRead here.
//
// The XPT2046_Touchscreen library hard-codes its pressure threshold (Z_THRESHOLD 400),
// so touch is read directly here with the same command sequence and SPI settings,
// but with an adjustable threshold and a consistency check instead.

#include <TFT_eSPI.h>
#include <SPI.h>

const int T_CLK  = 14;
const int T_DOUT = 35;
const int T_DIN  = 13;
const int T_CS   = 5;
const int T_IRQ  = 34;

// Sensitivity: lower = lighter touches register. Library default was 400.
// Measured on this panel: light presses ~770, firm presses ~2300, idle 0.
const int TOUCH_Z_MIN = 100;
// Light presses give noisier positions; a read is accepted only if its
// 3 samples per axis agree within this many raw counts.
const int TOUCH_MAX_SPREAD = 60;

TFT_eSPI tft = TFT_eSPI();
SPIClass touchSpi(HSPI);
const SPISettings TOUCH_SPI(2000000, MSBFIRST, SPI_MODE0);

static int16_t besttwoavg(int16_t a, int16_t b, int16_t c) {
  int16_t da = abs(a - b), db = abs(a - c), dc = abs(c - b);
  if (da <= db && da <= dc) return (a + b) >> 1;
  if (db <= da && db <= dc) return (a + c) >> 1;
  return (b + c) >> 1;
}

static int16_t spread(int16_t a, int16_t b, int16_t c) {
  return max(a, max(b, c)) - min(a, min(b, c));
}

// Returns true for a valid touch; x/y are raw (same orientation as the library with rotation 1).
bool readTouch(int &x, int &y, int &z) {
  int16_t d[6];
  touchSpi.beginTransaction(TOUCH_SPI);
  digitalWrite(T_CS, LOW);
  touchSpi.transfer(0xB1);                         // Z1
  int16_t z1 = touchSpi.transfer16(0xC1) >> 3;     // Z2
  int16_t z2 = touchSpi.transfer16(0x91) >> 3;
  z = z1 + 4095 - z2;
  touchSpi.transfer16(0x91);                       // dummy, first reading is noisy
  d[0] = touchSpi.transfer16(0xD1) >> 3;
  d[1] = touchSpi.transfer16(0x91) >> 3;
  d[2] = touchSpi.transfer16(0xD1) >> 3;
  d[3] = touchSpi.transfer16(0x91) >> 3;
  d[4] = touchSpi.transfer16(0xD0) >> 3;           // last reading + power down
  d[5] = touchSpi.transfer16(0) >> 3;
  digitalWrite(T_CS, HIGH);
  touchSpi.endTransaction();

  if (z < 0) z = 0;
  if (z < TOUCH_Z_MIN) return false;
  if (spread(d[0], d[2], d[4]) > TOUCH_MAX_SPREAD || spread(d[1], d[3], d[5]) > TOUCH_MAX_SPREAD) return false;
  x = besttwoavg(d[0], d[2], d[4]);
  y = besttwoavg(d[1], d[3], d[5]);
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  pinMode(T_IRQ, INPUT);   // GPIO34 has no internal pull-up

  tft.init();
  tft.setRotation(1);
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.drawString("Touch test: tap anywhere", 10, 10, 2);

  pinMode(T_CS, OUTPUT);
  digitalWrite(T_CS, HIGH);
  touchSpi.begin(T_CLK, T_DOUT, T_DIN, T_CS);

  Serial.printf("TOUCH TEST START (Z min %d)\n", TOUCH_Z_MIN);
}

void loop() {
  int x, y, z;
  bool pressed = readTouch(x, y, z);
  int irq = digitalRead(T_IRQ);

  static uint32_t lastIdle = 0;
  if (pressed || millis() - lastIdle > 1000) {
    if (pressed) Serial.printf("TOUCH raw x=%4d y=%4d z=%4d  IRQ=%d\n", x, y, z, irq);
    else         Serial.printf("idle  z=%4d  IRQ=%d\n", z, irq);
    if (!pressed) lastIdle = millis();
  }

  if (pressed) {
    // Rough mapping from the manufacturer's example; Y axis is inverted on this panel
    int sx = map(x, 300, 3800, 0, tft.width());
    int sy = map(y, 3800, 200, 0, tft.height());
    tft.fillCircle(constrain(sx, 0, tft.width() - 1), constrain(sy, 0, tft.height() - 1), 3, TFT_YELLOW);
    char buf[48];
    snprintf(buf, sizeof(buf), "x=%4d y=%4d z=%4d   ", x, y, z);
    tft.drawString(buf, 10, 30, 2);
  }
  delay(15);
}
