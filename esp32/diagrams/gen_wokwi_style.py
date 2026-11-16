"""Wokwi-style wiring diagrams (dark dotted canvas, one wire per pin, curved wires).
Run: python gen_wokwi_style.py   (does not touch the other diagrams)"""
import os

OUT = os.path.dirname(os.path.abspath(__file__)) + os.sep
W, H = 1500, 900
Y0, DY = 150, 18
TFT_DY = 36  # TFT sits lower than the ESP32 so every wire is a gentle S-curve

RED, BLK, GND_C = "#ff5252", "#8a8f98", "#9aa0a6"
SIGNALS = {
    6: ("#ff9800", "GPIO26", "LCD_RST"), 7: ("#ffd600", "GPIO27", "LCD_RS (DC)"),
    8: ("#00e676", "GPIO4", "LCD_WR"), 9: ("#18ffff", "GPIO32", "LCD_RD"),
    10: ("#448aff", "GPIO16", "DB8"), 11: ("#b388ff", "GPIO17", "DB9"),
    12: ("#a1887f", "GPIO18", "DB10"), 13: ("#ff80ab", "GPIO19", "DB11"),
    14: ("#90a4ae", "GPIO21", "DB12"), 15: ("#b2ff59", "GPIO22", "DB13"),
    16: ("#7c4dff", "GPIO23", "DB14"), 17: ("#26c6da", "GPIO25", "DB15"),
    18: ("#e040fb", "GPIO14", "T_CLK"), 19: ("#ff6e40", "GPIO13", "T_DIN"),
    20: ("#69f0ae", "GPIO35", "T_DOUT"), 21: ("#536dfe", "GPIO5", "T_CS"),
}


def ye(r):
    return Y0 + DY * r


def yt(r):
    return Y0 + TFT_DY + DY * r


def text(x, y, s, size=12, anchor="start", fill="#e8eaed", weight="normal"):
    return (f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" fill="{fill}" '
            f'font-weight="{weight}" font-family="Segoe UI,Arial,sans-serif">{s}</text>')


def end(x, y):
    return f'<circle cx="{x}" cy="{y}" r="3.2" fill="#e8eaed" stroke="#111" stroke-width="1"/>'


def curve(x1, y1, x2, y2, color, w=2.6):
    mx = (x1 + x2) / 2
    d = f"M{x1} {y1} C{mx} {y1} {mx} {y2} {x2} {y2}"
    return (f'<path d="{d}" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="{w + 1.6}" stroke-linecap="round"/>'
            f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round"/>'
            + end(x1, y1) + end(x2, y2))


def rounded(points, color, w=3, r=12):
    """Polyline with rounded corners (Wokwi-style routed wire)."""
    d = f"M{points[0][0]} {points[0][1]}"
    for i in range(1, len(points) - 1):
        (x0, y0), (x1, y1), (x2, y2) = points[i - 1], points[i], points[i + 1]
        def toward(a, b, dist):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = max((dx * dx + dy * dy) ** 0.5, 1e-6)
            return a[0] + dx / length * dist, a[1] + dy / length * dist
        rr = min(r, ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 / 2, ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5 / 2)
        px, py = toward((x1, y1), (x0, y0), rr)
        qx, qy = toward((x1, y1), (x2, y2), rr)
        d += f" L{px:.1f} {py:.1f} Q{x1} {y1} {qx:.1f} {qy:.1f}"
    d += f" L{points[-1][0]} {points[-1][1]}"
    return (f'<path d="{d}" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="{w + 1.6}" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>'
            + end(*points[0]) + end(*points[-1]))


def junction(x, y):
    return f'<circle cx="{x}" cy="{y}" r="4.5" fill="#e8eaed" stroke="#111"/>'


def pin_label_r(x, y, s):
    return text(x, y + 4, s, 11, "end", "#fff")


def background():
    s = (f'<defs><pattern id="g" width="20" height="20" patternUnits="userSpaceOnUse">'
         f'<circle cx="2" cy="2" r="1" fill="#3a4048"/></pattern></defs>')
    s += f'<rect width="{W}" height="{H}" fill="#1a1d21"/><rect width="{W}" height="{H}" fill="url(#g)"/>'
    return s


def title(t, sub):
    return text(30, 34, t, 24, "start", "#fff", "bold") + text(30, 58, sub, 13, "start", "#aab0b8")


