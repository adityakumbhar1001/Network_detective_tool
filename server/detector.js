import process from "node:process";
import { randomUUID } from "node:crypto";

const SECURITY_STRENGTH = {
  Open: 0,
  WEP: 1,
  WPA: 2,
  "WPA/WPA2": 2,
  // Enhanced Open encrypts traffic but does not authenticate the AP: stronger than
  // Open/WEP, weaker than WPA2 against an impersonating access point.
  OWE: 2,
  WPA2: 3,
  "WPA2/WPA3": 3,
  WPA3: 4,
  Unknown: null,
};

// Campus networks: many access points share one SSID, and "open" ones put users behind a
// browser sign-in page (captive portal), which a scan cannot see. Names are matched
// case-insensitively. Add more with WIFISHIELD_CAMPUS_SSIDS="name1,name2".
const CAMPUS_SSIDS = new Set(
  ["VIT_Student", "VIT_Staff", "VIT_TPO",
    ...(process.env.WIFISHIELD_CAMPUS_SSIDS ?? "").split(",")]
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
);

export function isKnownCampusSsid(ssid) {
  return CAMPUS_SSIDS.has(String(ssid ?? "").trim().toLowerCase());
}

// Vendor prefix = first three bytes of the BSSID, ignoring the locally-administered bit
// (virtual SSIDs of one AP differ only there). WIFISHIELD_CAMPUS_OUIS="AA:BB:CC,..." lists
// adds more campus prefixes and makes the check strict. Built-in VIT prefixes, and the
// prefixes shared by at least two access points of a campus SSID, are always normal; other
// prefixes are reported only if their security setting also differs (or always, if strict).
export function vendorPrefix(bssid) {
  const bytes = String(bssid ?? "").split(":").map((part) => Number.parseInt(part, 16));
  if (bytes.length < 3 || bytes.slice(0, 3).some(Number.isNaN)) return null;
  return [bytes[0] & ~0x02, bytes[1], bytes[2]]
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(":");
}

function parsePrefixes(list) {
  return list.map((prefix) => vendorPrefix(`${prefix.trim()}:00:00:00`)).filter(Boolean);
}

// Prefixes measured from the VIT campus access points (three vendors, seen on every
// VIT_* SSID). They are always treated as normal.
const BUILT_IN_CAMPUS_OUIS = parsePrefixes(["E0:5D:54", "10:5F:02", "98:4A:6B"]);
const EXTRA_CAMPUS_OUIS = parsePrefixes((process.env.WIFISHIELD_CAMPUS_OUIS ?? "").split(","));
const CAMPUS_OUIS = new Set([...BUILT_IN_CAMPUS_OUIS, ...EXTRA_CAMPUS_OUIS]);
// With the env list set the check is strict: any other prefix is reported. Without it an
// unknown prefix is reported only when its security setting also differs.
const STRICT_OUI_CHECK = EXTRA_CAMPUS_OUIS.length > 0;

