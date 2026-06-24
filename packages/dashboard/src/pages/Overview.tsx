import { useState, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, CartesianGrid } from "recharts";
import { useAgentAttribution, useSummary, useCostHistory, useLiveStream } from "../hooks/useAttribution.js";
import type { LiveCostEvent } from "../lib/api.js";

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

const MAX_LIVE = 10;

export function OverviewPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const [liveEvents, setLiveEvents] = useState<LiveCostEvent[]>([]);
  const liveRef = useRef<LiveCostEvent[]>([]);

  const { data: agents, loading } = useAgentAttribution(period);
  const { data: summary } = useSummary({ period });
  const { data: history } = useCostHistory({ period });

  const onLive = useCallback((e: LiveCostEvent) => {
    liveRef.current = [e, ...liveRef.current].slice(0, MAX_LIVE);
    setLiveEvents([...liveRef.current]);
  }, []);
  const { connected } = useLiveStream(onLive);

  const historyFormatted = history.map((h) => ({
    label: period === "1d"
      ? new Date(h.bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(h.bucket).toLocaleDateString([], { month: "short", day: "numeric" }),
    cost: Number(h.totalCostUsd),
    requests: Number(h.requestCount),
  }));

  return (
    <div style={{ padding: "28px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.5px" }}>Overview</h1>

        {/* Live indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: connected ? "#00c9a7" : "#aaa" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "#00c9a7" : "#ddd", animation: connected ? "pulse 2s infinite" : "none" }} />
          {connected ? "Live" : "Connecting…"}
        </div>

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

      {/* Summary cards */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
          <StatCard label="Total Spend" value={fmt(summary.totalCostUsd)} />
          <StatCard label="Requests" value={fmtNum(summary.requestCount)} />
          <StatCard label="Input Tokens" value={fmtNum(summary.inputTokens)} />
          <StatCard label="Output Tokens" value={fmtNum(summary.outputTokens)} />
        </div>
      )}

      {/* Cost trend chart */}
      {historyFormatted.length > 0 && (
        <div style={{ background: "white", border: "1px solid rgba(0,0,0,0.06)", borderRadius: 12, padding: "22px 24px", marginBottom: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <h2 style={{ margin: "0 0 16px", fontSize: 14, color: "#64748b", fontWeight: 600 }}>Cost Trend</h2>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={historyFormatted}>
              <defs>
                <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0066ff" stopOpacity={0.12} />
                  <stop offset="95%" stopColor="#0066ff" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(3)}`} />
              <Tooltip formatter={(v: number) => [`$${Number(v).toFixed(6)}`, "Cost"]} />
              <Area type="monotone" dataKey="cost" stroke="#0066ff" fill="url(#trendGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Live event feed */}
      {liveEvents.length > 0 && (
        <div style={{ background: "white", border: "1px solid rgba(0,0,0,0.06)", borderRadius: 12, marginBottom: 24, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00c9a7" }} />
            <h2 style={{ margin: 0, fontSize: 14, color: "#64748b", fontWeight: 600 }}>Live Cost Events</h2>
          </div>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {liveEvents.map((e, i) => (
              <div key={i} style={{ padding: "8px 16px", borderTop: i > 0 ? "1px solid #f5f5f5" : undefined, display: "flex", gap: 16, fontSize: 12, alignItems: "center" }}>
                <span style={{ color: "#aaa", fontFamily: "monospace" }}>
                  {new Date(e.recordedAt).toLocaleTimeString()}
                </span>
                <span style={{ fontFamily: "monospace", color: "#555", flex: 1 }}>
                  {e.agentId.length > 20 ? `${e.agentId.slice(0, 10)}…${e.agentId.slice(-8)}` : e.agentId}
                </span>
                <span style={{ color: "#888" }}>{e.model}</span>
                <span style={{ fontWeight: 600, color: "#0066ff" }}>{fmt(e.totalCostUsd)}</span>
                <span style={{ color: "#aaa" }}>{fmtNum(e.inputTokens)}↑ {fmtNum(e.outputTokens)}↓</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent table */}
      <div style={{ background: "white", border: "1px solid rgba(0,0,0,0.06)", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ padding: "18px 24px", borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0f172a" }}>Top Agents by Cost</h2>
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
                      View →
                    </Link>
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
    <div style={{
      background: "white",
      border: "1px solid rgba(0,0,0,0.06)",
      borderRadius: 12,
      padding: "22px 24px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 8, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: -1, color: "#0f172a" }}>{value}</div>
    </div>
  );
}
