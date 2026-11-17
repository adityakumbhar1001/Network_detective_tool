import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isKnownCampusSsid, processScanDetections, sameRouterBssids } from "./detector.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NETWORKS = 200;
const STALE_AFTER_MS = 30_000;
const RECENT_NETWORK_WINDOW_MS = 60_000;
const HISTORY_LIMIT = 100;
const DISCOVERY_REQUEST = "WIFISHIELD_DISCOVER";
const DISCOVERY_REPLY = "WIFISHIELD_API";
const DEFAULT_STATE_PATH = resolve(process.cwd(), ".wifi-shield-state.json");

function sendJson(response, statusCode, body) {
  const serializedBody = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Device-Token, X-WifiShield-Cycle",
  };
  if (statusCode !== 204) {
    headers["Content-Length"] = Buffer.byteLength(serializedBody);
  }
  response.writeHead(statusCode, headers);
  response.end(serializedBody);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;

  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Request body is too large."), {
        statusCode: 413,
      });
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), {
      statusCode: 400,
    });
  }
}

function normalizeSecurity(value) {
  const security = String(value ?? "").trim().toUpperCase().replaceAll("_", " ");

  if (!security || security === "UNKNOWN" || security === "WIFI AUTH MAX") {
    return "Unknown";
  }
  if (security.includes("OWE") || security.includes("ENHANCED OPEN")) return "OWE";
  if (security.includes("OPEN")) return "Open";
  if (security.includes("WEP")) return "WEP";
  if (security.includes("WPA2") && security.includes("WPA3")) return "WPA2/WPA3";
  if (security.includes("WPA3")) return "WPA3";
  if (security.includes("WPA/WPA2")) return "WPA/WPA2";
  if (security.includes("WPA2")) return "WPA2";
  if (security.includes("WPA")) return "WPA";
  return "Unknown";
}

// Cipher names as reported by the ESP32 (e.g. "CCMP", "TKIP/CCMP"); null when not reported.
function normalizeCipher(value) {
  if (value == null) return null;
  const cipher = String(value).trim().toUpperCase().slice(0, 16);
  return cipher || null;
}

// The cipher decides mixed modes: WPA/WPA2 with AES (CCMP) only is as strong as WPA2,
// while any mode that still allows TKIP is weak. Without cipher data (older firmware),
// WPA/WPA2 stays "weak" because TKIP cannot be ruled out.
function getSecurityStatus(security, { cipherKnown = false, usesTkip = false } = {}) {
  if (security === "Open") return "insecure";
  if (security === "WEP" || security === "WPA") return "weak";
  if (security === "WPA/WPA2") return cipherKnown && !usesTkip ? "encrypted" : "weak";
  if (security === "WPA2") return usesTkip ? "weak" : "encrypted";
  if (security === "WPA3" || security === "WPA2/WPA3" || security === "OWE") return "encrypted";
  return "unknown";
}

function weakSecurityFinding(network) {
  if (network.security === "WEP") {
    return { message: "WEP encryption is broken and can be cracked within minutes.", anomalyScore: 85 };
  }
  if (network.security === "WPA") {
    return { message: "WPA (version 1) is deprecated; use WPA2 with AES or WPA3.", anomalyScore: 75 };
  }
  if (network.usesTkip) {
    return {
      message: `${network.security} still allows the deprecated TKIP cipher; use AES (CCMP) only.`,
      anomalyScore: 65,
    };
  }
  return {
    message: "WPA/WPA2 mixed mode may still allow legacy WPA/TKIP (cipher not reported).",
    anomalyScore: 55,
  };
}

function loadPersistentState(persistencePath, trustedNetwork) {
  if (persistencePath && existsSync(persistencePath)) {
    try {
      const stored = JSON.parse(readFileSync(persistencePath, "utf8"));
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        return {
          trustedNetwork: stored.trustedNetwork ?? trustedNetwork,
          alerts: Array.isArray(stored.alerts) ? stored.alerts : [],
          currentConditions: Array.isArray(stored.currentConditions) ? stored.currentConditions : [],
          rssiHistory: stored.rssiHistory && typeof stored.rssiHistory === "object" ? stored.rssiHistory : {},
          rssiCandidates: stored.rssiCandidates && typeof stored.rssiCandidates === "object" ? stored.rssiCandidates : {},
        };
      }
    } catch {
      console.warn("WiFiShield state file could not be read; starting with fresh detection state.");
    }
  }

  return {
    trustedNetwork,
    alerts: [],
    currentConditions: [],
    rssiHistory: {},
    rssiCandidates: {},
  };
}

