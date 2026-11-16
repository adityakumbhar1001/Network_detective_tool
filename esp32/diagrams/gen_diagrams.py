"""Generates the two WiFiShield wiring diagrams (SVG). Run: python gen_diagrams.py"""
import os

OUT = os.path.dirname(os.path.abspath(__file__)) + os.sep
W, H = 1500, 900
Y0, DY = 150, 18


def y(r):
    return Y0 + DY * r


RED = "#d32f2f"
BLK = "#1c1c1c"
ORG = "#ef6c00"
YEL = "#f9a825"
GRN = "#2e7d32"
BLU = "#1565c0"
PUR = "#7b1fa2"
CYN = "#00838f"
BRN = "#6d4c41"
PNK = "#c2185b"
GRY = "#546e7a"
LIM = "#7cb342"
IND = "#3949ab"


def dot(x, yy):
    return f'<circle cx="{x}" cy="{yy}" r="4.5" fill="#222"/>'


def wire(d, c, w=3.2):
    return (
        f'<path d="{d}" fill="none" stroke="#000" stroke-opacity=".25" stroke-width="{w + 2}" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
        f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{w}" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
    )


def text(x, yy, s, size=12, anchor="start", fill="#111", weight="normal"):
    return (
        f'<text x="{x}" y="{yy}" font-size="{size}" text-anchor="{anchor}" fill="{fill}" '
        f'font-weight="{weight}" font-family="Segoe UI,Arial,sans-serif">{s}</text>'
    )


def pin_r(x, yy):
    return f'<rect x="{x}" y="{yy - 4}" width="12" height="8" fill="#d4af37" stroke="#7a5f00" stroke-width=".8"/>'


def pin_l(x, yy):
    return f'<rect x="{x - 12}" y="{yy - 4}" width="12" height="8" fill="#d4af37" stroke="#7a5f00" stroke-width=".8"/>'


def resistor_v(cx, y1, y2, label):
    """Vertical resistor body between y1 and y2 (lead wires drawn by the caller)."""
    mid = (y1 + y2) / 2
    s = f'<rect x="{cx - 9}" y="{mid - 24}" width="18" height="48" rx="8" fill="#e8d3a2" stroke="#8d6e3f"/>'
    for i, c in enumerate(["#795548", "#111", "#fbc02d", "#c9a227"]):
        s += f'<rect x="{cx - 9}" y="{mid - 18 + i * 10}" width="18" height="4" fill="{c}"/>'
    if label:
        s += text(cx + 16, mid + 4, label, 12, "start")
    return s


def esp32():
    s = '<rect x="470" y="70" width="170" height="740" rx="10" fill="#14263d" stroke="#0b1623" stroke-width="2"/>'
    s += '<rect x="510" y="90" width="90" height="60" rx="3" fill="#cfd8dc" stroke="#78909c"/>'
    s += text(555, 124, "ESP32-WROOM", 11, "middle", "#263238", "bold")
    s += text(555, 700, "ESP32 DevKit", 14, "middle", "#fff", "bold")
    s += '<rect x="525" y="782" width="60" height="30" rx="4" fill="#b0bec5" stroke="#607d8b"/>'
    s += text(555, 800, "USB", 11, "middle", "#263238", "bold")
    for r, lab in {0: "VIN (5V)", 1: "GND", 3: "GPIO33 (ADC1)"}.items():
        s += pin_l(470, y(r)) + text(482, y(r) + 4, lab, 11, "start", "#fff")
    right = {
        0: "3V3", 2: "GND", 6: "GPIO26", 7: "GPIO27", 8: "GPIO4", 9: "GPIO32",
        10: "GPIO16", 11: "GPIO17", 12: "GPIO18", 13: "GPIO19", 14: "GPIO21", 15: "GPIO22",
        16: "GPIO23", 17: "GPIO25", 18: "GPIO14", 19: "GPIO13", 20: "GPIO35", 21: "GPIO5",
    }
    for r, lab in right.items():
        s += pin_r(640, y(r)) + text(632, y(r) + 4, lab, 11, "end", "#fff")
    s += pin_r(640, y(22)) + text(632, y(22) + 4, "GPIO34 (unused)", 11, "end", "#9fb3c8")
    return s


TFT_ROWS = [
    "VCC / BK_LIGHT / LEDA", "IM0", "GND", "IM1", "IM2", "LCD_CS", "LCD_RST", "LCD_RS (DC)",
    "LCD_WR", "LCD_RD", "DB8", "DB9", "DB10", "DB11", "DB12", "DB13", "DB14", "DB15",
    "T_CLK", "T_DIN", "T_DOUT", "T_CS", "T_IRQ (not wired)",
]


