import { useEffect, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.heat";

const heatData = [
  // latitude, longitude, intensity
  [18.4640, 73.8675, 1.0],
  [18.4642, 73.8680, 0.95],
  [18.4644, 73.8685, 0.85],
  [18.4646, 73.8690, 0.70],
  [18.4648, 73.8695, 0.55],
  [18.4650, 73.8682, 0.80],
  [18.4652, 73.8687, 0.65],
  [18.4654, 73.8692, 0.45],
  [18.4643, 73.8695, 0.35],
  [18.4638, 73.8688, 0.75],
  [18.4636, 73.8682, 0.90],
];

function HeatLayer({ points }) {
  const map = useMap();

  useEffect(() => {
    const heatLayer = L.heatLayer(points, {
      radius: 45,
      blur: 35,
      maxZoom: 18,
      minOpacity: 0.35,
      max: 1.0,

      gradient: {
        0.2: "blue",
        0.4: "cyan",
        0.55: "lime",
        0.7: "yellow",
        0.85: "orange",
        1.0: "red",
      },
    });

    heatLayer.addTo(map);

    return () => {
      map.removeLayer(heatLayer);
    };
  }, [map, points]);

  return null;
}

function Heatmap() {
  const [selectedWifi, setSelectedWifi] = useState("HomeWiFi");

  const wifiNetworks = [
    "HomeWiFi",
    "CollegeWiFi",
    "LibraryWiFi",
  ];

  return (
    <div className="heatmap-page">

      {/* Header */}
      <div className="heatmap-header">
        <div>
          <h1>WiFi Signal Heatmap</h1>
          <p>
            Visualize wireless signal strength across the scanned area
          </p>
        </div>

        <div className="heatmap-selector">
          <label>Select WiFi</label>

          <select
            value={selectedWifi}
            onChange={(e) => setSelectedWifi(e.target.value)}
          >
            {wifiNetworks.map((wifi) => (
              <option key={wifi} value={wifi}>
                {wifi}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Status */}
      <div className="heatmap-status">
        <span className="demo-badge">DEMO MODE</span>
        <span>
          Showing signal coverage for <strong>{selectedWifi}</strong>
        </span>
      </div>

      {/* Map */}
      <div className="heatmap-map-container">
        <MapContainer
          center={[18.4643, 73.8685]}
          zoom={17}
          scrollWheelZoom={true}
          className="heatmap-map"
        >
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <HeatLayer points={heatData} />
        </MapContainer>
      </div>

      {/* Signal information */}
      <div className="heatmap-info">

        <div className="signal-card">
          <span>Strongest Signal</span>
          <strong>-42 dBm</strong>
        </div>

        <div className="signal-card">
          <span>Average Signal</span>
          <strong>-58 dBm</strong>
        </div>

        <div className="signal-card">
          <span>Weakest Signal</span>
          <strong>-78 dBm</strong>
        </div>

        <div className="signal-card">
          <span>Survey Points</span>
          <strong>{heatData.length}</strong>
        </div>

      </div>

      {/* Legend */}
      <div className="heatmap-legend">

        <span className="legend-title">Signal Strength</span>

        <div className="legend-gradient"></div>

        <div className="legend-labels">
          <span>Weak</span>
          <span>Medium</span>
          <span>Strong</span>
        </div>

      </div>

    </div>
  );
}

export default Heatmap;