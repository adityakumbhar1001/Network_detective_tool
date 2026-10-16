import {
  History,
  Wifi,
  AlertTriangle,
  Calendar,
} from "lucide-react";
import { useWifiData } from "../useWifiData";

function SurveyHistory() {
  const { history, modeLabel } = useWifiData();

  const totalSurveys = history.length;

  const totalNetworks = history.reduce(
    (total, survey) => total + survey.networks,
    0
  );

  const totalAlerts = history.reduce(
    (total, survey) => total + survey.alerts,
    0
  );

  return (
    <div className="page-container">

      {/* PAGE HEADER */}

      <div className="page-header">
        <div>
          <h1>Survey History</h1>

          <p>
            View previous wireless network surveys and detection results.
          </p>
        </div>

        <div className="status-badge">
          <span></span>
          {modeLabel}
        </div>
      </div>


      {/* SUMMARY */}

      <div className="history-summary">

        <div className="summary-card">
          <History size={22} />

          <div>
            <span>Total Surveys</span>
            <strong>{totalSurveys}</strong>
          </div>
        </div>


        <div className="summary-card">
          <Wifi size={22} />

          <div>
            <span>Networks Detected</span>
            <strong>{totalNetworks}</strong>
          </div>
        </div>


        <div className="summary-card warning-card">
          <AlertTriangle size={22} />

          <div>
            <span>Alerts Detected</span>
            <strong>{totalAlerts}</strong>
          </div>
        </div>

      </div>


      {/* HISTORY TABLE */}

      <div className="panel history-panel">

        <div className="panel-header">
          <h3>Previous Surveys</h3>

          <span>
            {history.length} records
          </span>
        </div>


        <div className="history-table-wrapper">

          <table className="history-table">

            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Networks</th>
                <th>Alerts</th>
                <th>Status</th>
              </tr>
            </thead>


            <tbody>

              {history.map((survey) => (

                <tr key={survey.id}>

                  <td>
                    <div className="history-date">
                      <Calendar size={15} />
                      {survey.date}
                    </div>
                  </td>

                  <td>
                    {survey.time}
                  </td>

                  <td>
                    <strong>
                      {survey.networks}
                    </strong>
                  </td>

                  <td>

                    {survey.alerts > 0 ? (

                      <span className="history-alert">
                        <AlertTriangle size={14} />
                        {survey.alerts}
                      </span>

                    ) : (

                      <span className="history-safe">
                        0
                      </span>

                    )}

                  </td>

                  <td>
                    <span className="survey-status">
                      {survey.status}
                    </span>
                  </td>

                </tr>

              ))}

            </tbody>

          </table>

        </div>

      </div>


      {/* FUTURE ESP32 SECTION */}

      <div className="panel history-info-panel">

        <div className="panel-header">
          <h3>Survey Data</h3>
        </div>

        <div className="history-info">

          <div>
            <strong>ESP32 Scan API</strong>

            <p>
              Each accepted device scan updates the dashboard and creates a history record.
            </p>
          </div>


          <div>
            <strong>Connection Status</strong>

            <p>
              {modeLabel} - the dashboard checks for new scans every three seconds.
            </p>
          </div>


          <div>
            <strong>Stored Results</strong>

            <p>
              Scan history is held in backend memory and clears when the backend restarts.
            </p>
          </div>

        </div>

      </div>

    </div>
  );
}

export default SurveyHistory;