def tft():
    s = '<rect x="1000" y="70" width="380" height="580" rx="8" fill="#222" stroke="#000" stroke-width="2"/>'
    s += '<rect x="1160" y="110" width="200" height="300" fill="#0d1b2a" stroke="#4a5a6a" stroke-width="2"/>'
    s += text(1260, 255, '3.2" ILI9341', 16, "middle", "#7fd0ff", "bold")
    s += text(1260, 278, "240 x 320 TFT", 12, "middle", "#7fd0ff")
    s += text(1260, 300, "+ XPT2046 touch", 12, "middle", "#7fd0ff")
    s += text(1000, 60, 'SmartElex 3.2" TFT (8-bit parallel)', 14, "start", "#111", "bold")
    for r, label in enumerate(TFT_ROWS):
        s += pin_l(1000, y(r)) + text(1010, y(r) + 4, label, 11, "start", "#fff")
    s += text(1190, 630, "DB0-DB7: not connected", 11, "start", "#bbb")
    return s


def display_wires():
    s = ""
    sig = {
        6: ORG, 7: YEL, 8: GRN, 9: CYN, 10: BLU, 11: PUR, 12: BRN, 13: PNK, 14: GRY,
        15: LIM, 16: IND, 17: "#00acc1", 18: "#8e24aa", 19: "#f4511e", 20: "#43a047", 21: "#3949ab",
    }
    for r, c in sig.items():
        s += wire(f"M652 {y(r)} H988", c)
    s += wire(f"M652 {y(0)} H988", RED) + wire(f"M900 {y(0)} V{y(1)} H988", RED) + dot(900, y(0))
    s += wire(f"M652 {y(2)} H988", BLK) + wire(f"M900 {y(2)} V{y(5)}", BLK)
    for r in (3, 4, 5):
        s += wire(f"M900 {y(r)} H988", BLK) + dot(900, y(r))
    s += dot(900, y(2))
    s += text(820, y(0) - 8, "3V3", 11, "middle", RED, "bold") + text(820, y(2) - 8, "GND", 11, "middle", BLK, "bold")
    return s


def header(title, sub):
    s = f'<rect width="{W}" height="{H}" fill="#f4f1ea"/>'
    s += text(30, 34, title, 24, "start", "#111", "bold") + text(30, 58, sub, 13, "start", "#444")
    return s


def legend():
    s = '<rect x="1000" y="700" width="460" height="170" rx="8" fill="#fff" stroke="#bbb"/>'
    s += text(1015, 722, "How to read", 13, "start", "#111", "bold")
    s += f'<rect x="1015" y="733" width="26" height="4" fill="{RED}"/>' + text(1050, 739, "3V3 / 5V power", 12)
    s += f'<rect x="1015" y="751" width="26" height="4" fill="{BLK}"/>' + text(1050, 757, "GND", 12)
    s += f'<rect x="1015" y="769" width="26" height="4" fill="{BLU}"/>' + text(1050, 775, "data / control signals (one colour each)", 12)
    s += text(1015, 797, "Wires that cross without a black dot are NOT connected.", 12)
    s += text(1015, 815, "ESP32 pins are shown grouped by use, not in board order.", 12)
    return s


def diagram_usb():
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
    s += header(
        "WiFiShield - wiring WITHOUT battery (USB powered)",
        'Laptop USB powers the ESP32; the ESP32 3V3 pin powers the display. The battery corner shows "USB".',
    )
    s += esp32() + tft() + display_wires()
    s += '<rect x="60" y="600" width="260" height="150" rx="8" fill="#cfd8dc" stroke="#607d8b" stroke-width="2"/>'
    s += '<rect x="90" y="620" width="200" height="90" fill="#263238"/>'
    s += text(190, 672, "Laptop", 18, "middle", "#fff", "bold") + text(190, 735, "USB port", 12, "middle", "#263238")
    s += wire("M290 735 H555 V812", "#37474f", 6)
    s += text(462, 726, "USB cable: power + upload", 11, "end", "#111")
    s += text(60, 560, "Power path: Laptop USB -> ESP32 -> 3V3 pin -> display", 13, "start", "#111", "bold")
    s += text(60, 582, "No battery module, no divider and no capacitor in this version.", 12, "start", "#444")
    s += text(462, 226, "GPIO33 left unconnected", 12, "end", "#777")
    s += text(462, 244, "VIN not used (USB powers it)", 12, "end", "#777")
    s += legend() + "</svg>"
    open(OUT + "wifishield_wiring_usb_only.svg", "w", encoding="utf-8").write(s)


