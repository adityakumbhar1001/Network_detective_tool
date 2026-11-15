import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createWifiServer } from "./index.js";

const trustedBssid = "AA:BB:CC:11:22:33";
const server = createWifiServer({ trustedBssid, deviceToken: "test-token", persistencePath: null });
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("accepts ESP32 scans and exposes classified live data", async () => {
  const response = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Token": "test-token",
    },
    body: JSON.stringify({
      deviceId: "esp32-lab-01",
      scannedAt: "2026-09-28T09:30:00.000Z",
      networks: [
        {
          ssid: "LabWiFi",
          bssid: trustedBssid,
          rssi: -42,
          channel: 6,
          authType: "WIFI_AUTH_WPA2_PSK",
        },
        {
          ssid: "LabWiFi",
          bssid: "11:22:33:44:55:66",
          rssi: -58,
          channel: 11,
          authType: "WIFI_AUTH_OPEN",
        },
        {
          ssid: "LegacyWiFi",
          bssid: "22:33:44:55:66:77",
          rssi: -65,
          channel: 1,
          security: "WPA/WPA2",
        },
      ],
    }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    accepted: true,
    deviceId: "esp32-lab-01",
    scannedAt: "2026-09-28T09:30:00.000Z",
    networks: 3,
    alerts: 3,
  });

  const snapshotResponse = await fetch(`${baseUrl}/api/snapshot`);
  const snapshotText = await snapshotResponse.text();
  assert.equal(Number(snapshotResponse.headers.get("content-length")), Buffer.byteLength(snapshotText));
  const snapshot = JSON.parse(snapshotText);
  assert.equal(snapshot.status, "live");
  assert.equal(snapshot.networks[0].securityStatus, "encrypted");
  assert.equal(snapshot.networks[0].security, "WPA2");
  assert.equal(snapshot.networks[0].trusted, true);
  assert.equal(snapshot.networks[1].securityStatus, "insecure");
  assert.equal(snapshot.networks[1].suspicious, true);
  assert.equal(snapshot.networks[2].security, "WPA/WPA2");
  assert.equal(snapshot.networks[2].securityStatus, "weak");
  assert.deepEqual(
    snapshot.alerts.map((alert) => alert.type),
    ["OPEN_NETWORK", "DUPLICATE_SSID", "WEAK_ENCRYPTION"],
  );
  assert.equal(snapshot.channels.length, 3);
  assert.equal(snapshot.heatmap[0].length, 3);
  assert.equal(snapshot.history.length, 1);

  const displayResponse = await fetch(`${baseUrl}/api/snapshot?display=1`);
  const displayText = await displayResponse.text();
  assert.equal(Number(displayResponse.headers.get("content-length")), Buffer.byteLength(displayText));
  const displaySnapshot = JSON.parse(displayText);
  assert.deepEqual(Object.keys(displaySnapshot).sort(), [
    "deviceId",
    "networks",
    "receivedAt",
    "scannedAt",
    "securityAlerts",
    "status",
  ]);
  assert.equal(displaySnapshot.networks.length, 3);
  assert.ok(displaySnapshot.networks.every((network) => !("lastSeen" in network)));
  assert.ok(displaySnapshot.securityAlerts.every((alert) => alert.status !== "Resolved"));
});

test("rejects unauthenticated or malformed scans", async () => {
  const unauthorized = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ networks: [] }),
  });
  assert.equal(unauthorized.status, 401);

  const malformed = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Token": "test-token",
    },
    body: JSON.stringify({
      deviceId: "esp32",
      networks: [{ ssid: "Bad RSSI", bssid: trustedBssid, rssi: -140, channel: 1 }],
    }),
  });
  assert.equal(malformed.status, 400);

  const missingFields = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Token": "test-token",
    },
    body: JSON.stringify({ networks: [{ ssid: "Missing BSSID", rssi: -50, channel: 1 }] }),
  });
  assert.equal(missingFields.status, 400);

  const invalidJson = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Token": "test-token",
    },
    body: "null",
  });
  assert.equal(invalidJson.status, 400);
});

