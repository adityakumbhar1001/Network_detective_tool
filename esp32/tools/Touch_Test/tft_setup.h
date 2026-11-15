#pragma once
#pragma message("WIFI SHIELD PARALLEL SETUP LOADED")
#define USER_SETUP_INFO "WiFiShield ESP32 ILI9341 8-bit Parallel"

#define ILI9341_DRIVER
#define TFT_PARALLEL_8_BIT

// 8-bit parallel data bus
#define TFT_D0 16
#define TFT_D1 17
#define TFT_D2 18
#define TFT_D3 19
#define TFT_D4 21
#define TFT_D5 22
#define TFT_D6 23
#define TFT_D7 25

// Display control pins
#define TFT_WR  4
#define TFT_DC  27
#define TFT_RST 26

// Display CS is physically connected to GND.
// Display RD is connected to GPIO32 (enables readback, e.g. readPixel / readcommand8).
#define TFT_CS -1
#define TFT_RD 32

// Fonts used by WiFiShield
#define LOAD_GLCD
#define LOAD_FONT2
#define LOAD_FONT4
#define LOAD_FONT6
#define LOAD_FONT7
#define LOAD_FONT8
#define LOAD_GFXFF
#define SMOOTH_FONT

// Touch controller uses a separate SPI connection
#define SPI_TOUCH_FREQUENCY 2500000