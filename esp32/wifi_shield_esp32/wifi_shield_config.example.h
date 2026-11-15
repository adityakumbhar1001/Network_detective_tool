#pragma once
// Copy this file to wifi_shield_config.h (git-ignored) and fill in your networks.
// The ESP32 only supports 2.4 GHz networks.

// Network 1 (preferred when both are in range).
#define WIFISHIELD_WIFI_SSID ""
#define WIFISHIELD_WIFI_PASSWORD ""

// Optional network 2, used automatically when network 1 is not in range.
#define WIFISHIELD_WIFI_SSID_2 ""
#define WIFISHIELD_WIFI_PASSWORD_2 ""

// The firmware finds the PC running the backend by UDP discovery (port 3001), so this
// URL is only a starting guess; it may be left with any LAN IP of the backend PC.
#define WIFISHIELD_API_URL "http://:3001/api/scans"
#define WIFISHIELD_SNAPSHOT_URL "http://:3001/api/snapshot"
#define WIFISHIELD_DEVICE_TOKEN ""
