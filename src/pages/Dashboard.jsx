import {
  Wifi,
  ShieldCheck,
  AlertTriangle,
  Activity,
} from "lucide-react";

import { useWifiData } from "../useWifiData";

function Dashboard() {
  const { networks, alerts, securityAlerts = [], trustedAP, modeLabel } = useWifiData();
  const activeSecurityAlerts = securityAlerts.filter((alert) => alert.status !== "Resolved");

  const anomalyScore =
    alerts.length > 0 ? alerts[0].anomalyScore : 0;

  return (
    <div className="dashboard">
      <div className="page-header">
        <div>
          <h1>WiFiShield Dashboard</h1>
          <p>
            Monitor nearby wireless networks and detect potential
            security anomalies.
          </p>
        </div>

        <div className="status-badge">
          <span></span>
          {modeLabel}
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">
            <Wifi size={24} />
          </div>
          <div>
            <p>APs Detected</p>
            <h2>{networks.length}</h2>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <ShieldCheck size={24} />
          </div>
          <div>
            <p>Trusted AP</p>
            <h2>{trustedAP ? 1 : 0}</h2>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon warning">
            <AlertTriangle size={24} />
          </div>
          <div>
            <p>Suspicious APs</p>
            <h2>{alerts.length}</h2>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Activity size={24} />
          </div>
          <div>
            <p>Anomaly Score</p>
            <h2>{anomalyScore}</h2>
          </div>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="panel">
          <div className="panel-header">
            <h3>Detected Networks</h3>
            <span>{networks.length} networks</span>
          </div>

          <div className="network-list">
            {networks.map((network) => (
              <div
                className="network-row"
                key={network.bssid}
              >
                <div>
                  <strong>{network.ssid}</strong>
                  <small>{network.bssid}</small>
                </div>

                <div className="network-details">
                  <span>{network.rssi} dBm</span>
                  <span>CH {network.channel}</span>
                  <span>{network.security}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel security-panel">
          <div className="panel-header">
            <h3>Security Status</h3>
          </div>

          {trustedAP && (
            <div className="trusted-network">
              <ShieldCheck size={30} />

              <div>
                <strong>{trustedAP.ssid}</strong>
                <p>{trustedAP.bssid}</p>
                <small>
                  {trustedAP.security} • Channel {trustedAP.channel}
                </small>
              </div>
            </div>
          )}

          {alerts.length > 0 && (
            <div className="alert-box">
              <AlertTriangle size={22} />

              <div>
                <strong>{alerts[0].message ?? "Potential Duplicate Network"}</strong>

                <p>SSID: {alerts[0].ssid}</p>
                <p>BSSID: {alerts[0].bssid}</p>

                <span>
                  Anomaly Score: {alerts[0].anomalyScore}/100
                </span>
              </div>
            </div>
          )}

          <section className="dashboard-security-alerts">
            <div className="panel-header">
              <h3>Backend Detection Alerts</h3>
              <span>{activeSecurityAlerts.length} active</span>
            </div>
            {activeSecurityAlerts.length > 0 ? (
              <div className="dashboard-security-alert-list">
                {activeSecurityAlerts.slice(0, 5).map((alert) => (
                  <article className="dashboard-security-alert" key={alert.id}>
                    <strong>{alert.severity} · {alert.type.replaceAll("_", " ")}</strong>
                    <span>{alert.ssid || "Hidden network"} · {alert.observedBssid}</span>
                    <p>{alert.explanation}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className="dashboard-no-security-alerts">No active backend detector alerts.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default Dashboard;