def esp32():
    s = '<rect x="470" y="70" width="170" height="740" rx="8" fill="#0e1b2c" stroke="#2c4a70" stroke-width="2"/>'
    s += '<rect x="505" y="84" width="100" height="70" rx="3" fill="#b9c2c9"/>'
    s += text(555, 124, "ESP32-WROOM", 11, "middle", "#1c2a38", "bold")
    s += text(555, 700, "ESP32 DevKit V1", 14, "middle", "#fff", "bold")
    s += '<rect x="528" y="782" width="54" height="28" rx="4" fill="#9aa5ae"/>' + text(555, 800, "USB", 11, "middle", "#1c2a38", "bold")
    for r, lab in {0: "VIN", 1: "GND", 3: "D33"}.items():
        s += f'<circle cx="470" cy="{ye(r)}" r="4" fill="#d4af37"/>' + text(480, ye(r) + 4, lab, 11, "start", "#fff")
    right = {0: "3V3", 2: "GND"}
    right.update({r: v[1] for r, v in SIGNALS.items()})
    for r, lab in right.items():
        s += f'<circle cx="640" cy="{ye(r)}" r="4" fill="#d4af37"/>' + pin_label_r(630, ye(r), lab)
    s += f'<circle cx="640" cy="{ye(22)}" r="4" fill="#d4af37"/>' + text(630, ye(22) + 4, "GPIO34 (unused)", 11, "end", "#7d8a99")
    return s


TFT_PINS = ["VCC", "IM0", "GND", "IM1", "IM2", "LCD_CS"] + [SIGNALS[r][2] for r in range(6, 22)] + ["T_IRQ (unused)"]


def tft():
    top = Y0 + TFT_DY - 80
    s = f'<rect x="1000" y="{top}" width="380" height="580" rx="6" fill="#101214" stroke="#3a3f45" stroke-width="2"/>'
    s += f'<rect x="1150" y="{top + 30}" width="210" height="300" fill="#05070a" stroke="#2a2f35" stroke-width="2"/>'
    s += text(1255, top + 170, '3.2" ILI9341', 16, "middle", "#6ec6ff", "bold") + text(1255, top + 192, "+ XPT2046 touch", 12, "middle", "#6ec6ff")
    s += text(1000, top - 10, "ILI9341 TFT (8-bit parallel, SmartElex 3.2\")", 14, "start", "#fff", "bold")
    for i, label in enumerate(TFT_PINS):
        s += f'<circle cx="1000" cy="{yt(i)}" r="4" fill="#d4af37"/>' + text(1010, yt(i) + 4, label, 11, "start", "#fff")
    s += text(1180, top + 560, "DB0-DB7 not connected", 11, "start", "#7d8a99")
    return s


def display_wires():
    s = ""
    for r, (c, _, _) in SIGNALS.items():
        s += curve(640, ye(r), 1000, yt(r), c)
    # one wire per pin, like Wokwi: power fans out from a single ESP32 pin
    s += curve(640, ye(0), 1000, yt(0), RED) + curve(640, ye(0), 1000, yt(1), RED)
    for t in (2, 3, 4, 5):
        s += curve(640, ye(2), 1000, yt(t), GND_C)
    s += text(820, ye(0) - 12, "3V3", 11, "middle", RED, "bold")
    return s


def legend():
    s = '<rect x="1000" y="700" width="460" height="100" rx="8" fill="#23272d" stroke="#3a3f45"/>'
    s += text(1015, 724, "Legend", 13, "start", "#fff", "bold")
    s += f'<rect x="1015" y="735" width="26" height="4" fill="{RED}"/>' + text(1050, 741, "3V3 / 5V power", 12)
    s += f'<rect x="1015" y="753" width="26" height="4" fill="{GND_C}"/>' + text(1050, 759, "GND", 12)
    s += f'<rect x="1015" y="771" width="26" height="4" fill="#448aff"/>' + text(1050, 777, "signals (one colour per wire)", 12)
    return s


def usb_only():
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">' + background()
    s += title("WiFiShield - USB powered ", "Laptop USB powers the ESP32; the 3V3 pin powers the display. Battery corner shows \"USB\".")
    s += esp32() + tft() + display_wires()
    s += '<rect x="60" y="600" width="260" height="150" rx="8" fill="#2c3238" stroke="#556" stroke-width="2"/>'
    s += '<rect x="90" y="620" width="200" height="90" fill="#101214"/>' + text(190, 672, "Laptop", 18, "middle", "#fff", "bold")
    s += text(190, 735, "USB port", 12, "middle", "#c4c9d0")
    s += rounded([(300, 735), (555, 735), (555, 782)], "#78909c", 5)
    s += text(462, 726, "USB cable: power + upload", 11, "end", "#c4c9d0")
    s += text(60, 560, "Power: Laptop USB -> ESP32 -> 3V3 -> display", 13, "start", "#fff", "bold")
    s += text(60, 582, "No battery module, divider or capacitor here.", 12, "start", "#aab0b8")
    s += text(462, 226, "VIN and D33 not wired", 12, "end", "#7d8a99")
    s += legend() + "</svg>"
    open(OUT + "wokwi_style_usb_only.svg", "w", encoding="utf-8").write(s)


