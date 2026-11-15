import {
  Wifi,
  ShieldCheck,
  AlertTriangle,
  Activity,
} from "lucide-react";

import { useWifiData } from "../useWifiData";

function Dashboard() {
  const { networks, alerts, securityAlerts = [], trustedAP, modeLabel, health, channelAdvice } = useWifiData();
  const activeSecurityAlerts = securityAlerts.filter((alert) => alert.status !== "Resolved");

  // Highest risk across per-network security warnings and backend detector findings.
  const highestRisk = Math.max(
    0,
    ...alerts.map((alert) => alert.anomalyScore ?? 0),
    ...activeSecurityAlerts.map((alert) => alert.riskScore ?? 0),
  );
  const securityWarnings = [...alerts].sort(
    (left, right) => (right.anomalyScore ?? 0) - (left.anomalyScore ?? 0),
  );

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
            <p>Security Warnings</p>
            <h2>{alerts.length}</h2>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Activity size={24} />
          </div>
          <div>
            <p>Highest Risk</p>
            <h2>{highestRisk}</h2>
          </div>
        </div>

        <div className="stat-card" title="Heuristic 0-100 summary of the latest scan: open/weak networks and active findings lower it">
          <div className="stat-icon">
            <ShieldCheck size={24} />
          </div>
          <div>
            <p>Network Health</p>
            <h2>{health?.score ?? "--"}<small>{health?.score != null ? ` / 100 ${health.label}` : ""}</small></h2>
          </div>
        </div>

        <div className="stat-card" title="Least crowded of the non-overlapping 2.4 GHz channels (1, 6, 11), by signal-weighted overlap">
          <div className="stat-icon">
            <Wifi size={24} />
          </div>
          <div>
            <p>Best Channel (2.4 GHz)</p>
            <h2>{channelAdvice?.recommended ?? "--"}</h2>
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
                className={`network-row${network.seenInLatestScan === false ? " not-current" : ""}`}
                key={network.bssid}
                title={network.seenInLatestScan === false ? "Not heard in the latest scan (seen within the last minute)" : undefined}
              >
                <div>
                  <strong>{network.ssid || "(hidden network)"}</strong>
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

          {securityWarnings.slice(0, 4).map((warning) => (
            <div className="alert-box" key={`${warning.type}-${warning.bssid}`}>
              <AlertTriangle size={22} />

              <div>
                <strong>{warning.message ?? "Potential Duplicate Network"}</strong>

                <p>SSID: {warning.ssid || "(hidden network)"}</p>
                <p>BSSID: {warning.bssid}</p>

                <span>
                  {warning.severity} · Risk {warning.anomalyScore}/100
                </span>
              </div>
            </div>
          ))}
          {securityWarnings.length === 0 && !trustedAP && (
            <p className="dashboard-no-security-alerts">
              No security warnings for the networks in range.
            </p>
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