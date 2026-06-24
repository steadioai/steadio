import { Routes, Route, NavLink } from "react-router-dom";
import { OverviewPage } from "./pages/Overview.js";
import { AgentsPage } from "./pages/Agents.js";
import { AgentDetailPage } from "./pages/AgentDetail.js";
import { TeamsPage } from "./pages/Teams.js";
import { BudgetsPage } from "./pages/Budgets.js";
import { AlertHistoryPage } from "./pages/AlertHistory.js";
import { ToolCallsPage } from "./pages/ToolCalls.js";

const NAV_STYLE: React.CSSProperties = {
  padding: "8px 14px",
  textDecoration: "none",
  color: "#64748b",
  fontSize: 13,
  fontWeight: 500,
  borderRadius: 6,
  transition: "all 0.15s ease",
};

const ACTIVE_NAV_STYLE: React.CSSProperties = {
  ...NAV_STYLE,
  color: "#2563eb",
  fontWeight: 600,
  background: "linear-gradient(135deg, #eff6ff, #ede9fe)",
};

export function App() {
  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc" }}>
      <nav
        style={{
          background: "rgba(255,255,255,0.95)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          height: 56,
          gap: 4,
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}
      >
        <span style={{
          fontWeight: 800,
          fontSize: 18,
          marginRight: 20,
          background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
          letterSpacing: "-0.5px",
        }}>
          SteadIO
        </span>
        <NavLink to="/" end style={({ isActive }) => (isActive ? ACTIVE_NAV_STYLE : NAV_STYLE)}>
          Overview
        </NavLink>
        <NavLink to="/agents" style={({ isActive }) => (isActive ? ACTIVE_NAV_STYLE : NAV_STYLE)}>
          Agents
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
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:agentId" element={<AgentDetailPage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
          <Route path="/alerts" element={<AlertHistoryPage />} />
          <Route path="/tool-calls" element={<ToolCallsPage />} />
        </Routes>
      </main>
      <footer
        style={{
          borderTop: "1px solid rgba(0,0,0,0.06)",
          padding: "20px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 12,
          color: "#94a3b8",
        }}
      >
        <span style={{ fontWeight: 600, letterSpacing: "-0.3px" }}>SteadIO</span>
        <span>steadio.ai</span>
      </footer>
    </div>
  );
}