def with_battery():
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">' + background()
    s += title("WiFiShield - battery powered ", "18650 -> IP5306 module -> ESP32 VIN; divider to D33 reads the battery. USB cable NOT plugged in.")
    s += esp32() + tft() + display_wires()
    # IP5306 module
    s += text(60, 210, "IP5306 power-bank module", 13, "start", "#fff", "bold")
    s += '<rect x="60" y="220" width="240" height="200" rx="8" fill="#1e4fa3" stroke="#0d2a5e" stroke-width="2"/>'
    s += text(75, 246, "Type-C 5V 2A boost + charger", 11, "start", "#cfe0ff")
    s += '<rect x="75" y="285" width="46" height="22" rx="3" fill="#cfd8dc"/>' + text(98, 300, "Type-C", 9, "middle", "#1c2a38", "bold")
    s += text(75, 328, "IN: charger only", 10, "start", "#cfe0ff") + text(75, 345, "LEDs = charge level", 10, "start", "#cfe0ff")
    for lab, yy in (("OUT 5V+", 250), ("OUT GND", 290), ("K (free)", 330)):
        s += f'<circle cx="300" cy="{yy}" r="4" fill="#d4af37"/>' + text(290, yy + 4, lab, 11, "end", "#fff")
    s += f'<circle cx="110" cy="420" r="4" fill="#d4af37"/><circle cx="250" cy="420" r="4" fill="#d4af37"/>'
    s += text(110, 410, "B+", 11, "middle", "#fff", "bold") + text(250, 410, "B-", 11, "middle", "#fff", "bold")
    # power to ESP32
    s += rounded([(300, 250), (380, 250), (380, 150), (470, 150)], RED, 3.5)
    s += rounded([(300, 290), (430, 290), (430, ye(1)), (470, ye(1))], GND_C, 3.5)
    # capacitor between the two
    s += '<rect x="392" y="202" width="26" height="26" rx="5" fill="#1e63c8" stroke="#0d3b7a"/><rect x="411" y="202" width="7" height="26" fill="#9ecbff"/>'
    s += text(395, 222, "+", 14, "start", "#fff", "bold")
    s += rounded([(380, 215), (392, 215)], RED, 2.5) + rounded([(418, 215), (430, 215)], GND_C, 2.5)
    s += junction(380, 215) + junction(430, 215) + text(372, 219, "C 470uF 16V", 11, "end", "#e8eaed")
    # cell
    s += '<rect x="130" y="600" width="100" height="50" rx="10" fill="#2e9e4f" stroke="#17642f" stroke-width="2"/>'
    s += text(180, 621, "Li-ion 18650", 11, "middle", "#fff", "bold") + text(180, 637, "Sony VTC6 3.7V", 10, "middle", "#e8f5e9")
    s += text(112, 646, "+", 16, "end", RED, "bold") + text(250, 646, "-", 18, "start", "#e8eaed", "bold")
    s += text(180, 672, "in battery holder", 11, "middle", "#aab0b8")
    s += rounded([(110, 420), (110, 625), (130, 625)], RED, 3.5)
    s += rounded([(250, 420), (250, 625), (230, 625)], GND_C, 3.5)
    # divider
    s += (f'<path d="M110 470 L238 470 A12 12 0 0 1 262 470 L400 470 L400 400" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="4.6"/>'
          f'<path d="M110 470 L238 470 A12 12 0 0 1 262 470 L400 470 L400 400" fill="none" stroke="{RED}" stroke-width="3"/>')
    s += junction(110, 470)
    for (a, b, lab, ty) in ((398, 350, "R1 100k", 378), (350, 302, "R2 100k", 330)):
        s += f'<line x1="400" y1="{a}" x2="400" y2="{b}" stroke="#9e9e9e" stroke-width="2.5"/>'
        s += f'<rect x="391" y="{(a + b) / 2 - 24}" width="18" height="48" rx="8" fill="#e8d3a2" stroke="#8d6e3f"/>'
        for i, c in enumerate(["#795548", "#111", "#fbc02d", "#c9a227"]):
            s += f'<rect x="391" y="{(a + b) / 2 - 18 + i * 10}" width="18" height="4" fill="{c}"/>'
        s += text(384, ty, lab, 12, "end")
    s += f'<line x1="400" y1="302" x2="400" y2="290" stroke="{GND_C}" stroke-width="2.5"/>' + junction(400, 290) + junction(400, 350)
    s += rounded([(400, 350), (455, 350), (455, ye(3)), (470, ye(3))], "#69f0ae", 2.6)
    s += text(463, 372, "to D33", 10, "end", "#69f0ae", "bold")
    s += text(275, 520, "Divider: cell + -> R1 -> R2 -> GND", 11, "start", "#fff", "bold")
    s += text(275, 536, "D33 sees half the cell voltage", 11, "start", "#aab0b8")
    s += text(60, 710, "Charging: remove the 5V+ wire to the ESP32,", 12, "start", "#fff", "bold")
    s += text(60, 728, "then plug a charger into the Type-C port.", 12, "start", "#fff", "bold")
    s += text(60, 750, "Never connect USB and the 5V+ wire together.", 12, "start", "#ff6b6b", "bold")
    s += text(60, 772, "K pad: leave free (touch to GND ~1 s only to wake).", 11, "start", "#aab0b8")
    s += legend() + "</svg>"
    open(OUT + "wokwi_style_with_battery.svg", "w", encoding="utf-8").write(s)


if __name__ == "__main__":
    usb_only()
    with_battery()
    print("written to", OUT)
