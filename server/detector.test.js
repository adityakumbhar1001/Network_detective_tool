import assert from "node:assert/strict";
import { test } from "node:test";

import { processScanDetections, sameRouterBssids, securityStrength } from "./detector.js";

const trustedBssid = "AA:BB:CC:11:22:33";
const otherBssid = "11:22:33:44:55:66";

function makeState(trustedNetwork = null) {
  return {
    trustedNetwork,
    alerts: [],
    currentConditions: [],
    rssiHistory: {},
    rssiCandidates: {},
  };
}

function network(bssid, overrides = {}) {
  return {
    ssid: "HomeWiFi",
    bssid,
    rssi: -55,
    channel: 6,
    security: "WPA2",
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

function scan(networks, index) {
  return {
    scannedAt: new Date(Date.UTC(2026, 9, 2, 0, 0, index)).toISOString(),
    networks,
  };
}

const trustedBaseline = () => ({
  bssid: trustedBssid,
  ssid: "HomeWiFi",
  expectedSecurity: "WPA2",
  baselineRssi: -55,
  baselineChannel: 6,
});

test("flags a different BSSID on the trusted SSID as suspicious, not confirmed attack", () => {
  const state = makeState(trustedBaseline());
  processScanDetections(state, scan([
    network(trustedBssid),
    network(otherBssid, { rssi: -75, channel: 11 }),
  ], 1));

  const alert = state.alerts.find((item) => item.type === "SUSPICIOUS_DUPLICATE_AP");
  assert.ok(alert);
  assert.equal(alert.observedBssid, otherBssid);
  assert.equal(alert.trustedBssid, trustedBssid);
  assert.equal(alert.evidence.expectedSecurity, "WPA2");
  assert.match(alert.explanation, /mesh systems/i);
});

test("detects a trusted SSID on an untrusted BSSID while the trusted AP is absent", () => {
  const state = makeState(trustedBaseline());
  processScanDetections(state, scan([
    network(otherBssid, { security: "Open", rssi: -35, channel: 11 }),
  ], 1));

  const alert = state.alerts.find((item) => item.type === "SUSPICIOUS_DUPLICATE_AP");
  assert.ok(alert);
  assert.equal(alert.observedBssid, otherBssid);
  assert.equal(alert.trustedBssid, trustedBssid);
});

test("reports duplicate SSIDs as a warning when no trusted baseline exists", () => {
  const state = makeState();
  processScanDetections(state, scan([
    network(trustedBssid),
    network(otherBssid, { channel: 11 }),
  ], 1));

  assert.equal(state.alerts.length, 1);
  assert.equal(state.alerts[0].type, "DUPLICATE_SSID_WARNING");
  assert.equal(state.alerts[0].trustedBssid, null);
  assert.equal(state.alerts[0].severity, "Low");
});

test("learns the security baseline from the first scan for BSSID-only startup configuration", () => {
  const state = makeState({
    bssid: trustedBssid,
    ssid: "",
    expectedSecurity: "",
    baselineRssi: null,
    baselineChannel: null,
  });
  processScanDetections(state, scan([network(trustedBssid)], 1));
  assert.equal(state.trustedNetwork.ssid, "HomeWiFi");
  assert.equal(state.trustedNetwork.expectedSecurity, "WPA2");

  processScanDetections(state, scan([network(trustedBssid, { security: "Open" })], 2));
  assert.ok(state.alerts.some((item) => item.type === "SECURITY_DOWNGRADE"));
});

test("prioritizes an open-network downgrade from WPA2", () => {
  const state = makeState(trustedBaseline());
  processScanDetections(state, scan([
    network(trustedBssid, { security: "Open" }),
  ], 1));

  const alert = state.alerts.find((item) => item.type === "SECURITY_DOWNGRADE");
  assert.ok(alert);
  assert.equal(alert.severity, "Critical");
  assert.equal(alert.evidence.expectedSecurity, "WPA2");
  assert.equal(alert.evidence.observedSecurity, "Open");
});

test("compares supported security modes conservatively", () => {
  assert.equal(securityStrength("Open"), 0);
  assert.equal(securityStrength("WEP"), 1);
  assert.equal(securityStrength("WPA"), 2);
  assert.equal(securityStrength("WPA/WPA2"), 2);
  assert.equal(securityStrength("WPA2"), 3);
  assert.equal(securityStrength("WPA2/WPA3"), 3);
  assert.equal(securityStrength("WPA3"), 4);
  assert.equal(securityStrength("Unknown"), null);
});

test("flags significant RSSI changes only after repeated outlier observations", () => {
  const state = makeState();
  for (let index = 0; index < 3; index += 1) {
    processScanDetections(state, scan([network(trustedBssid)], index));
  }

  processScanDetections(state, scan([network(trustedBssid, { rssi: -25 })], 4));
  assert.equal(state.alerts.some((item) => item.type === "RSSI_ANOMALY"), false);
  processScanDetections(state, scan([network(trustedBssid, { rssi: -25 })], 5));

  const alert = state.alerts.find((item) => item.type === "RSSI_ANOMALY");
  assert.ok(alert);
  assert.equal(alert.evidence.rssiDeviationDb, 30);
  assert.equal(alert.evidence.consecutiveOutliers, 2);
});

test("normal RSSI fluctuations do not trigger an anomaly", () => {
  const state = makeState();
  for (const [index, rssi] of [-54, -58, -51, -63, -57, -52].entries()) {
    processScanDetections(state, scan([network(trustedBssid, { rssi })], index));
  }

  assert.equal(state.alerts.some((item) => item.type === "RSSI_ANOMALY"), false);
});

test("loads older persisted RSSI observations without crashing", () => {
  const state = makeState();
  state.rssiHistory[trustedBssid] = {
    observations: [
      { rssi: -55, scannedAt: "2026-10-02T00:00:00.000Z" },
      { rssi: -56, scannedAt: "2026-10-02T00:00:15.000Z" },
      { rssi: -54, scannedAt: "2026-10-02T00:00:30.000Z" },
    ],
    baselineMean: -55,
    baselineCount: 3,
  };

  assert.doesNotThrow(() => processScanDetections(state, scan([network(trustedBssid)], 1)));
  assert.equal(state.rssiHistory[trustedBssid].baselineObservations.length, 4);
});

test("repeated unchanged duplicate observations update one alert", () => {
  const state = makeState();
  const networks = [network(trustedBssid), network(otherBssid, { channel: 11 })];
  processScanDetections(state, scan(networks, 1));
  const firstId = state.alerts[0].id;
  processScanDetections(state, scan(networks, 2));

  assert.equal(state.alerts.length, 1);
  assert.equal(state.alerts[0].id, firstId);
  assert.equal(state.alerts[0].updatedAt, scan(networks, 2).scannedAt);
});

test("recognises BSSIDs from the same router's address block", () => {
  assert.ok(sameRouterBssids("24:0B:88:FB:9E:69", "26:0B:88:CB:9E:69"));
  assert.ok(sameRouterBssids("AA:BB:CC:11:22:33", "AA:BB:CC:11:22:34"));
  assert.ok(!sameRouterBssids("AA:BB:CC:11:22:33", "AA:BB:CC:99:22:34"));
  assert.ok(!sameRouterBssids("AA:BB:CC:11:22:33", "AA:BB:CD:11:22:33"));
});

test("does not warn about duplicate SSIDs from one router's radios", () => {
  const state = makeState();
  processScanDetections(state, scan([
    network("24:0B:88:FB:9E:69", { ssid: "RouterWiFi" }),
    network("26:0B:88:CB:9E:69", { ssid: "RouterWiFi", channel: 11 }),
  ], 1));

  assert.equal(state.alerts.length, 0);
});

test("keeps reporting a same-router BSSID on the trusted SSID at lower risk", () => {
  const state = makeState(trustedBaseline());
  processScanDetections(state, scan([
    network(trustedBssid),
    network("AA:BB:CC:11:22:34"),
  ], 1));

  const duplicate = state.alerts.find((alert) => alert.type === "SUSPICIOUS_DUPLICATE_AP");
  assert.ok(duplicate);
  assert.equal(duplicate.evidence.sameRouterAddressRange, true);
  assert.equal(duplicate.severity, "Low");
});

test("ranks Enhanced Open (OWE) above open networks and below WPA2", () => {
  assert.ok(securityStrength("OWE") > securityStrength("Open"));
  assert.ok(securityStrength("OWE") < securityStrength("WPA2"));
});
