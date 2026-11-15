import { Wifi, ShieldCheck, AlertTriangle } from "lucide-react";

import { useWifiData } from "../useWifiData";

function Networks() {
  const { networks, modeLabel } = useWifiData();

  function getStatus(network) {
    if (network.trusted) {
      return "Trusted";
    }

    if (network.suspicious) return "Suspicious";
    if (network.securityStatus === "insecure") return "Insecure";
    if (network.securityStatus === "portal") return "Open (sign-in portal)";
    if (network.securityStatus === "weak") return "Weak encryption";
    if (network.securityStatus === "unknown") return "Unknown";

    return "Encrypted";
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1>Detected Networks</h1>
          <p>
            View nearby wireless networks detected by WiFiShield.
          </p>
        </div>

        <div className="status-badge">
          <span></span>
          {modeLabel}
        </div>
      </div>

      <div className="network-summary">
        <div className="summary-card">
          <Wifi size={22} />
          <div>
            <span>Total Networks</span>
            <strong>{networks.length}</strong>
          </div>
        </div>

        <div className="summary-card">
          <ShieldCheck size={22} />
          <div>
            <span>Trusted Networks</span>
            <strong>
              {networks.filter((network) => network.trusted).length}
            </strong>
          </div>
        </div>

        <div className="summary-card warning-card">
          <AlertTriangle size={22} />
          <div>
            <span>Weak / Open / Suspicious</span>
            <strong>
              {
                networks.filter(
                  (network) =>
                    network.securityStatus !== "encrypted" || network.suspicious
                ).length
              }
            </strong>
          </div>
        </div>
      </div>

      <div className="panel networks-panel">
        <div className="panel-header">
          <h3>WiFi Networks</h3>
          <span>{networks.length} detected</span>
        </div>

        <div className="network-table-wrapper">
          <table className="network-table">
            <thead>
              <tr>
                <th>SSID</th>
                <th>BSSID</th>
                <th>Signal</th>
                <th>Channel</th>
                <th>Security</th>
                <th>Status</th>
              </tr>
            </thead>

            <tbody>
              {networks.map((network) => {
                const status = getStatus(network);

                return (
                  <tr
                    key={network.bssid}
                    className={network.seenInLatestScan === false ? "not-current" : undefined}
                    title={network.seenInLatestScan === false ? "Not heard in the latest scan (seen within the last minute)" : undefined}
                  >
                    <td>
                      <strong>{network.ssid || "(hidden network)"}</strong>
                    </td>

                    <td className="bssid">
                      {network.bssid}
                    </td>

                    <td>
                      <span className="signal-value">
                        {network.rssi} dBm
                      </span>
                    </td>

                    <td>
                      CH {network.channel}
                    </td>

                    <td>
                      <span className="security-tag">
                        {network.security}
                      </span>
                    </td>

                    <td>
                      <span
                        className={`network-status ${status
                          .toLowerCase()
                          .replace(" ", "-")}`}
                      >
                        {status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default Networks;