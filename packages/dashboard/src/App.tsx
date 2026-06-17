import { Routes, Route, NavLink } from "react-router-dom";
import { OverviewPage } from "./pages/Overview.js";
import { BudgetsPage } from "./pages/Budgets.js";

const NAV_STYLE: React.CSSProperties = {
  padding: "8px 16px",
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
        <span style={{ fontWeight: 700, fontSize: 16, marginRight: 24, color: "#111" }}>
          ⬆ Elevation
        </span>
        <NavLink
          to="/"
          end
          style={({ isActive }) => (isActive ? ACTIVE_NAV_STYLE : NAV_STYLE)}
        >
          Overview
        </NavLink>
        <NavLink
          to="/budgets"
          style={({ isActive }) => (isActive ? ACTIVE_NAV_STYLE : NAV_STYLE)}
        >
          Budgets
        </NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
        </Routes>
      </main>
    </div>
  );
}