function persistState(state, persistencePath) {
  if (!persistencePath) return;
  mkdirSync(dirname(persistencePath), { recursive: true });
  const temporaryPath = `${persistencePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, JSON.stringify({
    trustedNetwork: state.trustedNetwork,
    alerts: state.alerts,
    currentConditions: state.currentConditions,
    rssiHistory: state.rssiHistory,
    rssiCandidates: state.rssiCandidates,
  }), "utf8");
  renameSync(temporaryPath, persistencePath);
}

function validateScan(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("Expected a JSON scan object."), { statusCode: 400 });
  }

  const deviceId = String(body.deviceId ?? "esp32").trim();
  if (!deviceId || deviceId.length > 64) {
    throw Object.assign(new Error("deviceId must be 1-64 characters."), { statusCode: 400 });
  }
  if (!Array.isArray(body.networks) || body.networks.length > MAX_NETWORKS) {
    throw Object.assign(new Error(`networks must be an array of at most ${MAX_NETWORKS} items.`), {
      statusCode: 400,
    });
  }

  const scannedAt = body.scannedAt == null ? new Date().toISOString() : String(body.scannedAt);
  if (!Number.isFinite(Date.parse(scannedAt))) {
    throw Object.assign(new Error("scannedAt must be a valid date string."), { statusCode: 400 });
  }

  const seenBssids = new Set();
  const networks = body.networks.map((network, index) => {
    if (!network || typeof network !== "object" || Array.isArray(network)) {
      throw Object.assign(new Error(`networks[${index}] must be an object.`), { statusCode: 400 });
    }

    const bssid = String(network.bssid ?? "").trim().toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bssid)) {
      throw Object.assign(new Error(`networks[${index}].bssid must be a MAC address.`), {
        statusCode: 400,
      });
    }
    if (seenBssids.has(bssid)) {
      throw Object.assign(new Error(`Duplicate BSSID in scan: ${bssid}.`), { statusCode: 400 });
    }
    seenBssids.add(bssid);

    const ssid = String(network.ssid ?? "");
    const rssi = Number(network.rssi);
    const channel = Number(network.channel);
    if (ssid.length > 32) {
      throw Object.assign(new Error(`networks[${index}].ssid must be at most 32 characters.`), {
        statusCode: 400,
      });
    }
    if (!Number.isInteger(rssi) || rssi < -127 || rssi > 0) {
      throw Object.assign(new Error(`networks[${index}].rssi must be an integer from -127 to 0.`), {
        statusCode: 400,
      });
    }
    if (!Number.isInteger(channel) || channel < 1 || channel > 196) {
      throw Object.assign(new Error(`networks[${index}].channel must be from 1 to 196.`), {
        statusCode: 400,
      });
    }

    const security = normalizeSecurity(network.security ?? network.authType);
    const pairwiseCipher = normalizeCipher(network.pairwiseCipher);
    const groupCipher = normalizeCipher(network.groupCipher);
    const cipherKnown = pairwiseCipher !== null && pairwiseCipher !== "UNKNOWN";
    const usesTkip = [pairwiseCipher, groupCipher].some((cipher) => cipher?.includes("TKIP"));
    return {
      ssid,
      bssid,
      rssi,
      channel,
      security,
      pairwiseCipher,
      groupCipher,
      usesTkip,
      securityStatus: getSecurityStatus(security, { cipherKnown, usesTkip }),
      trusted: false,
      lastSeen: scannedAt,
    };
  });

  return { deviceId, scannedAt, networks };
}

// Detector findings present in the latest scan. state.alerts keeps every finding ever
// raised (persisted across restarts); only conditions still observed in the most recent
// scan are reported, so stale findings disappear after the next scan (e.g. ESP32 reset).
function latestAlerts(state) {
  const current = new Set(state.currentConditions ?? []);
  return state.alerts.filter((alert) => current.has(alert.conditionKey));
}

// Networks heard in recent scans from the current device. Weak, distant APs are often
// missed by a single 3-second scan; keeping them for RECENT_NETWORK_WINDOW_MS (with
// seenInLatestScan=false) stops the list flickering. Detection still uses only the
// latest scan.
function updateRecentNetworks(state, scan, receivedAt) {
  if (!state.recentNetworks || state.recentDeviceId !== scan.deviceId) {
    state.recentNetworks = new Map();
    state.recentDeviceId = scan.deviceId;
  }
  for (const network of scan.networks) {
    state.recentNetworks.set(network.bssid, { ...network, lastSeenAt: receivedAt });
  }
  const now = Date.parse(receivedAt);
  for (const [bssid, network] of state.recentNetworks) {
    if (now - Date.parse(network.lastSeenAt) > RECENT_NETWORK_WINDOW_MS) {
      state.recentNetworks.delete(bssid);
    }
  }
}

function makeSnapshot(state) {
  const trustedBssid = state.trustedNetwork?.bssid ?? state.trustedBssid;
  const latestReceivedAt = state.latestScan?.receivedAt;
  const source = state.recentNetworks
    ? [...state.recentNetworks.values()]
    : (state.latestScan?.networks ?? []).map((network) => ({ ...network, lastSeenAt: latestReceivedAt }));
  const networks = source
    .map((network) => ({
      ...network,
      seenInLatestScan: network.lastSeenAt === latestReceivedAt,
      trusted: Boolean(trustedBssid && network.bssid === trustedBssid),
    }))
    .sort((left, right) => right.rssi - left.rssi);
  const trustedAP = networks.find((network) => network.trusted) ?? null;

  // Access points flagged by the campus vendor-prefix check show as suspicious.
  const vendorMismatch = new Set(
    latestAlerts(state)
      .filter((alert) => alert.type === "CAMPUS_VENDOR_MISMATCH" && alert.status !== "Resolved")
      .map((alert) => alert.observedBssid),
  );
  for (const network of networks) {
    if (vendorMismatch.has(network.bssid)) network.suspicious = true;
  }

  // An open network with a known campus name is almost certainly a sign-in portal
  // (the scan cannot see the login page), so label it "portal" instead of plain "open".
  for (const network of networks) {
    if (network.securityStatus === "insecure" && isKnownCampusSsid(network.ssid)) {
      network.securityStatus = "portal";
    }
  }

  if (state.trustedNetwork?.ssid || trustedAP) {
    const trustedSsid = state.trustedNetwork?.ssid || trustedAP?.ssid;
    for (const network of networks) {
      network.suspicious = network.suspicious || Boolean(
        network.ssid &&
        network.ssid === trustedSsid &&
        network.bssid !== trustedBssid &&
        !(trustedBssid && sameRouterBssids(network.bssid, trustedBssid)),
      );
    }
  }

  const alerts = [];

  // Informational notices that repeat for every access point of one network (campus portal,
  // WPA3 transition mode) are combined into a single alert per SSID with an AP count. The
  // strongest access point (networks are sorted by signal) is the one shown.
  const addGroupedAlert = (alert) => {
    const existing = alerts.find(
      (other) =>
        other.type === alert.type &&
        other.apCount &&
        String(other.ssid).trim().toLowerCase() === String(alert.ssid).trim().toLowerCase(),
    );
    if (existing) {
      existing.apCount += 1;
      existing.message = `${alert.message} (${existing.apCount} access points)`;
    } else {
      alerts.push({ ...alert, apCount: 1 });
    }
  };

  for (const network of networks) {
    if (network.securityStatus === "insecure") {
      alerts.push({
        type: "OPEN_NETWORK",
        message: "Open network has no Wi-Fi encryption.",
        ssid: network.ssid,
        bssid: network.bssid,
        anomalyScore: 90,
        severity: "High",
      });
    } else if (network.security === "WPA2/WPA3") {
      addGroupedAlert({
        type: "WPA3_TRANSITION_MODE",
        message: "WPA2/WPA3 transition mode: a client can be pushed down to WPA2, so WPA3's extra protection is not guaranteed.",
        ssid: network.ssid,
        bssid: network.bssid,
        anomalyScore: 15,
        severity: "Low",
      });
    } else if (network.securityStatus === "portal") {
      addGroupedAlert({
        type: "PORTAL_NETWORK",
        message: "Open campus Wi-Fi with a browser sign-in: the radio link is unencrypted, so use HTTPS only.",
        ssid: network.ssid,
        bssid: network.bssid,
        anomalyScore: 30,
        severity: "Low",
      });
    } else if (network.securityStatus === "weak") {
      const finding = weakSecurityFinding(network);
      alerts.push({
        type: "WEAK_ENCRYPTION",
        message: finding.message,
        ssid: network.ssid,
        bssid: network.bssid,
        anomalyScore: finding.anomalyScore,
        severity: finding.anomalyScore >= 65 ? "High" : "Medium",
      });
    } else if (network.securityStatus === "unknown") {
      alerts.push({
        type: "UNKNOWN_SECURITY",
        message: "The scan did not report a recognized security type.",
        ssid: network.ssid,
        bssid: network.bssid,
        anomalyScore: 45,
        severity: "Medium",
      });
    }

    if (network.suspicious) {
      alerts.push({
        type: "DUPLICATE_SSID",
        message: "Another access point uses the trusted SSID; this can be a legitimate mesh node, repeater, or dual-band router.",
        ssid: network.ssid,
        bssid: network.bssid,
        anomalyScore: 55,
        severity: "Medium",
      });
    }
  }

  const channelCounts = new Map();
  for (const network of networks) {
    channelCounts.set(network.channel, (channelCounts.get(network.channel) ?? 0) + 1);
  }

  const receivedAt = state.latestScan?.receivedAt ?? null;
  const ageMs = receivedAt ? Date.now() - Date.parse(receivedAt) : Infinity;

  return {
    status: !receivedAt ? "waiting" : ageMs <= STALE_AFTER_MS ? "live" : "stale",
    deviceId: state.latestScan?.deviceId ?? null,
    scannedAt: state.latestScan?.scannedAt ?? null,
    receivedAt,
    networks,
    alerts,
    securityAlerts: latestAlerts(state),
    health: computeHealth(networks, latestAlerts(state)),
    channelAdvice: computeChannelAdvice(networks),
    trustedNetwork: state.trustedNetwork,
    trustedAP,
    channels: [...channelCounts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([channel, count]) => ({ channel, networks: count })),
    heatmap: networks.length ? [networks.map((network) => network.rssi)] : [],
    history: state.history,
  };
}

// 0-100 summary of the surroundings from networks heard in the latest scan and the active
// detector findings. Heuristic: it ranks environments, it does not measure risk precisely.
function computeHealth(networks, securityAlerts) {
  const current = networks.filter((network) => network.seenInLatestScan !== false);
  if (!current.length) return { score: null, label: "No data" };
  const count = (status) => current.filter((network) => network.securityStatus === status).length;
  const severityWeight = { Critical: 20, High: 12, Medium: 5, Low: 1 };
  const findingPenalty = Math.min(
    45,
    securityAlerts
      .filter((alert) => alert.status !== "Resolved")
      .reduce((total, alert) => total + (severityWeight[alert.severity] ?? 0), 0),
  );
  const penalty = Math.min(36, count("insecure") * 6) + Math.min(18, count("weak") * 3) +
    Math.min(5, count("portal")) + findingPenalty;
  const score = Math.max(0, 100 - penalty);
  return { score, label: score >= 80 ? "Good" : score >= 60 ? "Fair" : "Poor" };
}

// Least crowded of the non-overlapping 2.4 GHz channels (1, 6, 11). Channels closer than
// 5 apart overlap; stronger signals count more.
function computeChannelAdvice(networks) {
  const current = networks.filter(
    (network) => network.seenInLatestScan !== false && network.channel >= 1 && network.channel <= 14,
  );
  if (!current.length) return { recommended: null, congestion: [] };
  const congestion = [1, 6, 11].map((channel) => {
    const load = current.reduce((total, network) => {
      const overlap = Math.max(0, 1 - Math.abs(network.channel - channel) / 5);
      const strength = Math.min(1, Math.max(0.1, (network.rssi + 95) / 55));
      return total + overlap * strength;
    }, 0);
    return { channel, load: Number(load.toFixed(1)) };
  });
  const recommended = [...congestion].sort((left, right) => left.load - right.load || left.channel - right.channel)[0].channel;
  return { recommended, congestion };
}

// The small display lists one card per network name: access points sharing a name (and the
// same security) collapse into the strongest one with apCount. Trusted, suspicious and
// hidden entries stay separate so nothing important is hidden. Input is sorted by RSSI.
function groupForDisplay(networks) {
  const groups = new Map();
  const result = [];
  for (const network of networks) {
    if (!network.ssid || network.trusted || network.suspicious) {
      result.push({ ...network, apCount: 1 });
      continue;
    }
    const key = `${network.ssid.trim().toLowerCase()}|${network.securityStatus}`;
    const existing = groups.get(key);
    if (existing) {
      existing.apCount += 1;
      existing.seenInLatestScan ||= network.seenInLatestScan;
    } else {
      const entry = { ...network, apCount: 1 };
      groups.set(key, entry);
      result.push(entry);
    }
  }
  return result;
}

function makeDisplaySnapshot(state) {
  const snapshot = makeSnapshot(state);
  const alertFields = [
    "id",
    "timestamp",
    "type",
    "ssid",
    "observedBssid",
    "trustedBssid",
    "severity",
    "riskScore",
    "explanation",
    "message",
    "status",
    "evidence",
  ];
  return {
    status: snapshot.status,
    deviceId: snapshot.deviceId,
    scannedAt: snapshot.scannedAt,
    receivedAt: snapshot.receivedAt,
    healthScore: snapshot.health.score ?? -1,
    healthLabel: snapshot.health.label,
    bestChannel: snapshot.channelAdvice.recommended ?? 0,
    networks: groupForDisplay(snapshot.networks).map((network) => ({
      ssid: network.ssid,
      bssid: network.bssid,
      rssi: network.rssi,
      channel: network.channel,
      security: network.security,
      securityStatus: network.securityStatus,
      trusted: network.trusted,
      suspicious: network.suspicious,
      seenInLatestScan: network.seenInLatestScan,
      apCount: network.apCount ?? 1,
    })),
    securityAlerts: snapshot.securityAlerts
      .filter((alert) => alert.status !== "Resolved")
      .map((alert) => Object.fromEntries(
        alertFields
          .filter((field) => field in alert)
          .map((field) => [field, alert[field]]),
      )),
  };
}

function makeDisplayAlerts(state) {
  const alertFields = [
    "id",
    "timestamp",
    "type",
    "ssid",
    "observedBssid",
    "trustedBssid",
    "severity",
    "riskScore",
    "explanation",
    "message",
    "status",
    "evidence",
  ];
  const alerts = latestAlerts(state)
    .filter((alert) => alert.status !== "Resolved")
    .map((alert) => Object.fromEntries(
      alertFields
        .filter((field) => field in alert)
        .map((field) => [field, alert[field]]),
    ));
  return {
    alerts,
    activeCount: alerts.length,
    highPriorityCount: alerts.filter(
      (alert) => alert.severity === "High" || alert.severity === "Critical",
    ).length,
  };
}

export function createWifiServer({
  deviceToken = "",
  trustedBssid = "",
  trustedSsid = "",
  trustedSecurity = "",
  persistencePath = DEFAULT_STATE_PATH,
  rssiThresholdDb = 20,
} = {}) {
  const normalizedTrustedBssid = trustedBssid.trim().toUpperCase();
  const trustedNetwork = normalizedTrustedBssid ? {
    bssid: normalizedTrustedBssid,
    ssid: trustedSsid.trim(),
    expectedSecurity: trustedSecurity ? normalizeSecurity(trustedSecurity) : "",
    baselineRssi: null,
    baselineChannel: null,
  } : null;
  const state = {
    latestScan: null,
    history: [],
    trustedBssid: normalizedTrustedBssid,
    ...loadPersistentState(persistencePath, trustedNetwork),
  };
  const safeRssiThresholdDb = Number.isFinite(rssiThresholdDb) && rssiThresholdDb > 0
    ? rssiThresholdDb
    : 20;

  return createServer(async (request, response) => {
    const requestStartedAt = Date.now();
    const path = new URL(request.url, "http://localhost").pathname;
    const cycleHeader = request.headers["x-wifishield-cycle"];
    const cycleId = typeof cycleHeader === "string" && /^\d{1,10}$/.test(cycleHeader)
      ? cycleHeader
      : "-";
    const timestamp = new Date(requestStartedAt).toISOString();
    console.info(`[${timestamp}][CYCLE ${cycleId}][HTTP] incoming ${request.method} ${path}`);
    let completionLogged = false;
    const logCompletion = (event) => {
      if (completionLogged) return;
      completionLogged = true;
      console.info(
        `[${new Date().toISOString()}][CYCLE ${cycleId}][HTTP] ${event} ` +
        `${request.method} ${path} status=${response.statusCode} duration=${Date.now() - requestStartedAt}ms`,
      );
    };
    response.once("finish", () => logCompletion("response"));
    response.once("close", () => logCompletion("connection-closed"));

    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    try {
      if (request.method === "GET" && path === "/api/health") {
        const snapshot = makeSnapshot(state);
        sendJson(response, 200, {
          ok: true,
          status: snapshot.status,
          deviceId: snapshot.deviceId,
          scannedAt: snapshot.scannedAt,
        });
        return;
      }

      if (request.method === "GET" && path === "/api/snapshot") {
        const url = new URL(request.url, "http://localhost");
        sendJson(response, 200, url.searchParams.get("display") === "1"
          ? makeDisplaySnapshot(state)
          : makeSnapshot(state));
        return;
      }

      if (request.method === "GET" && path === "/api/history") {
        sendJson(response, 200, { history: state.history });
        return;
      }

      if (request.method === "GET" && path === "/api/alerts") {
        const url = new URL(request.url, "http://localhost");
        if (url.searchParams.get("display") === "1") {
          sendJson(response, 200, makeDisplayAlerts(state));
          return;
        }
        const alerts = latestAlerts(state);
        const activeAlerts = alerts.filter((alert) => alert.status !== "Resolved");
        sendJson(response, 200, {
          alerts,
          activeCount: activeAlerts.length,
          highPriorityCount: activeAlerts.filter((alert) => alert.severity === "High" || alert.severity === "Critical").length,
        });
        return;
      }

      if (request.method === "GET" && path === "/api/trusted-network") {
        sendJson(response, 200, { trustedNetwork: state.trustedNetwork });
        return;
      }

      if (request.method === "POST" && path === "/api/scans") {
        if (deviceToken && request.headers["x-device-token"] !== deviceToken) {
          sendJson(response, 401, { error: "Invalid or missing device token." });
          return;
        }

        const scan = validateScan(await readJson(request));
        const receivedAt = new Date().toISOString();
        state.latestScan = { ...scan, receivedAt };
        updateRecentNetworks(state, scan, receivedAt);
        console.info(
          `[${receivedAt}][CYCLE ${cycleId}][SCAN] latest scan updated ` +
          `deviceId=${scan.deviceId} scannedAt=${scan.scannedAt} receivedAt=${receivedAt} ` +
          `networks=${scan.networks.length}`,
        );
        processScanDetections(state, scan, safeRssiThresholdDb);
        persistState(state, persistencePath);
        const snapshot = makeSnapshot(state);
        state.history.unshift({
          id: `${scan.deviceId}-${receivedAt}`,
          scannedAt: scan.scannedAt,
          deviceId: scan.deviceId,
          networks: scan.networks.length,
          alerts: snapshot.alerts.length,
          status: "Completed",
        });
        state.history.length = Math.min(state.history.length, HISTORY_LIMIT);

        sendJson(response, 201, {
          accepted: true,
          deviceId: scan.deviceId,
          scannedAt: scan.scannedAt,
          networks: scan.networks.length,
          alerts: snapshot.alerts.length,
        });
        return;
      }

      if (request.method === "PUT" && path === "/api/trusted-network") {
        const body = await readJson(request);
        const bssid = String(body?.bssid ?? "").trim().toUpperCase();
        if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bssid)) {
          sendJson(response, 400, { error: "bssid must be a MAC address." });
          return;
        }
        state.trustedBssid = bssid;
        const observed = state.latestScan?.networks.find((network) => network.bssid === bssid);
        const ssid = String(body.ssid ?? observed?.ssid ?? state.trustedNetwork?.ssid ?? "");
        const securityValue = body.expectedSecurity ?? body.security ?? observed?.security ?? state.trustedNetwork?.expectedSecurity ?? "";
        const expectedSecurity = securityValue ? normalizeSecurity(securityValue) : "";
        if (ssid.length > 32) {
          sendJson(response, 400, { error: "ssid must be at most 32 characters." });
          return;
        }
        if (body.expectedSecurity && expectedSecurity === "Unknown" &&
          String(body.expectedSecurity).trim().toLowerCase() !== "unknown") {
          sendJson(response, 400, { error: "expectedSecurity must be a recognized Wi-Fi security mode." });
          return;
        }
        state.trustedNetwork = {
          bssid,
          ssid,
          expectedSecurity,
          baselineRssi: observed?.rssi ?? (state.trustedNetwork?.bssid === bssid ? state.trustedNetwork.baselineRssi : null),
          baselineChannel: observed?.channel ?? (state.trustedNetwork?.bssid === bssid ? state.trustedNetwork.baselineChannel : null),
        };
        persistState(state, persistencePath);
        sendJson(response, 200, { trustedBssid: bssid, trustedNetwork: state.trustedNetwork, snapshot: makeSnapshot(state) });
        return;
      }

      const alertMatch = path.match(/^\/api\/alerts\/([^/]+)$/);
      if (request.method === "PUT" && alertMatch) {
        const alert = state.alerts.find((item) => item.id === decodeURIComponent(alertMatch[1]));
        if (!alert) {
          sendJson(response, 404, { error: "Alert not found." });
          return;
        }
        const body = await readJson(request);
        if (!["Acknowledged", "Resolved"].includes(body?.status)) {
          sendJson(response, 400, { error: "status must be Acknowledged or Resolved." });
          return;
        }
        alert.status = body.status;
        alert.updatedAt = new Date().toISOString();
        persistState(state, persistencePath);
        sendJson(response, 200, { alert });
        return;
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message });
    }
  });
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const port = Number(process.env.PORT ?? 3001);
  const server = createWifiServer({
    deviceToken: process.env.DEVICE_TOKEN ?? "",
    trustedBssid: process.env.TRUSTED_BSSID ?? "",
    trustedSsid: process.env.TRUSTED_SSID ?? "",
    trustedSecurity: process.env.TRUSTED_SECURITY ?? "",
    persistencePath: process.env.WIFISHIELD_STATE_FILE ?? DEFAULT_STATE_PATH,
    rssiThresholdDb: Number(process.env.RSSI_ANOMALY_THRESHOLD_DB ?? 20),
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`WiFiShield API listening on http://0.0.0.0:${port}`);
  });

  // LAN discovery: the ESP32 broadcasts DISCOVERY_REQUEST on this UDP port and uses the
  // sender address of the reply as its API host, so the firmware needs no PC IP.
  const discoveryPort = Number(process.env.DISCOVERY_PORT ?? port);
  const discovery = createSocket({ type: "udp4", reuseAddr: true });
  discovery.on("message", (message, remote) => {
    if (message.toString().trim() !== DISCOVERY_REQUEST) return;
    discovery.send(`${DISCOVERY_REPLY} ${port}`, remote.port, remote.address);
    console.log(`[DISCOVERY] answered ${remote.address}:${remote.port} with API port ${port}`);
  });
  discovery.on("error", (error) => {
    console.error(`[DISCOVERY] UDP ${discoveryPort} unavailable: ${error.message}`);
    discovery.close();
  });
  discovery.bind(discoveryPort, "0.0.0.0", () => {
    console.log(`WiFiShield discovery listening on udp://0.0.0.0:${discoveryPort}`);
  });
}