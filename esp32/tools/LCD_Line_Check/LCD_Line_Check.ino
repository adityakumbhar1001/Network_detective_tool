// Read-only electrical check of the LCD parallel signal lines.
// Does not send anything to the display controller.
// Uses ESP32 internal pull-ups/pull-downs (~45 kOhm) only, so it is safe
// for the ILI9341 inputs (all lines stay within 0..3.3 V).

const int pins[]  = {16, 17, 18, 19, 21, 22, 23, 25, 4, 27, 26};
const char* names[] = {"DB8/D0", "DB9/D1", "DB10/D2", "DB11/D3", "DB12/D4",
                       "DB13/D5", "DB14/D6", "DB15/D7", "WR", "RS/DC", "RST"};
const int N = sizeof(pins) / sizeof(pins[0]);

void allInput(int mode) {
  for (int i = 0; i < N; i++) pinMode(pins[i], mode);
  delay(5);
}

void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println("\n=== CHIP INFO ===");
  Serial.printf("Model: %s rev %d, cores %d\n", ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores());
  Serial.printf("PSRAM size: %u bytes\n", (unsigned)ESP.getPsramSize());
  Serial.printf("Flash size: %u bytes\n", (unsigned)ESP.getFlashChipSize());

  int faults = 0;

  Serial.println("\n=== TEST 1: each line with pull-UP (expect 1) and pull-DOWN (expect 0) ===");
  allInput(INPUT_PULLUP);
  int up[N];
  for (int i = 0; i < N; i++) up[i] = digitalRead(pins[i]);
  allInput(INPUT_PULLDOWN);
  int dn[N];
  for (int i = 0; i < N; i++) dn[i] = digitalRead(pins[i]);
  for (int i = 0; i < N; i++) {
    const char* verdict = "OK (floating / high-Z input)";
    if (up[i] == 0 && dn[i] == 0) { verdict = "STUCK LOW (tied to GND or strong pull-down)"; faults++; }
    else if (up[i] == 1 && dn[i] == 1) { verdict = "STUCK HIGH (tied to 3V3 or strong pull-up)"; faults++; }
    else if (up[i] == 0 && dn[i] == 1) { verdict = "INVERTED?? (unexpected)"; faults++; }
    Serial.printf("GPIO%-2d %-8s pullup=%d pulldown=%d  -> %s\n", pins[i], names[i], up[i], dn[i], verdict);
  }

  Serial.println("\n=== TEST 2: line-to-line shorts (drive one, watch the others) ===");
  for (int i = 0; i < N; i++) {
    for (int level = 0; level <= 1; level++) {
      // others pulled to the opposite level; any that follow the driven pin are shorted to it
      allInput(level ? INPUT_PULLDOWN : INPUT_PULLUP);
      pinMode(pins[i], OUTPUT);
      digitalWrite(pins[i], level);
      delay(2);
      for (int j = 0; j < N; j++) {
        if (j == i) continue;
        if (digitalRead(pins[j]) == level) {
          Serial.printf("SHORT? GPIO%d (%s) follows GPIO%d (%s) driven %d\n",
                        pins[j], names[j], pins[i], names[i], level);
          faults++;
        }
      }
    }
  }
  allInput(INPUT);

  Serial.printf("\n=== DONE: %d fault(s) ===\n", faults);
}

void loop() {}
