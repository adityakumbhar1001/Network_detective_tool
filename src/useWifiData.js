import { useContext } from "react";

import { WifiDataContext } from "./wifiDataContext";

export function useWifiData() {
  const data = useContext(WifiDataContext);
  if (!data) throw new Error("useWifiData must be used inside WifiDataProvider.");
  return data;
}