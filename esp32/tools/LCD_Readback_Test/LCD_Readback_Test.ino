// ILI9341 8080 8-bit READBACK test (no TFT_eSPI).
// Only wiring change vs. LCD_BitBang_Test: LCD_RD moved from 3V3 to GPIO32.
// Reads registers twice: once with ESP32 pull-ups, once with pull-downs.
//   same value both times -> the controller is actively driving the bus
//   0xFF vs 0x00          -> nobody is driving (controller not answering)

const int DATA_PINS[8] = {16, 17, 18, 19, 21, 22, 23, 25};  // DB8..DB15 = bit0..bit7
const int PIN_WR  = 4;
const int PIN_DC  = 27;   // LCD_RS
const int PIN_RST = 26;
const int PIN_RD  = 32;

void busMode(int mode) {
  for (int b = 0; b < 8; b++) pinMode(DATA_PINS[b], mode);
}

void writeBus(uint8_t value, bool isData) {
  digitalWrite(PIN_DC, isData ? HIGH : LOW);
  for (int b = 0; b < 8; b++) digitalWrite(DATA_PINS[b], (value >> b) & 1);
  delayMicroseconds(1);
  digitalWrite(PIN_WR, LOW);
  delayMicroseconds(1);
  digitalWrite(PIN_WR, HIGH);
  delayMicroseconds(1);
}

void cmd(uint8_t c)  { writeBus(c, false); }
void data(uint8_t d) { writeBus(d, true); }

// Sends command c, then reads n bytes (first is the dummy byte) with the given pull mode.
void readReg(uint8_t c, int n, int pull, uint8_t* out) {
  busMode(OUTPUT);
  cmd(c);
  digitalWrite(PIN_DC, HIGH);
  busMode(pull);                 // release the bus BEFORE RD goes low (no contention)
  delayMicroseconds(5);
  for (int i = 0; i < n; i++) {
    digitalWrite(PIN_RD, LOW);
    delayMicroseconds(2);
    uint8_t v = 0;
    for (int b = 0; b < 8; b++) v |= (digitalRead(DATA_PINS[b]) & 1) << b;
    digitalWrite(PIN_RD, HIGH);
    delayMicroseconds(2);
    out[i] = v;
  }
  busMode(OUTPUT);
}

void report(const char* name, uint8_t c, int n) {
  uint8_t up[8], dn[8];
  readReg(c, n, INPUT_PULLUP, up);
  readReg(c, n, INPUT_PULLDOWN, dn);
  Serial.printf("  %-28s cmd 0x%02X  pullup:", name, c);
  for (int i = 0; i < n; i++) Serial.printf(" %02X", up[i]);
  Serial.print("  pulldown:");
  for (int i = 0; i < n; i++) Serial.printf(" %02X", dn[i]);
  bool driven = true;
  for (int i = 1; i < n; i++) if (up[i] != dn[i]) driven = false;   // ignore dummy byte
  Serial.println(driven ? "  -> DRIVEN" : "  -> NOT DRIVEN (floating)");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  pinMode(PIN_RD, OUTPUT);  digitalWrite(PIN_RD, HIGH);
  busMode(OUTPUT);
  pinMode(PIN_WR, OUTPUT);  digitalWrite(PIN_WR, HIGH);
  pinMode(PIN_DC, OUTPUT);  digitalWrite(PIN_DC, HIGH);
  pinMode(PIN_RST, OUTPUT); digitalWrite(PIN_RST, HIGH);
}

void loop() {
  Serial.println("\n=== hardware reset ===");
  digitalWrite(PIN_RST, LOW);  delay(20);
  digitalWrite(PIN_RST, HIGH); delay(150);

  report("ID4 (expect xx 00 93 41)", 0xD3, 4);
  report("Power mode (reset: xx 08)", 0x0A, 2);

  Serial.println("--- send Sleep Out (0x11) + Display ON (0x29) ---");
  cmd(0x11); delay(150);
  cmd(0x29); delay(50);
  report("Power mode (expect xx 9C)", 0x0A, 2);

  delay(4000);
}
