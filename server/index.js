import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { processScanDetections } from "./detector.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NETWORKS = 200;
const STALE_AFTER_MS = 30_000;
const HISTORY_LIMIT = 100;
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
  if (security.includes("OPEN")) return "Open";
  if (security.includes("WEP")) return "WEP";
  if (security.includes("WPA2") && security.includes("WPA3")) return "WPA2/WPA3";
  if (security.includes("WPA3")) return "WPA3";
  if (security.includes("WPA/WPA2")) return "WPA/WPA2";
  if (security.includes("WPA2")) return "WPA2";
  if (security.includes("WPA")) return "WPA";
  return "Unknown";
}

function getSecurityStatus(security) {
  if (security === "Open") return "insecure";
  if (security === "WEP" || security === "WPA" || security === "WPA/WPA2") return "weak";
  if (security === "WPA2" || security === "WPA3" || security === "WPA2/WPA3") {
    return "encrypted";
  }
  return "unknown";
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
    return {
      ssid,
      bssid,
      rssi,
      channel,
      security,
      securityStatus: getSecurityStatus(security),
      trusted: false,
      lastSeen: scannedAt,
    };
  });

  return { deviceId, scannedAt, networks };
}

function makeSnapshot(state) {
  const trustedBssid = state.trustedNetwork?.bssid ?? state.trustedBssid;
  const networks = (state.latestScan?.networks ?? []).map((network) => ({
    ...network,
    trusted: Boolean(trustedBssid && network.bssid === trustedBssid),
  }));
  const trustedAP = networks.find((network) => network.trusted) ?? null;

  if (state.trustedNetwork?.ssid || trustedAP) {
    const trustedSsid = state.trustedNetwork?.ssid || trustedAP?.ssid;
    for (const network of networks) {
      network.suspicious = Boolean(
        network.ssid &&
        network.ssid === trustedSsid &&
        network.bssid !== trustedBssid,
      );
    }
  }

  const alerts = [];

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
    } else if (network.securityStatus === "weak") {
      alerts.push({
        type: "WEAK_ENCRYPTION",
        message: `${network.security} encryption is outdated.`,
        ssid: network.ssid,
        bssid: network.bssid,
        anomalyScore: 75,
        severity: "High",
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
    securityAlerts: state.alerts,
    trustedNetwork: state.trustedNetwork,
    trustedAP,
    channels: [...channelCounts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([channel, count]) => ({ channel, networks: count })),
    heatmap: networks.length ? [networks.map((network) => network.rssi)] : [],
    history: state.history,
  };
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
    networks: snapshot.networks.map((network) => ({
      ssid: network.ssid,
      bssid: network.bssid,
      rssi: network.rssi,
      channel: network.channel,
      security: network.security,
      securityStatus: network.securityStatus,
      trusted: network.trusted,
      suspicious: network.suspicious,
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
  const alerts = state.alerts
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
        const activeAlerts = state.alerts.filter((alert) => alert.status !== "Resolved");
        sendJson(response, 200, {
          alerts: state.alerts,
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
}