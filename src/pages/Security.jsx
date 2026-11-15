import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CircleCheck,
  Clock3,
  Lock,
  Save,
  ShieldCheck,
  Wifi,
} from "lucide-react";

import { useWifiData } from "../useWifiData";
import { setTrustedNetwork, updateAlertStatus } from "../services/api";

const SECURITY_MODES = ["Open", "WEP", "WPA", "WPA/WPA2", "WPA2", "WPA3", "WPA2/WPA3", "Unknown"];
// Same ranking as the backend detector (server/detector.js).
const SECURITY_STRENGTH = { Open: 0, WEP: 1, WPA: 2, "WPA/WPA2": 2, OWE: 2, WPA2: 3, "WPA2/WPA3": 3, WPA3: 4 };

function formatTimestamp(timestamp) {
  if (!timestamp) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function Security() {
  const {
    networks,
    securityAlerts = [],
    trustedNetwork,
    trustedAP,
    modeLabel,
  } = useWifiData();
  const [selectedBssid, setSelectedBssid] = useState("");
  const [expectedSecuritySelection, setExpectedSecuritySelection] = useState({ bssid: "", mode: "" });
  const [saving, setSaving] = useState(false);
  const [pendingAlert, setPendingAlert] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  const selectedBssidIsVisible = networks.some((network) => network.bssid === selectedBssid);
  const effectiveBssid = selectedBssidIsVisible
    ? selectedBssid
    : networks.some((network) => network.bssid === trustedNetwork?.bssid)
      ? trustedNetwork.bssid
      : networks[0]?.bssid ?? "";
  const selectedNetwork = networks.find((network) => network.bssid === effectiveBssid);
  const expectedSecurity = expectedSecuritySelection.bssid === effectiveBssid
    ? expectedSecuritySelection.mode
    : trustedNetwork?.bssid === effectiveBssid
      ? trustedNetwork.expectedSecurity ?? selectedNetwork?.security ?? "Unknown"
      : selectedNetwork?.security ?? "Unknown";
  const activeAlerts = securityAlerts.filter((alert) => alert.status !== "Resolved");
  const highAlerts = activeAlerts.filter((alert) => alert.severity === "High" || alert.severity === "Critical");
  const duplicateAlerts = activeAlerts.filter((alert) =>
    alert.type === "SUSPICIOUS_DUPLICATE_AP" || alert.type === "DUPLICATE_SSID_WARNING",
  );
  const downgradeAlerts = activeAlerts.filter((alert) => alert.type === "SECURITY_DOWNGRADE");
  const rssiAlerts = activeAlerts.filter((alert) => alert.type === "RSSI_ANOMALY");
  const displayedTrustedNetwork = trustedNetwork ?? trustedAP;

  async function saveTrustedNetwork(event) {
    event.preventDefault();
    if (!selectedNetwork) return;
    setSaving(true);
    setError("");
    setFeedback("");
    try {
      await setTrustedNetwork({
        ssid: selectedNetwork.ssid,
        bssid: selectedNetwork.bssid,
        expectedSecurity,
      });
      setFeedback(`${selectedNetwork.ssid} saved as the trusted access point.`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function changeAlertStatus(alert, status) {
    setPendingAlert(alert.id);
    setError("");
    try {
      await updateAlertStatus(alert.id, status);
      setFeedback(`Alert ${status.toLowerCase()}.`);
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setPendingAlert("");
    }
  }

  return (
    <div className="page-container security-page">
      <div className="page-header">
        <div>
          <h1>Security Monitoring</h1>
          <p>Review observed security changes and access-point anomalies.</p>
        </div>
        <div className="status-badge"><span></span>{modeLabel}</div>
      </div>

      <div className="security-warning" role="note">
        <AlertTriangle size={19} />
        <p>These are suspicious indicators, not independent confirmation of an attack. Duplicate SSIDs can be legitimate mesh, repeater, or dual-band access points.</p>
      </div>

      {feedback && <p className="security-feedback" role="status">{feedback}</p>}
      {error && <p className="security-error" role="alert">{error}</p>}

      <div className="security-summary">
        <div className="summary-card"><AlertTriangle size={22} /><div><span>Active alerts</span><strong>{activeAlerts.length}</strong></div></div>
        <div className="summary-card severity-high"><Activity size={22} /><div><span>High priority</span><strong>{highAlerts.length}</strong></div></div>
        <div className="summary-card"><Wifi size={22} /><div><span>Duplicate SSIDs</span><strong>{duplicateAlerts.length}</strong></div></div>
        <div className="summary-card"><Lock size={22} /><div><span>Security downgrades</span><strong>{downgradeAlerts.length}</strong></div></div>
        <div className="summary-card"><Activity size={22} /><div><span>RSSI anomalies</span><strong>{rssiAlerts.length}</strong></div></div>
      </div>

      <div className="security-grid">
        <section className="panel trusted-config-panel">
          <div className="panel-header"><h3>Trusted Access Point</h3><ShieldCheck size={20} /></div>
          {displayedTrustedNetwork && (
            <div className="trusted-current">
              <strong>{displayedTrustedNetwork.ssid}</strong>
              <span>{displayedTrustedNetwork.bssid}</span>
              <span>Expected security: {displayedTrustedNetwork.expectedSecurity ?? displayedTrustedNetwork.security ?? "Not set"}</span>
            </div>
          )}
          <form className="trusted-config-form" onSubmit={saveTrustedNetwork}>
            <label htmlFor="trusted-network-select">Scanned network</label>
            <select
              id="trusted-network-select"
              value={effectiveBssid}
              onChange={(event) => {
                const bssid = event.target.value;
                const network = networks.find((item) => item.bssid === bssid);
                setSelectedBssid(bssid);
                setExpectedSecuritySelection({
                  bssid,
                  mode: trustedNetwork?.bssid === bssid
                    ? trustedNetwork.expectedSecurity ?? network?.security ?? "Unknown"
                    : network?.security ?? "Unknown",
                });
              }}
              required
            >
              <option value="" disabled>Select a scanned network</option>
              {networks.map((network) => (
                <option key={network.bssid} value={network.bssid}>
                  {network.ssid || "Hidden network"} · {network.bssid}
                </option>
              ))}
            </select>
            {selectedNetwork && (
              <div className="trusted-selection">
                <span>SSID <strong>{selectedNetwork.ssid || "Hidden network"}</strong></span>
                <span>BSSID <strong>{selectedNetwork.bssid}</strong></span>
                <span>Observed <strong>{selectedNetwork.security}</strong></span>
              </div>
            )}
            <label htmlFor="expected-security-select">Expected security mode</label>
            <select
              id="expected-security-select"
              value={expectedSecurity}
              onChange={(event) => setExpectedSecuritySelection({ bssid: effectiveBssid, mode: event.target.value })}
            >
              {SECURITY_MODES.map((security) => <option key={security}>{security}</option>)}
            </select>
            {selectedNetwork && (SECURITY_STRENGTH[expectedSecurity] ?? -1) > (SECURITY_STRENGTH[selectedNetwork.security] ?? 99) && (
              <p className="security-error" role="note">
                Expected {expectedSecurity} is stronger than the {selectedNetwork.security} this network
                broadcasts now, so a security-downgrade alert will be raised immediately. Choose
                the mode it really uses unless you want to demonstrate that alert.
              </p>
            )}
            <button className="security-primary-button" type="submit" disabled={!selectedNetwork || saving}>
              <Save size={16} />{saving ? "Saving..." : "Save as trusted"}
            </button>
          </form>
        </section>

        <section className="panel security-alerts-panel">
          <div className="panel-header">
            <h3>Security Alerts</h3>
            <span>{activeAlerts.length} active · refreshes with scan data</span>
          </div>
          {activeAlerts.some((alert) => alert.status === "New" && (alert.severity === "High" || alert.severity === "Critical")) && (
            <div className="new-high-indicator" role="status"><span></span>New high-priority alert</div>
          )}
          {securityAlerts.length === 0 ? (
            <div className="no-alerts"><CircleCheck size={32} /><strong>No security alerts</strong><p>No detector findings have been recorded.</p></div>
          ) : (
            <div className="security-alert-list">
              {securityAlerts.map((alert) => (
                <article className={`security-alert severity-${alert.severity?.toLowerCase() ?? "low"}`} key={alert.id}>
                  <div className="alert-icon"><AlertTriangle size={21} /></div>
                  <div className="security-alert-content">
                    <div className="alert-title-row">
                      <strong>{alert.type.replaceAll("_", " ")}</strong>
                      <span className={`severity-tag severity-${alert.severity?.toLowerCase() ?? "low"}`}>{alert.severity} · {alert.riskScore}/100</span>
                    </div>
                    <p>{alert.explanation}</p>
                    <div className="alert-evidence-grid">
                      <span>SSID <strong>{alert.ssid || "Hidden network"}</strong></span>
                      <span>Observed BSSID <strong>{alert.observedBssid}</strong></span>
                      {alert.trustedBssid && <span>Trusted BSSID <strong>{alert.trustedBssid}</strong></span>}
                      {alert.evidence?.observedSecurity && <span>Security <strong>{alert.evidence.observedSecurity}</strong></span>}
                      {alert.evidence?.expectedSecurity && <span>Expected <strong>{alert.evidence.expectedSecurity}</strong></span>}
                      {Number.isFinite(alert.evidence?.rssi) && <span>RSSI <strong>{alert.evidence.rssi} dBm</strong></span>}
                      {Number.isFinite(alert.evidence?.rssiDeviationDb) && <span>RSSI change <strong>{alert.evidence.rssiDeviationDb} dB</strong></span>}
                    </div>
                    <div className="alert-footer">
                      <span><Clock3 size={14} />{formatTimestamp(alert.timestamp)}</span>
                      <span className="alert-status">{alert.status}</span>
                    </div>
                    {alert.status !== "Resolved" && (
                      <div className="alert-actions">
                        {alert.status === "New" && (
                          <button type="button" onClick={() => changeAlertStatus(alert, "Acknowledged")} disabled={pendingAlert === alert.id}>
                            <Check size={15} />Acknowledge
                          </button>
                        )}
                        <button type="button" onClick={() => changeAlertStatus(alert, "Resolved")} disabled={pendingAlert === alert.id}>
                          <CircleCheck size={15} />Resolve
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="panel security-info-panel">
        <div className="panel-header"><h3>Detection Notes</h3></div>
        <div className="detection-info">
          <div><strong>Duplicate access points</strong><p>Matching SSIDs are warnings without a trusted baseline. With a baseline, BSSID, advertised security, RSSI, and channel are included as evidence.</p></div>
          <div><strong>Security downgrade</strong><p>Only known security strengths are ordered. Mixed WPA modes are treated conservatively, and unknown modes do not establish a downgrade.</p></div>
          <div><strong>Signal anomaly</strong><p>RSSI uses recent normal observations and requires repeated deviations of about 20 dB. Signal changes alone do not establish an attack.</p></div>
        </div>
      </div>
    </div>
  );
}

export default Security;