def diagram_battery():
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
    s += header(
        "WiFiShield - wiring WITH battery (portable)",
        "18650 cell -> IP5306 boost/charge module -> ESP32 VIN. A divider reads the battery on GPIO33. USB cable NOT plugged in.",
    )
    s += esp32() + tft() + display_wires()
    # IP5306 module
    s += '<rect x="60" y="220" width="240" height="200" rx="8" fill="#b71c1c" stroke="#7f0000" stroke-width="2"/>'
    s += text(60, 210, "IP5306 power-bank module", 13, "start", "#111", "bold")
    s += text(75, 246, "Type-C 5V 2A boost + charger", 11, "start", "#ffd7d7")
    s += '<rect x="75" y="285" width="46" height="22" rx="3" fill="#cfd8dc" stroke="#607d8b"/>'
    s += text(98, 300, "Type-C", 9, "middle", "#263238", "bold")
    s += text(75, 328, "IN: charger only", 10, "start", "#ffd7d7")
    s += text(75, 345, "LEDs show charge level", 10, "start", "#ffd7d7")
    s += pin_r(300, 250) + text(290, 254, "OUT 5V+", 11, "end", "#fff")
    s += pin_r(300, 290) + text(290, 294, "OUT GND", 11, "end", "#fff")
    s += pin_r(300, 330) + text(290, 334, "K (free)", 11, "end", "#ffd7d7")
    s += '<rect x="104" y="414" width="12" height="10" fill="#d4af37"/><rect x="244" y="414" width="12" height="10" fill="#d4af37"/>'
    s += text(110, 408, "B+", 11, "middle", "#fff", "bold") + text(250, 408, "B-", 11, "middle", "#fff", "bold")
    # 5V and GND to ESP32
    s += wire("M312 250 H380 V150 H468", RED, 4)
    s += wire("M312 290 H430 V168 H468", BLK, 4)
    # capacitor across 5V/GND
    s += wire("M380 215 H392", RED, 2.5) + wire("M418 215 H430", BLK, 2.5)
    s += '<rect x="392" y="202" width="26" height="26" rx="5" fill="#1565c0" stroke="#0d3b7a"/>'
    s += '<rect x="411" y="202" width="7" height="26" fill="#90caf9"/>'
    s += text(395, 222, "+", 14, "start", "#fff", "bold")
    s += dot(380, 215) + dot(430, 215)
    s += text(372, 219, "C 470uF 16V", 11, "end", "#111")
    # battery
    s += '<rect x="130" y="600" width="100" height="50" rx="10" fill="#2e7d32" stroke="#1b5e20" stroke-width="2"/>'
    s += text(180, 621, "Li-ion 18650", 11, "middle", "#fff", "bold") + text(180, 637, "Sony VTC6 3.7V", 10, "middle", "#e8f5e9")
    s += '<rect x="120" y="618" width="10" height="14" fill="#cfd8dc"/><rect x="230" y="618" width="10" height="14" fill="#cfd8dc"/>'
    s += text(112, 646, "+", 16, "end", "#d32f2f", "bold") + text(250, 646, "-", 18, "start", "#111", "bold")
    s += text(180, 672, "in battery holder", 11, "middle", "#444")
    s += wire("M110 424 V625 H120", RED, 4)
    s += wire("M250 424 V625 H240", BLK, 4)
    # voltage divider: cell + -> R1 -> node -> R2 -> GND, node -> GPIO33
    s += wire("M110 470 H238 a12 12 0 0 1 24 0 H400 V398", RED, 2.5) + dot(110, 470)
    s += wire("M400 398 V350", "#9e9e9e", 2.5) + resistor_v(400, 398, 350, "")+text(384, 378, "R1 100k", 12, "end")
    s += wire("M400 350 V302", "#9e9e9e", 2.5) + resistor_v(400, 350, 302, "")+text(384, 330, "R2 100k", 12, "end")
    s += wire("M400 302 V290", BLK, 2.5)
    s += dot(400, 290) + dot(400, 350)
    s += wire("M400 350 H455 V204 H468", GRN, 2.5)
    s += text(463, 372, "to GPIO33", 10, "end", GRN, "bold")
    s += text(275, 520, "Divider: cell + -> R1 -> R2 -> GND", 11, "start", "#111", "bold")
    s += text(275, 536, "GPIO33 sees half the cell voltage", 11, "start", "#444")
    s += text(60, 710, "Charging: remove the 5V+ wire to the ESP32,", 12, "start", "#111", "bold")+text(60, 728, "then plug a charger into the Type-C port.", 12, "start", "#111", "bold")
    s += text(60, 750, "Never connect USB and the 5V+ wire together.", 12, "start", "#c62828", "bold")
    s += text(60, 772, "K pad: leave free (touch to GND ~1 s only to wake).", 11, "start", "#444")
    s += legend() + "</svg>"
    open(OUT + "wifishield_wiring_with_battery.svg", "w", encoding="utf-8").write(s)


if __name__ == "__main__":
    diagram_usb()
    diagram_battery()
    print("written to", OUT)