test("configures a trusted AP and acknowledges and resolves generated alerts", async () => {
  const configured = await fetch(`${baseUrl}/api/trusted-network`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid: "LabWiFi", bssid: trustedBssid, expectedSecurity: "WPA2" }),
  });
  assert.equal(configured.status, 200);
  assert.equal((await configured.json()).trustedNetwork.expectedSecurity, "WPA2");

  const submitted = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Token": "test-token",
    },
    body: JSON.stringify({
      deviceId: "esp32-lab-01",
      networks: [{ ssid: "LabWiFi", bssid: trustedBssid, rssi: -48, channel: 6, security: "Open" }],
    }),
  });
  assert.equal(submitted.status, 201);

  const alertsResponse = await fetch(`${baseUrl}/api/alerts`);
  const alertsBody = await alertsResponse.json();
  const activeCountBefore = alertsBody.activeCount;
  const downgrade = alertsBody.alerts.find((alert) => alert.type === "SECURITY_DOWNGRADE");
  assert.ok(downgrade);
  assert.equal(downgrade.status, "New");
  assert.equal(downgrade.evidence.expectedSecurity, "WPA2");

  const acknowledged = await fetch(`${baseUrl}/api/alerts/${downgrade.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Acknowledged" }),
  });
  assert.equal((await acknowledged.json()).alert.status, "Acknowledged");

  const resolved = await fetch(`${baseUrl}/api/alerts/${downgrade.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Resolved" }),
  });
  assert.equal((await resolved.json()).alert.status, "Resolved");
  assert.equal((await (await fetch(`${baseUrl}/api/alerts`)).json()).activeCount, activeCountBefore - 1);

  const snapshot = await fetch(`${baseUrl}/api/snapshot`);
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).networks[0].security, "Open");
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

