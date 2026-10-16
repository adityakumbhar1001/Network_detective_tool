async function request(path, options) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `WiFiShield API returned ${response.status}.`);
  }

  return response.json();
}

export function getSnapshot() {
  return request("/api/snapshot");
}

export function submitScan(scan, deviceToken) {
  return request("/api/scans", {
    method: "POST",
    headers: deviceToken ? { "X-Device-Token": deviceToken } : {},
    body: JSON.stringify(scan),
  });
}

export function setTrustedNetwork(configuration) {
  return request("/api/trusted-network", {
    method: "PUT",
    body: JSON.stringify(
      typeof configuration === "string" ? { bssid: configuration } : configuration,
    ),
  });
}

export function updateAlertStatus(alertId, status) {
  return request(`/api/alerts/${encodeURIComponent(alertId)}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}