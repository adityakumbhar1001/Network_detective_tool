import {
  LayoutDashboard,
  Wifi,
  Map,
  ShieldCheck,
  BarChart3,
  History,
} from "lucide-react";

import { useWifiData } from "../useWifiData";

const CONNECTION_STATUS = {
  live: { title: "ESP32 connected", detail: "Live scans every 15 s" },
  stale: { title: "ESP32 stale", detail: "No scan in the last 30 s" },
  waiting: { title: "Waiting for ESP32", detail: "API ready, no scan yet" },
  demo: { title: "Demo Mode", detail: "API ready, no scan yet" },
  offline: { title: "Demo Mode", detail: "API offline" },
};

function Sidebar({ activePage, setActivePage }) {
  const { mode } = useWifiData();
  const connection = CONNECTION_STATUS[mode] ?? CONNECTION_STATUS.offline;
  const menuItems = [
    {
      name: "Dashboard",
      icon: LayoutDashboard,
    },
    {
      name: "Networks",
      icon: Wifi,
    },
    {
      name: "Signal Heatmap",
      icon: Map,
    },
    {
      name: "Security",
      icon: ShieldCheck,
    },
    {
      name: "Channels",
      icon: BarChart3,
    },
    {
      name: "Survey History",
      icon: History,
    },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon">
          <Wifi size={22} />
        </div>

        <div>
          <h2>WiFiShield</h2>
          <span>Wireless Security</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {menuItems.map((item) => {
          const Icon = item.icon;

          return (
            <button
              key={item.name}
              className={`nav-item ${
                activePage === item.name ? "active" : ""
              }`}
              onClick={() => setActivePage(item.name)}
            >
              <Icon size={19} />
              <span>{item.name}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="connection-status">
          <span className={`status-dot${mode === "live" ? " live" : ""}`}></span>

          <div>
            <strong>{connection.title}</strong>
            <small>{connection.detail}</small>
          </div>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;