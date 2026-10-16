import L from "leaflet";
import { CircleMarker, MapContainer, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.heat";
import { Activity, LocateFixed, MapPin, Signal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useWifiData } from "../useWifiData";

const SURVEY_STORAGE_KEY = "wifishield-survey-points-v1";
const MAX_SURVEY_POINTS = 250;
const HEAT_RADII = [18, 24, 30, 36, 42];

function readSurveyPoints() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SURVEY_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((point) => point && typeof point === "object" &&
        Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90 &&
        Number.isFinite(point.lng) && point.lng >= -180 && point.lng <= 180 &&
        Array.isArray(point.observations))
      .map((point, index) => ({
        ...point,
        id: typeof point.id === "string" ? point.id : `saved-${index}`,
        timestamp: Number.isFinite(Date.parse(point.timestamp)) ? point.timestamp : new Date().toISOString(),
        observations: point.observations.filter((observation) =>
          observation && typeof observation.bssid === "string" && observation.bssid.length > 0 &&
          Number.isFinite(observation.rssi) && observation.rssi >= -127 && observation.rssi <= 0,
        ),
      }))
      .filter((point) => point.observations.length > 0)
      .slice(-MAX_SURVEY_POINTS);
  } catch {
    return [];
  }
}

function signalIntensity(rssi) {
  if (rssi <= -70) return Math.max(0.15, Math.min(0.33, 0.15 + ((rssi + 100) / 30) * 0.18));
  if (rssi <= -60) return 0.33 + ((rssi + 70) / 10) * 0.21;
  if (rssi <= -50) return 0.54 + ((rssi + 60) / 10) * 0.18;
  return Math.max(0.72, Math.min(1, 0.72 + ((rssi + 50) / 10) * 0.28));
}

function signalRadius(rssi) {
  const intensity = signalIntensity(rssi);
  const requestedRadius = 18 + intensity * 24;
  return HEAT_RADII.reduce((closest, radius) =>
    Math.abs(radius - requestedRadius) < Math.abs(closest - requestedRadius) ? radius : closest,
  HEAT_RADII[0]);
}

function HeatLayer({ points }) {
  const map = useMap();

  useEffect(() => {
    const pointsByRadius = new Map();
    for (const point of points) {
      const radius = signalRadius(point.rssi);
      const layerPoints = pointsByRadius.get(radius) ?? [];
      layerPoints.push([point.lat, point.lng, signalIntensity(point.rssi)]);
      pointsByRadius.set(radius, layerPoints);
    }

    const layers = [...pointsByRadius.entries()]
      .sort(([left], [right]) => right - left)
      .map(([radius, layerPoints]) => L.heatLayer(layerPoints, {
        radius,
        blur: Math.round(radius * 0.8),
        maxZoom: 19,
        minOpacity: 0.22,
        max: 1,
        gradient: {
          0.15: "#49338f",
          0.34: "#3679c5",
          0.54: "#4d9c70",
          0.72: "#e2d84c",
          0.88: "#ec8537",
          1: "#c93636",
        },
      }).addTo(map));

    return () => layers.forEach((layer) => map.removeLayer(layer));
  }, [map, points]);

  return null;
}

function MapEvents({ captureEnabled, onCapture }) {
  useMapEvents({
    click(event) {
      if (captureEnabled) onCapture(event.latlng);
    },
  });
  return null;
}

function MapFocus({ center }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.flyTo(center, 17, { duration: 0.8 });
  }, [center, map]);
  return null;
}

function getObservationPoints(surveyPoints, selectedBssid) {
  return surveyPoints.flatMap((point) => point.observations
    .filter((observation) => selectedBssid === "all" || observation.bssid === selectedBssid)
    .map((observation) => ({
      lat: point.lat,
      lng: point.lng,
      rssi: observation.rssi,
      ssid: observation.ssid,
      bssid: observation.bssid,
      timestamp: point.timestamp,
      pointId: point.id,
    })));
}

