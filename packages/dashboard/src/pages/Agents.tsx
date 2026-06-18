import { useState } from "react";
import { Link } from "react-router-dom";
import { useAgentAttribution } from "../hooks/useAttribution.js";

const PERIODS = ["1d", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];

function fmt(n: number | undefined | null) {
  if (n == null) return "$0.00";
  return `$${Number(n).toFixed(4)}`;
}

function fmtNum(n: number | undefined | null) {
  if (n == null) return "0";
  return Number(n).toLocaleString();
}

export function AgentsPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const { data: agents, loading } = useAgentAttribution(period);

  return (
    <div style={{ padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Agents</h1>
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
                fontSize: 13,
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div style={{ background: "white", border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 24, color: "#888" }}>Loading...</div>
        ) : agents.length === 0 ? (
          <div style={{ padding: 24, color: "#888" }}>
            No agents yet. Route your first LLM call through the proxy to see agents here.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f9f9f9" }}>
                {["Agent ID", "Total Cost", "Requests", "Input Tokens", "Output Tokens", "Avg Cost/Req", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 16px", textAlign: "left", fontSize: 13, color: "#666", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.agentId} style={{ borderTop: "1px solid #eee" }}>
                  <td style={{ padding: "10px 16px", fontSize: 13, fontFamily: "monospace" }}>{agent.agentId}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13, fontWeight: 600 }}>{fmt(agent.totalCostUsd)}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13 }}>{fmtNum(agent.requestCount)}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13 }}>{fmtNum(agent.inputTokens)}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13 }}>{fmtNum(agent.outputTokens)}</td>
                  <td style={{ padding: "10px 16px", fontSize: 13 }}>
                    {fmt(Number(agent.requestCount) > 0 ? Number(agent.totalCostUsd) / Number(agent.requestCount) : 0)}
                  </td>
                  <td style={{ padding: "10px 16px" }}>
                    <Link to={`/agents/${encodeURIComponent(agent.agentId)}`} style={{ fontSize: 12, color: "#0066ff", textDecoration: "none" }}>
                      Detail →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
