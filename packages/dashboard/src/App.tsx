import { Routes, Route, NavLink } from "react-router-dom";
import { OverviewPage } from "./pages/Overview.js";
import { AgentDetailPage } from "./pages/AgentDetail.js";
import { TeamsPage } from "./pages/Teams.js";
import { BudgetsPage } from "./pages/Budgets.js";
import { AlertHistoryPage } from "./pages/AlertHistory.js";
import { ToolCallsPage } from "./pages/ToolCalls.js";

const NAV_STYLE: React.CSSProperties = {
  padding: "8px 14px",
  textDecoration: "none",
  color: "#666",
  fontSize: 14,
  borderRadius: 4,
};

const ACTIVE_NAV_STYLE: React.CSSProperties = {
  ...NAV_STYLE,
  color: "#0066ff",
  fontWeight: 600,
  background: "#f0f5ff",
};

export function App() {
  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f5" }}>
      <nav
        style={{
          background: "white",
          borderBottom: "1px solid #eee",
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          height: 56,
          gap: 4,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 16, marginRight: 20, color: "#111" }}>
          ⬆ Elevation
        </span>
        <NavLink to="/" end style={({ isActive }) => (isActive ? ACTIVE_NAV_STYLE : NAV_STYLE)}>
          Overview
        </NavLink>
        <NavLink to="/teams" style={({ isActive }) => (isActive ? ACTIVE_NAV_STYLE : NAV_STYLE)}>
          Teams
        </NavLink>
        <NavLink to="/budgets" style={({ isActive }) => (isActive ? ACTIVE_NAV_STYLE : NAV_STYLE)}>
          Budgets
        </NavLink>
        <NavLink to="/alerts" style={({ isActive }) => (isActive ? ACTIVE_NAV_STYLE : NAV_STYLE)}>
          Alerts
        </NavLink>
        <NavLink to="/tool-calls" style={({ isActive }) => (isActive ? ACTIVE_NAV_STYLE : NAV_STYLE)}>
          Tool Calls
        </NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/agents/:agentId" element={<AgentDetailPage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
          <Route path="/alerts" element={<AlertHistoryPage />} />
          <Route path="/tool-calls" element={<ToolCallsPage />} />
        </Routes>
      </main>
    </div>
  );
}