function campusVendorFindings(networks, addFinding, findings) {
  const groups = new Map();
  for (const network of networks) {
    if (!network.ssid || !isKnownCampusSsid(network.ssid)) continue;
    const key = network.ssid.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), network]);
  }
  for (const group of groups.values()) {
    const allowed = new Set(CAMPUS_OUIS);
    if (!STRICT_OUI_CHECK) {
      // Needs at least three access points to tell the usual hardware from an outlier.
      if (group.length < 3) continue;
      const counts = new Map();
      for (const network of group) {
        const prefix = vendorPrefix(network.bssid);
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
      for (const [prefix, count] of counts) {
        if (count >= 2) allowed.add(prefix);
      }
    }
    const securityCounts = new Map();
    for (const network of group) {
      securityCounts.set(network.security, (securityCounts.get(network.security) ?? 0) + 1);
    }
    const usualSecurity = [...securityCounts].sort((left, right) => right[1] - left[1])[0][0];
    for (const network of group) {
      const prefix = vendorPrefix(network.bssid);
      if (!prefix || allowed.has(prefix)) continue;
      const securityDiffers = network.security !== usualSecurity;
      // A real campus mixes many AP models, so without a known-prefix list a different
      // vendor alone proves nothing; only report it when the security setting differs too.
      if (!STRICT_OUI_CHECK && !securityDiffers) continue;
      const riskScore = boundedScore(60 + (securityDiffers ? 15 : 0));
      addFinding(findings, {
        type: "CAMPUS_VENDOR_MISMATCH",
        ssid: network.ssid,
        observedBssid: network.bssid,
        trustedBssid: null,
        severity: severityFor(riskScore),
        riskScore,
        explanation: `This access point advertises the campus network name but its hardware vendor prefix (${prefix}) differs from the other ${network.ssid} access points. It may be a personal hotspot or a rogue access point; a different model of campus AP is also possible.`,
        evidence: {
          observedSecurity: network.security,
          expectedSecurity: usualSecurity,
          securityDiffers,
          vendorPrefix: prefix,
          rssi: network.rssi,
          channel: network.channel,
        },
      });
    }
  }
}

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

// True when two BSSIDs very likely belong to the same physical router (extra radios or
// virtual APs): same vendor prefix ignoring the locally-administered bit (0x02), and at
// most one of the last three bytes different, e.g. 24:0B:88:FB:9E:69 / 26:0B:88:CB:9E:69.
export function sameRouterBssids(left, right) {
  const a = left.split(":").map((part) => Number.parseInt(part, 16));
  const b = right.split(":").map((part) => Number.parseInt(part, 16));
  if (a.length !== 6 || b.length !== 6) return false;
  if ((a[0] & ~0x02) !== (b[0] & ~0x02) || a[1] !== b[1] || a[2] !== b[2]) return false;
  let differingBytes = 0;
  for (let index = 3; index < 6; index++) {
    if (a[index] !== b[index]) differingBytes++;
  }
  return differingBytes <= 1;
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
    // Known campus SSIDs legitimately have many access points: no duplicate warning.
    if (!isTrustedSsid && isKnownCampusSsid(ssid)) continue;
    // Untrusted SSIDs: radios of the same router are one network, not a duplicate.
    const candidates = isTrustedSsid
      ? group.filter((network) => network.bssid !== trusted.bssid)
      : group.slice(1).filter((network) => !sameRouterBssids(network.bssid, group[0].bssid));

    for (const network of candidates) {
      duplicateBssids.add(network.bssid);
      // Trusted SSID: still reported (a MAC can be imitated), but a BSSID from the trusted
      // router's own address block is far more likely its second radio than an evil twin.
      const sameRouter = isTrustedSsid && sameRouterBssids(network.bssid, trusted.bssid);
      const referenceSecurity = isTrustedSsid ? trusted.expectedSecurity : null;
      const securityDiffers = Boolean(referenceSecurity && network.security !== referenceSecurity);
      const signal = rssiChanges.get(network.bssid);
      const referenceRssi = isTrustedSsid ? trusted.baselineRssi : null;
      const signalDeviation = Number.isFinite(referenceRssi) ? network.rssi - referenceRssi : null;
      const riskScore = boundedScore(
        (isTrustedSsid ? (sameRouter ? 20 : 45) : 30) +
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
        explanation: sameRouter
          ? "Another BSSID from the trusted router's own address range advertises the trusted SSID; most likely its second radio or a virtual AP."
          : isTrustedSsid
            ? "An untrusted access point is advertising the trusted SSID. This can also occur with mesh systems, repeaters, or dual-band routers."
            : "Multiple access points advertise this SSID. This is a warning only; mesh systems, repeaters, and dual-band routers commonly do this.",
        evidence: {
          sameRouterAddressRange: sameRouter,
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

  campusVendorFindings(networks, addFinding, findings);

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