import { randomUUID } from "node:crypto";

const SECURITY_STRENGTH = {
  Open: 0,
  WEP: 1,
  WPA: 2,
  "WPA/WPA2": 2,
  WPA2: 3,
  "WPA2/WPA3": 3,
  WPA3: 4,
  Unknown: null,
};

export function securityStrength(security) {
  return SECURITY_STRENGTH[security] ?? null;
}

function severityFor(riskScore) {
  if (riskScore >= 85) return "Critical";
  if (riskScore >= 65) return "High";
  if (riskScore >= 40) return "Medium";
  return "Low";
}

function boundedScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function conditionKey(type, ssid, bssid) {
  return `${type}:${ssid}:${bssid}`;
}

function addFinding(findings, finding) {
  findings.push({
    ...finding,
    conditionKey: conditionKey(finding.type, finding.ssid, finding.observedBssid),
  });
}

function updateRssiHistory(state, networks, thresholdDb) {
  state.rssiHistory ??= {};
  state.rssiCandidates ??= {};
  const deviations = new Map();

  for (const network of networks) {
    const history = state.rssiHistory[network.bssid] ?? {
      observations: [],
      baselineObservations: [],
      baselineMean: network.rssi,
    };
    history.observations = Array.isArray(history.observations) ? history.observations : [];
    history.baselineObservations = Array.isArray(history.baselineObservations)
      ? history.baselineObservations
      : history.observations.map((observation) => observation.rssi).filter(Number.isFinite).slice(-12);
    if (!Number.isFinite(history.baselineMean)) {
      history.baselineMean = history.baselineObservations.length
        ? history.baselineObservations.reduce((sum, rssi) => sum + rssi, 0) / history.baselineObservations.length
        : network.rssi;
    }
    const baselineReady = history.baselineObservations.length >= 3;
    const deviationDb = baselineReady ? network.rssi - history.baselineMean : 0;
    const anomalous = baselineReady && Math.abs(deviationDb) >= thresholdDb;

    if (anomalous) {
      state.rssiCandidates[network.bssid] = (state.rssiCandidates[network.bssid] ?? 0) + 1;
    } else {
      state.rssiCandidates[network.bssid] = 0;
      history.baselineObservations.push(network.rssi);
      history.baselineObservations = history.baselineObservations.slice(-12);
      history.baselineMean = history.baselineObservations.reduce((sum, rssi) => sum + rssi, 0) /
        history.baselineObservations.length;
    }

    history.observations.push({ rssi: network.rssi, scannedAt: network.lastSeen });
    history.observations = history.observations.slice(-12);
    state.rssiHistory[network.bssid] = history;
    deviations.set(network.bssid, {
      deviationDb,
      baselineMean: history.baselineMean,
      candidateCount: state.rssiCandidates[network.bssid],
      anomalous: state.rssiCandidates[network.bssid] >= 2,
    });
  }

  const knownBssids = Object.keys(state.rssiHistory);
  for (const bssid of knownBssids.slice(0, Math.max(0, knownBssids.length - 5000))) {
    delete state.rssiHistory[bssid];
    delete state.rssiCandidates[bssid];
  }
  return deviations;
}