function Heatmap() {
  const { networks = [], mode, modeLabel, loading, apiError } = useWifiData();
  const [surveyPoints, setSurveyPoints] = useState(readSurveyPoints);
  const [selectedBssid, setSelectedBssid] = useState("all");
  const [captureEnabled, setCaptureEnabled] = useState(false);
  const [mapFocus, setMapFocus] = useState(null);
  const [locationError, setLocationError] = useState("");
  const [surveyError, setSurveyError] = useState("");
  const isDemo = mode === "demo" || mode === "offline";
  const canCapture = mode === "live" && networks.length > 0;
  const visibleNetworks = selectedBssid === "all"
    ? networks
    : networks.filter((network) => network.bssid === selectedBssid);
  const signalValues = visibleNetworks.map((network) => network.rssi).filter(Number.isFinite);
  const averageSignal = signalValues.length
    ? Math.round(signalValues.reduce((total, value) => total + value, 0) / signalValues.length)
    : null;
  const strongestSignal = signalValues.length ? Math.max(...signalValues) : null;
  const weakestSignal = signalValues.length ? Math.min(...signalValues) : null;
  const heatPoints = useMemo(
    () => getObservationPoints(surveyPoints, selectedBssid),
    [surveyPoints, selectedBssid],
  );
  const initialCenter = surveyPoints.length
    ? [surveyPoints[0].lat, surveyPoints[0].lng]
    : [20, 0];
  const initialZoom = surveyPoints.length ? 16 : 2;

  function persistSurveyPoints(nextPoints) {
    setSurveyPoints(nextPoints);
    try {
      window.localStorage.setItem(SURVEY_STORAGE_KEY, JSON.stringify(nextPoints));
      setSurveyError("");
    } catch {
      setSurveyError("Survey points could not be saved in this browser.");
    }
  }

  function recordSurvey(latlng) {
    if (!canCapture) return;
    const observations = networks
      .filter((network) => Number.isFinite(network.rssi) && network.bssid)
      .map((network) => ({
        ssid: network.ssid,
        bssid: network.bssid,
        rssi: network.rssi,
        channel: network.channel,
        security: network.security,
      }));
    if (!observations.length) return;

    const point = {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      lat: Number(latlng.lat.toFixed(6)),
      lng: Number(latlng.lng.toFixed(6)),
      timestamp: new Date().toISOString(),
      observations,
    };
    persistSurveyPoints([...surveyPoints, point].slice(-MAX_SURVEY_POINTS));
    setCaptureEnabled(false);
  }

  function locateScanner() {
    if (!navigator.geolocation) {
      setLocationError("Location is unavailable in this browser. Pan and zoom the map to your survey area.");
      return;
    }
    setLocationError("");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => setMapFocus([coords.latitude, coords.longitude]),
      () => setLocationError("Location permission was denied. Pan and zoom the map to your survey area."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  function clearSurveyPoints() {
    persistSurveyPoints([]);
  }

  return (
    <div className="page-container heatmap-page">
      <div className="page-header">
        <div>
          <h1>WiFi Signal Heatmap</h1>
          <p>Map measured Wi-Fi signal at manually recorded scanner locations.</p>
        </div>
        <div className="heatmap-controls">
          <label htmlFor="heatmap-network-select">Access point overlay</label>
          <select
            id="heatmap-network-select"
            value={selectedBssid}
            onChange={(event) => setSelectedBssid(event.target.value)}
          >
            <option value="all">All surveyed access points</option>
            {networks.map((network) => (
              <option key={network.bssid} value={network.bssid}>
                {network.ssid || "Hidden network"} · {network.bssid}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="heatmap-status">
        <div className="status-badge"><span></span>{modeLabel}</div>
        {isDemo && <span className="heatmap-demo-badge">DEMO MODE · sample scan data</span>}
        <span>{surveyPoints.length} saved survey {surveyPoints.length === 1 ? "point" : "points"}</span>
      </div>

      {loading && <div className="heatmap-message" role="status">Connecting to the WiFiShield API…</div>}
      {apiError && <div className="heatmap-message heatmap-error" role="alert">API unavailable: {apiError}. Showing demo scan data; survey capture is disabled.</div>}

      <div className="heatmap-summary">
        <div className="summary-card">
          <Activity size={22} />
          <div><span>Access Points</span><strong>{visibleNetworks.length}</strong></div>
        </div>
        <div className="summary-card">
          <Activity size={22} />
          <div><span>Strongest Signal</span><strong>{strongestSignal === null ? "--" : `${strongestSignal} dBm`}</strong></div>
        </div>
        <div className="summary-card">
          <Signal size={22} />
          <div><span>Average Signal</span><strong>{averageSignal === null ? "--" : `${averageSignal} dBm`}</strong></div>
        </div>
        <div className="summary-card">
          <Signal size={22} />
          <div><span>Weakest Signal</span><strong>{weakestSignal === null ? "--" : `${weakestSignal} dBm`}</strong></div>
        </div>
      </div>

      <div className="heatmap-location-note">
        <MapPin size={18} />
        <p>RSSI is measured where the scanner is located; it does not reveal an access point's physical location. Survey points are saved only when you mark the scanner's location on this map.</p>
      </div>

      <section className="panel heatmap-map-panel">
        <div className="heatmap-map-toolbar">
          <div>
            <h3>Geographical signal survey</h3>
            <span>{heatPoints.length} mapped RSSI observations</span>
          </div>
          <div className="heatmap-map-actions">
            <button
              type="button"
              className={`heatmap-action-button${captureEnabled ? " active" : ""}`}
              onClick={() => {
                setCaptureEnabled((enabled) => !enabled);
                setSurveyError("");
              }}
              disabled={!canCapture}
              title={canCapture ? "Click the map to record this live scan at the scanner's location" : "Live ESP32 scan data is required to record a survey point"}
            >
              <MapPin size={16} />{captureEnabled ? "Cancel point" : "Add survey point"}
            </button>
            <button type="button" className="heatmap-icon-button" onClick={locateScanner} title="Center on this device's location" aria-label="Center map on this device's location">
              <LocateFixed size={17} />
            </button>
            <button type="button" className="heatmap-icon-button" onClick={clearSurveyPoints} disabled={!surveyPoints.length} title="Clear saved survey points" aria-label="Clear saved survey points">
              <Trash2 size={17} />
            </button>
          </div>
        </div>

        {captureEnabled && (
          <div className="heatmap-capture-prompt" role="status">Click the map where the ESP32 scanner is located. This scan's current RSSI for each access point will be recorded there.</div>
        )}
        {locationError && <div className="heatmap-message heatmap-error" role="alert">{locationError}</div>}
        {surveyError && <div className="heatmap-message heatmap-error" role="alert">{surveyError}</div>}

        <MapContainer
          center={initialCenter}
          zoom={initialZoom}
          zoomControl
          scrollWheelZoom
          className={`heatmap-map${captureEnabled ? " capture-enabled" : ""}`}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <HeatLayer points={heatPoints} />
          <MapEvents captureEnabled={captureEnabled} onCapture={recordSurvey} />
          <MapFocus center={mapFocus} />
          {surveyPoints.map((point) => (
            <CircleMarker
              key={point.id}
              center={[point.lat, point.lng]}
              radius={5}
              pathOptions={{ color: "#fff", weight: 2, fillColor: "#273f66", fillOpacity: 0.9 }}
            >
              <Popup>
                <strong>Scanner survey</strong><br />
                {point.observations.length} access point readings<br />
                {new Date(point.timestamp).toLocaleString()}
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>

        {surveyPoints.length === 0 && (
          <div className="heatmap-no-points">
            <strong>No geographical survey points yet</strong>
            <span>Pan or zoom to the survey area, then add a point during a live ESP32 scan. The map starts at a neutral world view.</span>
          </div>
        )}

        <div className="heatmap-legend-panel" aria-label="Signal strength legend">
          <strong>Signal strength at surveyed scanner location</strong>
          <div className="heatmap-legend-gradient" aria-hidden="true" />
          <div className="heatmap-legend-labels">
            <span className="legend-weak">Weak <strong>&lt; -70 dBm</strong></span>
            <span className="legend-medium">Medium <strong>-70 to -61 dBm</strong></span>
            <span className="legend-good">Good <strong>-60 to -51 dBm</strong></span>
            <span className="legend-strong">Strong <strong>&ge; -50 dBm</strong></span>
          </div>
        </div>
      </section>

      {surveyPoints.length > 0 && (
        <section className="panel heatmap-observations-panel">
          <div className="panel-header"><h3>Saved survey observations</h3><span>Stored in this browser</span></div>
          <div className="heatmap-observation-list">
            {surveyPoints.slice().reverse().map((point) => {
              const observations = point.observations.filter((observation) =>
                selectedBssid === "all" || observation.bssid === selectedBssid,
              );
              return (
                <article className="heatmap-observation" key={point.id}>
                  <div>
                    <strong>{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</strong>
                    <small>{new Date(point.timestamp).toLocaleString()}</small>
                  </div>
                  <span>{observations.length} AP readings</span>
                  <div className="heatmap-observation-signals">
                    {observations.map((observation) => (
                      <span key={observation.bssid}>
                        {observation.ssid || "Hidden"} <strong>{observation.rssi} dBm</strong>
                      </span>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

export default Heatmap;