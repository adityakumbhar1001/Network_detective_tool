#include <TFT_eSPI.h>

TFT_eSPI tft = TFT_eSPI();

void setup() {
  Serial.begin(115200);
  tft.init();
  tft.setRotation(1);
}

void loop() {
  tft.fillScreen(TFT_RED);
  Serial.println("RED");
  delay(3000);

  tft.fillScreen(TFT_GREEN);
  Serial.println("GREEN");
  delay(3000);

  tft.fillScreen(TFT_BLUE);
  Serial.println("BLUE");
  delay(3000);
}