function makeFindings(state, scan, thresholdDb) {
  const { networks } = scan;
  const trusted = state.trustedNetwork;
  const rssiChanges = updateRssiHistory(state, networks, thresholdDb);
  const findings = [];
  const networksBySsid = new Map();
  const networksByBssid = new Map(networks.map((network) => [network.bssid, network]));

  for (const network of networks) {
    if (!network.ssid) continue;
    const group = networksBySsid.get(network.ssid) ?? [];
    group.push(network);
    networksBySsid.set(network.ssid, group);
  }

  const trustedObservation = trusted ? networksByBssid.get(trusted.bssid) : null;
  if (trustedObservation && !trusted.ssid) {
    trusted.ssid = trustedObservation.ssid;
    if (!trusted.expectedSecurity) trusted.expectedSecurity = trustedObservation.security;
    trusted.baselineRssi ??= trustedObservation.rssi;
    trusted.baselineChannel ??= trustedObservation.channel;
  }
  if (trustedObservation && !Number.isFinite(trusted.baselineRssi)) {
    trusted.baselineRssi = trustedObservation.rssi;
    trusted.baselineChannel = trustedObservation.channel;
  }

  const duplicateBssids = new Set();
  const downgradeBssids = new Set();
  for (const [ssid, group] of networksBySsid) {
    const isTrustedSsid = Boolean(trusted?.ssid && ssid === trusted.ssid);
    if (group.length < 2 && !isTrustedSsid) continue;
    const candidates = isTrustedSsid
      ? group.filter((network) => network.bssid !== trusted.bssid)
      : group.slice(1);

    for (const network of candidates) {
      duplicateBssids.add(network.bssid);
      const referenceSecurity = isTrustedSsid ? trusted.expectedSecurity : null;
      const securityDiffers = Boolean(referenceSecurity && network.security !== referenceSecurity);
      const signal = rssiChanges.get(network.bssid);
      const referenceRssi = isTrustedSsid ? trusted.baselineRssi : null;
      const signalDeviation = Number.isFinite(referenceRssi) ? network.rssi - referenceRssi : null;
      const riskScore = boundedScore(
        (isTrustedSsid ? 45 : 30) +
        (securityDiffers ? 22 : 0) +
        (isTrustedSsid && trusted.baselineChannel !== network.channel ? 5 : 0) +
        (signalDeviation !== null && Math.abs(signalDeviation) >= thresholdDb ? 12 : 0) +
        (signal?.anomalous ? 12 : 0),
      );

      addFinding(findings, {
        type: isTrustedSsid ? "SUSPICIOUS_DUPLICATE_AP" : "DUPLICATE_SSID_WARNING",
        ssid,
        observedBssid: network.bssid,
        trustedBssid: isTrustedSsid ? trusted.bssid : null,
        severity: severityFor(riskScore),
        riskScore,
        explanation: isTrustedSsid
          ? "An untrusted access point is advertising the trusted SSID. This can also occur with mesh systems, repeaters, or dual-band routers."
          : "Multiple access points advertise this SSID. This is a warning only; mesh systems, repeaters, and dual-band routers commonly do this.",
        evidence: {
          observedSecurity: network.security,
          expectedSecurity: referenceSecurity,
          securityDiffers,
          rssi: network.rssi,
          trustedRssi: referenceRssi,
          rssiDeviationDb: signalDeviation,
          channel: network.channel,
          trustedChannel: isTrustedSsid ? trusted.baselineChannel : null,
        },
      });
    }
  }

  if (trusted?.ssid && trusted.expectedSecurity) {
    const expectedStrength = securityStrength(trusted.expectedSecurity);
    for (const network of networks) {
      if (network.ssid !== trusted.ssid || expectedStrength === null) continue;
      const observedStrength = securityStrength(network.security);
      if (observedStrength === null || observedStrength >= expectedStrength) continue;

      downgradeBssids.add(network.bssid);
      const isOpenPriority = network.security === "Open" && expectedStrength >= 3;
      const riskScore = boundedScore(
        65 + (isOpenPriority ? 27 : 0) + (duplicateBssids.has(network.bssid) ? 8 : 0) +
        (rssiChanges.get(network.bssid)?.anomalous ? 8 : 0),
      );
      addFinding(findings, {
        type: "SECURITY_DOWNGRADE",
        ssid: network.ssid,
        observedBssid: network.bssid,
        trustedBssid: trusted.bssid,
        severity: severityFor(riskScore),
        riskScore,
        explanation: network.security === "Open"
          ? `The trusted SSID is advertising an open network instead of its expected ${trusted.expectedSecurity} security.`
          : `The trusted SSID is advertising weaker ${network.security} security than the expected ${trusted.expectedSecurity}.`,
        evidence: {
          observedSecurity: network.security,
          expectedSecurity: trusted.expectedSecurity,
          rssi: network.rssi,
          channel: network.channel,
          duplicateSsid: duplicateBssids.has(network.bssid),
        },
      });
    }
  }

  for (const network of networks) {
    const signal = rssiChanges.get(network.bssid);
    if (!signal?.anomalous) continue;
    const duplicate = duplicateBssids.has(network.bssid);
    const downgrade = downgradeBssids.has(network.bssid);
    const riskScore = boundedScore(48 + (duplicate ? 12 : 0) + (downgrade ? 18 : 0));
    addFinding(findings, {
      type: "RSSI_ANOMALY",
      ssid: network.ssid,
      observedBssid: network.bssid,
      trustedBssid: trusted?.bssid ?? null,
      severity: severityFor(riskScore),
      riskScore,
      explanation: `Signal strength changed by ${Math.abs(signal.deviationDb).toFixed(1)} dB from its rolling baseline. RSSI changes alone do not establish an attack.`,
      evidence: {
        rssi: network.rssi,
        baselineRssi: Number(signal.baselineMean.toFixed(1)),
        rssiDeviationDb: Number(signal.deviationDb.toFixed(1)),
        thresholdDb,
        consecutiveOutliers: signal.candidateCount,
        duplicateSsid: duplicate,
        securityDowngrade: downgrade,
      },
    });
  }

  return findings;
}

export function processScanDetections(state, scan, thresholdDb = 20) {
  state.alerts ??= [];
  state.currentConditions ??= [];
  const previousConditions = new Set(state.currentConditions);
  const findings = makeFindings(state, scan, thresholdDb);
  const timestamp = scan.scannedAt;
  const currentConditions = new Set();

  for (const finding of findings) {
    currentConditions.add(finding.conditionKey);
    const activeAlert = state.alerts.find(
      (alert) => alert.conditionKey === finding.conditionKey && alert.status !== "Resolved",
    );

    if (activeAlert) {
      Object.assign(activeAlert, finding, { updatedAt: timestamp, lastSeen: timestamp });
      continue;
    }

    const resolvedAlert = state.alerts.find(
      (alert) => alert.conditionKey === finding.conditionKey && alert.status === "Resolved",
    );
    if (resolvedAlert && previousConditions.has(finding.conditionKey)) continue;

    state.alerts.unshift({
      id: randomUUID(),
      timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeen: timestamp,
      status: "New",
      ...finding,
    });
  }

  state.currentConditions = [...currentConditions];
  state.alerts = state.alerts.slice(0, 1000);
  return state.alerts;
}