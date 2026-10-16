import { useEffect, useState } from "react";

import { WifiDataContext } from "./wifiDataContext";
import {
  mockAlerts,
  mockChannels,
  mockHeatmap,
  mockNetworks,
  mockTrustedAP,
} from "./data/mockData";
import { getSnapshot } from "./services/api";

const demoHistory = [
  { id: 1, date: "26 Sep 2026", time: "16:42", networks: 5, alerts: 1, status: "Completed" },
  { id: 2, date: "26 Sep 2026", time: "14:18", networks: 4, alerts: 0, status: "Completed" },
  { id: 3, date: "25 Sep 2026", time: "18:35", networks: 6, alerts: 1, status: "Completed" },
  { id: 4, date: "25 Sep 2026", time: "11:22", networks: 3, alerts: 0, status: "Completed" },
];

const demoSnapshot = {
  networks: mockNetworks.map((network) => ({
    ...network,
    securityStatus: network.security === "Open" ? "insecure" : "encrypted",
    suspicious: network.ssid === mockTrustedAP.ssid && !network.trusted,
  })),
  alerts: mockAlerts.map((alert) => ({
    ...alert,
    message: "Another access point is using the trusted network name.",
  })),
  securityAlerts: mockAlerts.map((alert, index) => ({
    id: `demo-alert-${index}`,
    timestamp: "2026-09-26T16:42:00.000Z",
    type: "SUSPICIOUS_DUPLICATE_AP",
    ssid: alert.ssid,
    observedBssid: alert.bssid,
    trustedBssid: mockTrustedAP.bssid,
    severity: alert.severity,
    riskScore: alert.anomalyScore,
    explanation: "An untrusted access point is advertising the trusted SSID. Mesh systems and repeaters can also produce duplicate SSIDs.",
    evidence: { observedSecurity: "Open", expectedSecurity: "WPA2", rssi: -54, channel: 1 },
    status: "New",
  })),
  channels: mockChannels,
  heatmap: mockHeatmap,
  trustedAP: mockTrustedAP,
  trustedNetwork: {
    ...mockTrustedAP,
    expectedSecurity: mockTrustedAP.security,
    baselineRssi: -45,
    baselineChannel: mockTrustedAP.channel,
  },
  history: demoHistory,
};

function formatHistory(history) {
  return history.map((survey) => {
    if (!survey.scannedAt) return survey;

    const scannedAt = new Date(survey.scannedAt);
    return {
      ...survey,
      date: new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(scannedAt),
      time: new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(scannedAt),
    };
  });
}

function getModeLabel(mode) {
  if (mode === "live") return "ESP32 LIVE";
  if (mode === "stale") return "ESP32 STALE";
  if (mode === "demo") return "DEMO DATA - API READY";
  return "DEMO DATA - API OFFLINE";
}

export function WifiDataProvider({ children }) {
  const [data, setData] = useState({ ...demoSnapshot, mode: "offline" });
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState("");

  useEffect(() => {
    let active = true;
    let timer;

    async function refresh() {
      try {
        const snapshot = await getSnapshot();
        if (!active) return;
        setLoading(false);
        setApiError("");
        console.info(
          `[${new Date().toISOString()}][DASHBOARD_REFRESH] ` +
          `status=${snapshot.status} scannedAt=${snapshot.scannedAt ?? "none"} ` +
          `receivedAt=${snapshot.receivedAt ?? "none"} networks=${snapshot.networks?.length ?? 0}`,
        );

        if (snapshot.status === "waiting") {
          setData({ ...demoSnapshot, mode: "demo" });
        } else {
          setData({ ...snapshot, history: formatHistory(snapshot.history), mode: snapshot.status });
        }
      } catch (error) {
        if (active) {
          console.warn(
            `[${new Date().toISOString()}][DASHBOARD_REFRESH] snapshot request failed: ` +
            `${error instanceof Error ? error.message : "unknown error"}`,
          );
          setData({ ...demoSnapshot, mode: "offline" });
          setApiError(error instanceof Error ? error.message : "The WiFiShield API is unavailable.");
          setLoading(false);
        }
      } finally {
        if (active) timer = window.setTimeout(refresh, 3000);
      }
    }

    refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const value = { ...data, loading, apiError, modeLabel: getModeLabel(data.mode) };
  return <WifiDataContext.Provider value={value}>{children}</WifiDataContext.Provider>;
}
