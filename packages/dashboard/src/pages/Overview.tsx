import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useAgentAttribution, useSummary } from "../hooks/useAttribution.js";

const PERIODS = ["1d", "7d", "30d"] as const;
type Period = typeof PERIODS[number];

function fmt(n: number | undefined | null) {
  if (n == null) return "$0.00";
  return `$${Number(n).toFixed(4)}`;
}

function fmtNum(n: number | undefined | null) {
  if (n == null) return "0";
  return Number(n).toLocaleString();
}

export function OverviewPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const { data: agents, loading } = useAgentAttribution(period);
  const { data: summary } = useSummary({ period });

  return (
    <div style={{ padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Elevation Networks</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: "4px 12px",
                borderRadius: 4,
                border: "1px solid #ddd",
                background: p === period ? "#0066ff" : "white",
                color: p === period ? "white" : "#333",
                cursor: "pointer",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
          <StatCard label="Total Spend" value={fmt(summary.totalCostUsd)} />
          <StatCard label="Requests" value={fmtNum(summary.requestCount)} />
          <StatCard label="Input Tokens" value={fmtNum(summary.inputTokens)} />
          <StatCard label="Output Tokens" value={fmtNum(summary.outputTokens)} />
        </div>
      )}

      {/* Agent table */}
      <div style={{ background: "white", border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ padding: "16px", borderBottom: "1px solid #eee" }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Top Agents by Cost</h2>
        </div>
        {loading ? (
          <div style={{ padding: 24, color: "#888" }}>Loading...</div>
        ) : agents.length === 0 ? (
          <div style={{ padding: 24, color: "#888" }}>
            No data yet. Route your first LLM call through the proxy to see cost attribution here.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f9f9f9" }}>
                {["Agent ID", "Total Cost", "Requests", "Input Tokens", "Output Tokens", "Avg Cost/Req"].map((h) => (
                  <th key={h} style={{ padding: "8px 16px", textAlign: "left", fontSize: 13, color: "#666", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.agentId} style={{ borderTop: "1px solid #eee" }}>
                  <td style={{ padding: "10px 16px", fontSize: 13, fontFamily: "monospace" }}>{agent.agentId}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13 }}>{fmt(agent.totalCostUsd)}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13 }}>{fmtNum(agent.requestCount)}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13 }}>{fmtNum(agent.inputTokens)}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13 }}>{fmtNum(agent.outputTokens)}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13 }}>
                    {fmt(Number(agent.requestCount) > 0 ? Number(agent.totalCostUsd) / Number(agent.requestCount) : 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Bar chart */}
      {agents.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Cost by Agent</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={agents.slice(0, 10)}>
              <XAxis dataKey="agentId" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(3)}`} />
              <Tooltip formatter={(v: number) => [`$${Number(v).toFixed(6)}`, "Cost"]} />
              <Bar dataKey="totalCostUsd" fill="#0066ff" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "white", border: "1px solid #eee", borderRadius: 8, padding: 20 }}>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: -1 }}>{value}</div>
    </div>
  );
}
