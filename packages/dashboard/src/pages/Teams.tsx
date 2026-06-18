import { useState } from "react";
import { Link } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { useTeamAttribution, useAgentAttribution } from "../hooks/useAttribution.js";

const PERIODS = ["1d", "7d", "30d"] as const;
type Period = typeof PERIODS[number];

const COLORS = ["#0066ff", "#00c9a7", "#f6c90e", "#e84855", "#7b2d8b"];

function fmt(n: number | null | undefined) {
  if (n == null) return "$0.00";
  return `$${Number(n).toFixed(4)}`;
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return "0";
  return Number(n).toLocaleString();
}

const CARD: React.CSSProperties = {
  background: "white",
  border: "1px solid #eee",
  borderRadius: 8,
};

function TeamDrilldown({ teamId, period }: { teamId: string; period: Period }) {
  const { data: agents, loading } = useAgentAttribution(period, teamId);
  return (
    <div style={{ padding: "12px 16px", borderTop: "1px solid #f5f5f5", background: "#fafafa" }}>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>Agents in team</div>
      {loading ? (
        <div style={{ fontSize: 13, color: "#aaa" }}>Loading…</div>
      ) : agents.length === 0 ? (
        <div style={{ fontSize: 13, color: "#aaa" }}>No agent data for this period</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {["Agent ID", "Cost", "Requests", "In Tokens", "Out Tokens"].map((h) => (
                <th key={h} style={{ padding: "4px 8px", textAlign: "left", color: "#999", fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.agentId} style={{ borderTop: "1px solid #eee" }}>
                <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                  <Link to={`/agents/${encodeURIComponent(a.agentId)}`} style={{ color: "#0066ff", textDecoration: "none" }}>
                    {a.agentId.length > 24 ? `${a.agentId.slice(0, 12)}…${a.agentId.slice(-10)}` : a.agentId}
                  </Link>
                </td>
                <td style={{ padding: "6px 8px", fontWeight: 600 }}>{fmt(a.totalCostUsd)}</td>
                <td style={{ padding: "6px 8px" }}>{fmtNum(a.requestCount)}</td>
                <td style={{ padding: "6px 8px" }}>{fmtNum(a.inputTokens)}</td>
                <td style={{ padding: "6px 8px" }}>{fmtNum(a.outputTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function TeamsPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: teams, loading } = useTeamAttribution(period);

  const chartData = teams.slice(0, 8).map((t) => ({
    teamId: t.teamId.length > 12 ? `${t.teamId.slice(0, 10)}…` : t.teamId,
    cost: Number(t.totalCostUsd),
  }));

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1200 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Teams</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)} style={{ padding: "4px 12px", borderRadius: 4, border: "1px solid #ddd", background: p === period ? "#0066ff" : "white", color: p === period ? "white" : "#333", cursor: "pointer", fontSize: 13 }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Top teams bar chart */}
      {chartData.length > 0 && (
        <div style={{ ...CARD, padding: 20, marginBottom: 24 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 14, color: "#555" }}>Cost by Team</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData}>
              <XAxis dataKey="teamId" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(3)}`} />
              <Tooltip formatter={(v: number) => [`$${Number(v).toFixed(6)}`, "Cost"]} />
              <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Teams table with drilldown */}
      <div style={CARD}>
        <div style={{ padding: "16px", borderBottom: "1px solid #eee" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>All Teams</h2>
        </div>
        {loading ? (
          <div style={{ padding: 24, color: "#888" }}>Loading…</div>
        ) : teams.length === 0 ? (
          <div style={{ padding: 24, color: "#888" }}>No team data for this period.</div>
        ) : (
          teams.map((t) => (
            <div key={t.teamId}>
              <div
                onClick={() => setExpanded(expanded === t.teamId ? null : t.teamId)}
                style={{ padding: "12px 16px", borderBottom: "1px solid #eee", cursor: "pointer", display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 40px", alignItems: "center", fontSize: 13 }}
              >
                <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{t.teamId}</span>
                <span style={{ color: "#111", fontWeight: 600 }}>{fmt(t.totalCostUsd)}</span>
                <span style={{ color: "#555" }}>{fmtNum(t.requestCount)} req</span>
                <span style={{ color: "#555" }}>{fmtNum(t.agentCount)} agents</span>
                <span style={{ color: "#888", fontSize: 12 }}>{fmtNum(t.inputTokens)}↑ {fmtNum(t.outputTokens)}↓</span>
                <span style={{ color: "#aaa", textAlign: "right" }}>{expanded === t.teamId ? "▲" : "▼"}</span>
              </div>
              {expanded === t.teamId && (
                <TeamDrilldown teamId={t.teamId} period={period} />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