test("persists trusted settings and detector alerts across server restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wifi-shield-test-"));
  const persistencePath = join(directory, "state.json");
  let persistentServer = createWifiServer({ persistencePath });

  try {
    await new Promise((resolve) => persistentServer.listen(0, "127.0.0.1", resolve));
    const firstUrl = `http://127.0.0.1:${persistentServer.address().port}`;
    const trusted = await fetch(`${firstUrl}/api/trusted-network`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssid: "PersistedWiFi", bssid: trustedBssid, expectedSecurity: "WPA2" }),
    });
    assert.equal(trusted.status, 200);

    const postScan = (security) => fetch(`${firstUrl}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        networks: [{ ssid: "PersistedWiFi", bssid: trustedBssid, rssi: -48, channel: 6, security }],
      }),
    });
    await postScan("WPA2");
    await postScan("Open");
    await new Promise((resolve, reject) => persistentServer.close((error) => error ? reject(error) : resolve()));

    persistentServer = createWifiServer({ persistencePath });
    await new Promise((resolve) => persistentServer.listen(0, "127.0.0.1", resolve));
    const restartedUrl = `http://127.0.0.1:${persistentServer.address().port}`;
    const storedTrusted = await (await fetch(`${restartedUrl}/api/trusted-network`)).json();
    const storedAlerts = await (await fetch(`${restartedUrl}/api/alerts`)).json();
    assert.equal(storedTrusted.trustedNetwork.expectedSecurity, "WPA2");
    assert.ok(storedAlerts.alerts.some((alert) => alert.type === "SECURITY_DOWNGRADE"));
  } finally {
    if (persistentServer.listening) {
      await new Promise((resolve, reject) => persistentServer.close((error) => error ? reject(error) : resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports only detector alerts still present in the latest scan", async () => {
  const latestServer = createWifiServer({ persistencePath: null });
  await new Promise((resolve) => latestServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${latestServer.address().port}`;

  try {
    await fetch(`${url}/api/trusted-network`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssid: "LatestWiFi", bssid: trustedBssid, expectedSecurity: "WPA2" }),
    });
    const postScan = (security) => fetch(`${url}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        networks: [{ ssid: "LatestWiFi", bssid: trustedBssid, rssi: -48, channel: 6, security }],
      }),
    });

    await postScan("Open");
    const downgraded = await (await fetch(`${url}/api/alerts`)).json();
    assert.ok(downgraded.alerts.some((alert) => alert.type === "SECURITY_DOWNGRADE"));

    await postScan("WPA2");
    const alerts = await (await fetch(`${url}/api/alerts`)).json();
    const display = await (await fetch(`${url}/api/snapshot?display=1`)).json();
    const snapshot = await (await fetch(`${url}/api/snapshot`)).json();
    assert.ok(!alerts.alerts.some((alert) => alert.type === "SECURITY_DOWNGRADE"));
    assert.ok(!display.securityAlerts.some((alert) => alert.type === "SECURITY_DOWNGRADE"));
    assert.ok(!snapshot.securityAlerts.some((alert) => alert.type === "SECURITY_DOWNGRADE"));
  } finally {
    await new Promise((resolve, reject) => latestServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("classifies WPA/WPA2 mixed mode by its reported cipher", async () => {
  const cipherServer = createWifiServer({ persistencePath: null });
  await new Promise((resolve) => cipherServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${cipherServer.address().port}`;

  try {
    await fetch(`${url}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        networks: [
          { ssid: "AesOnly", bssid: "10:00:00:00:00:01", rssi: -50, channel: 1, security: "WPA/WPA2", pairwiseCipher: "CCMP", groupCipher: "CCMP" },
          { ssid: "AllowsTkip", bssid: "20:00:00:00:00:02", rssi: -50, channel: 6, security: "WPA/WPA2", pairwiseCipher: "TKIP/CCMP", groupCipher: "TKIP" },
          { ssid: "NoCipherData", bssid: "30:00:00:00:00:03", rssi: -50, channel: 11, security: "WPA/WPA2" },
          { ssid: "Wpa2Tkip", bssid: "40:00:00:00:00:04", rssi: -50, channel: 11, security: "WPA2", pairwiseCipher: "TKIP", groupCipher: "TKIP" },
        ],
      }),
    });
    const snapshot = await (await fetch(`${url}/api/snapshot`)).json();
    const status = Object.fromEntries(snapshot.networks.map((network) => [network.ssid, network.securityStatus]));
    assert.deepEqual(status, { AesOnly: "encrypted", AllowsTkip: "weak", NoCipherData: "weak", Wpa2Tkip: "weak" });

    const warnings = Object.fromEntries(snapshot.alerts.map((alert) => [alert.ssid, alert]));
    assert.equal(warnings.AesOnly, undefined);
    assert.match(warnings.AllowsTkip.message, /TKIP/);
    assert.equal(warnings.AllowsTkip.severity, "High");
    assert.equal(warnings.NoCipherData.severity, "Medium");
  } finally {
    await new Promise((resolve, reject) => cipherServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("keeps recently heard networks for a short window, strongest first", async () => {
  const recentServer = createWifiServer({ persistencePath: null });
  await new Promise((resolve) => recentServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${recentServer.address().port}`;
  const postScan = (networks) => fetch(`${url}/api/scans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "esp32-recent", networks }),
  });

  try {
    await postScan([
      { ssid: "Near", bssid: "50:00:00:00:00:01", rssi: -40, channel: 1, security: "WPA2" },
      { ssid: "EdgeOfRange", bssid: "60:00:00:00:00:02", rssi: -92, channel: 6, security: "WPA2" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));  // distinct receive timestamps
    await postScan([
      { ssid: "Near", bssid: "50:00:00:00:00:01", rssi: -41, channel: 1, security: "WPA2" },
      { ssid: "Middle", bssid: "70:00:00:00:00:03", rssi: -70, channel: 11, security: "WPA2" },
    ]);
    const snapshot = await (await fetch(`${url}/api/snapshot`)).json();
    assert.deepEqual(snapshot.networks.map((network) => network.ssid), ["Near", "Middle", "EdgeOfRange"]);
    const edge = snapshot.networks.find((network) => network.ssid === "EdgeOfRange");
    assert.equal(edge.seenInLatestScan, false);
    assert.equal(snapshot.networks.find((network) => network.ssid === "Near").seenInLatestScan, true);
  } finally {
    await new Promise((resolve, reject) => recentServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("labels open campus networks as sign-in portals and groups their access points", async () => {
  const campusServer = createWifiServer({ persistencePath: null });
  await new Promise((resolve) => campusServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${campusServer.address().port}`;

  try {
    await fetch(`${url}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        networks: [
          { ssid: "vit_student", bssid: "10:00:00:00:00:01", rssi: -50, channel: 1, security: "Open" },
          { ssid: "VIT_Student", bssid: "20:00:00:00:00:02", rssi: -60, channel: 6, security: "Open" },
          { ssid: "VIT_STUDENT", bssid: "30:00:00:00:00:03", rssi: -70, channel: 11, security: "Open" },
          { ssid: "CafeOpen", bssid: "40:00:00:00:00:04", rssi: -65, channel: 11, security: "Open" },
        ],
      }),
    });
    const full = await (await fetch(`${url}/api/snapshot`)).json();
    const byBssid = Object.fromEntries(full.networks.map((network) => [network.bssid, network.securityStatus]));
    assert.equal(byBssid["10:00:00:00:00:01"], "portal");
    assert.equal(byBssid["40:00:00:00:00:04"], "insecure");
    assert.ok(full.alerts.some((alert) => alert.type === "PORTAL_NETWORK" && alert.severity === "Low"));
    assert.ok(full.alerts.some((alert) => alert.type === "OPEN_NETWORK" && alert.ssid === "CafeOpen"));
    assert.equal(full.securityAlerts.filter((alert) => alert.type === "DUPLICATE_SSID_WARNING").length, 0);

    const display = await (await fetch(`${url}/api/snapshot?display=1`)).json();
    assert.equal(display.networks.length, 2);
    assert.equal(display.networks[0].apCount, 1 + 2);
    assert.equal(display.networks[0].securityStatus, "portal");
  } finally {
    await new Promise((resolve, reject) => campusServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("flags a campus-named access point whose vendor prefix differs from the others", async () => {
  const vendorServer = createWifiServer({ persistencePath: null });
  await new Promise((resolve) => vendorServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${vendorServer.address().port}`;

  try {
    await fetch(`${url}/api/scans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        networks: [
          { ssid: "VIT_Student", bssid: "AA:11:22:00:00:01", rssi: -50, channel: 1, security: "Open" },
          { ssid: "VIT_Student", bssid: "AA:11:22:00:00:02", rssi: -55, channel: 6, security: "Open" },
          { ssid: "VIT_Student", bssid: "A8:11:22:00:00:03", rssi: -60, channel: 11, security: "Open" },
          { ssid: "VIT_Student", bssid: "DE:AD:BE:EF:00:09", rssi: -45, channel: 6, security: "Open" },
        ],
      }),
    });
    const snapshot = await (await fetch(`${url}/api/snapshot`)).json();
    const flagged = snapshot.securityAlerts.filter((alert) => alert.type === "CAMPUS_VENDOR_MISMATCH");
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].observedBssid, "DE:AD:BE:EF:00:09");
    const rogue = snapshot.networks.find((network) => network.bssid === "DE:AD:BE:EF:00:09");
    assert.equal(rogue.suspicious, true);
    const display = await (await fetch(`${url}/api/snapshot?display=1`)).json();
    assert.equal(display.networks.length, 2);  // one grouped card (x3) + the flagged AP
  } finally {
    await new Promise((resolve, reject) => vendorServer.close((error) => error ? reject(error) : resolve()));
  }
});
