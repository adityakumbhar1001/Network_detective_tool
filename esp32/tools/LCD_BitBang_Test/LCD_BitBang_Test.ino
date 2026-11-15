// Library-independent ILI9341 8080 8-bit write test.
// Same pins and same wiring as ILI9341_Parallel_Test; no TFT_eSPI.
// Every write is slowed to microseconds (vs ~tens of ns in TFT_eSPI) to
// remove bus timing / signal integrity as a variable.

const int DATA_PINS[8] = {16, 17, 18, 19, 21, 22, 23, 25};  // DB8..DB15 = bit0..bit7
const int PIN_WR  = 4;
const int PIN_DC  = 27;   // LCD_RS
const int PIN_RST = 26;

void writeBus(uint8_t value, bool isData) {
  digitalWrite(PIN_DC, isData ? HIGH : LOW);
  for (int b = 0; b < 8; b++) digitalWrite(DATA_PINS[b], (value >> b) & 1);
  delayMicroseconds(1);
  digitalWrite(PIN_WR, LOW);
  delayMicroseconds(1);
  digitalWrite(PIN_WR, HIGH);   // ILI9341 latches on the rising edge of WRX
  delayMicroseconds(1);
}

void cmd(uint8_t c)  { writeBus(c, false); }
void data(uint8_t d) { writeBus(d, true); }

void fill(uint16_t color) {
  cmd(0x2A); data(0); data(0); data(0); data(239);        // columns 0..239
  cmd(0x2B); data(0); data(0); data(0x01); data(0x3F);    // rows 0..319
  cmd(0x2C);
  digitalWrite(PIN_DC, HIGH);
  for (uint32_t i = 0; i < 240UL * 320UL; i++) {
    data(color >> 8);
    data(color & 0xFF);
  }
}

void stage(const char* msg) {
  Serial.printf("[%6lu ms] %s\n", millis(), msg);
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  for (int b = 0; b < 8; b++) { pinMode(DATA_PINS[b], OUTPUT); digitalWrite(DATA_PINS[b], LOW); }
  pinMode(PIN_WR, OUTPUT);  digitalWrite(PIN_WR, HIGH);
  pinMode(PIN_DC, OUTPUT);  digitalWrite(PIN_DC, HIGH);
  pinMode(PIN_RST, OUTPUT); digitalWrite(PIN_RST, HIGH);

  stage("STAGE 1: hardware reset, nothing else (expect: plain WHITE) - holding 5 s");
  delay(10);
  digitalWrite(PIN_RST, LOW);  delay(20);
  digitalWrite(PIN_RST, HIGH); delay(150);
  delay(5000);

  stage("STAGE 2: Software reset + Sleep Out + Display ON only (expect: random coloured NOISE) - holding 8 s");
  cmd(0x01); delay(150);   // software reset
  cmd(0x11); delay(150);   // sleep out
  cmd(0x29); delay(50);    // display on
  delay(8000);

  stage("STAGE 3: pixel format 16-bit + MADCTL, then colour fills");
  cmd(0x3A); data(0x55);   // 16 bits/pixel
  cmd(0x36); data(0x48);   // MX + BGR
}

void loop() {
  stage("fill RED");   fill(0xF800); delay(2000);
  stage("fill GREEN"); fill(0x07E0); delay(2000);
  stage("fill BLUE");  fill(0x001F); delay(2000);
  stage("fill BLACK"); fill(0x0000); delay(2000);
}
