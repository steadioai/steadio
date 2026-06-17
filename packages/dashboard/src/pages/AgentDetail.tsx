import { useParams, Link } from "react-router-dom";
import { useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid } from "recharts";
import { useAgentDetail, useBudgets, useCostHistory } from "../hooks/useAttribution.js";

const PERIODS = ["1d", "7d", "30d"] as const;
type Period = typeof PERIODS[number];

const COLORS = ["#0066ff", "#00c9a7", "#f6c90e", "#e84855", "#7b2d8b", "#ff6b6b"];

function fmt(n: number | null | undefined) {
  if (n == null) return "$0.00";
  return `$${Number(n).toFixed(4)}`;
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return "0";
  return Number(n).toLocaleString();
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString();
}

function truncateId(id: string) {
  return id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id;
}

const CARD: React.CSSProperties = {
  background: "white",
  border: "1px solid #eee",
  borderRadius: 8,
  padding: 20,
};

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={CARD}>
      <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: -1 }}>{value}</div>
    </div>
  );
}

function UtilBar({ pct, warning }: { pct: number; warning: number }) {
  const color = pct >= 100 ? "#e84855" : pct >= warning ? "#f6c90e" : "#00c9a7";
  return (
    <div style={{ background: "#f0f0f0", borderRadius: 4, height: 8, overflow: "hidden" }}>
      <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: color, transition: "width 0.3s" }} />
    </div>
  );
}

export function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const [period, setPeriod] = useState<Period>("7d");
  const { data, loading } = useAgentDetail(agentId!, period);
  const { data: budgets } = useBudgets("agent", agentId);
  const { data: history } = useCostHistory({ period, agentId });

  const historyFormatted = history.map((h) => ({
    label: period === "1d"
      ? new Date(h.bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(h.bucket).toLocaleDateString([], { month: "short", day: "numeric" }),
    cost: Number(h.totalCostUsd),
    requests: Number(h.requestCount),
  }));

  if (loading && !data) {
    return <div style={{ padding: 40, color: "#888" }}>Loading agent data…</div>;
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1200 }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/" style={{ color: "#0066ff", textDecoration: "none", fontSize: 13 }}>← Overview</Link>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Agent</h1>
          <code style={{ fontSize: 13, color: "#555", background: "#f5f5f5", padding: "2px 6px", borderRadius: 4 }}>{agentId}</code>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)} style={{ padding: "4px 12px", borderRadius: 4, border: "1px solid #ddd", background: p === period ? "#0066ff" : "white", color: p === period ? "white" : "#333", cursor: "pointer", fontSize: 13 }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Summary stats */}
      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
          <StatCard label="Total Spend" value={fmt(data.totals.totalCostUsd)} />
          <StatCard label="Requests" value={fmtNum(data.totals.requestCount)} />
          <StatCard label="Input Tokens" value={fmtNum(data.totals.inputTokens)} />
          <StatCard label="Output Tokens" value={fmtNum(data.totals.outputTokens)} />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
        {/* Cost trend */}
        <div style={CARD}>
          <h3 style={{ margin: "0 0 16px", fontSize: 14, color: "#555" }}>Cost Trend</h3>
          {historyFormatted.length === 0 ? (
            <div style={{ color: "#aaa", fontSize: 13, padding: "20px 0" }}>No history data</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={historyFormatted}>
                <defs>
                  <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0066ff" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#0066ff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v.toFixed(3)}`} />
                <Tooltip formatter={(v: number) => [`$${Number(v).toFixed(6)}`, "Cost"]} />
                <Area type="monotone" dataKey="cost" stroke="#0066ff" fill="url(#costGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* By model pie */}
        <div style={CARD}>
          <h3 style={{ margin: "0 0 16px", fontSize: 14, color: "#555" }}>Cost by Model</h3>
          {!data || data.byModel.length === 0 ? (
            <div style={{ color: "#aaa", fontSize: 13, padding: "20px 0" }}>No model data</div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <ResponsiveContainer width={180} height={180}>
                <PieChart>
                  <Pie data={data.byModel} dataKey="totalCostUsd" nameKey="model" cx="50%" cy="50%" outerRadius={80}>
                    {data.byModel.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => [`$${Number(v).toFixed(6)}`, "Cost"]} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ flex: 1, fontSize: 12 }}>
                {data.byModel.map((m, i) => (
                  <div key={m.model} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.model}>{m.model}</span>
                    <span style={{ fontWeight: 600, flexShrink: 0 }}>{fmt(m.totalCostUsd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Budget status */}
      {budgets.length > 0 && (
        <div style={{ ...CARD, marginBottom: 24 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 14, color: "#555" }}>Active Budgets</h3>
          <div style={{ display: "grid", gap: 12 }}>
            {budgets.map((b) => (
              <div key={b.id} style={{ border: "1px solid #eee", borderRadius: 6, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 13 }}>
                  <span>{b.period} • {b.enforcementMode}</span>
                  <span style={{ fontWeight: 600 }}>{fmt(b.currentSpendUsd)} / {fmt(b.capUsd)}</span>
                </div>
                <UtilBar pct={b.utilizationPercent} warning={b.warningThresholdPercent} />
                <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>{b.utilizationPercent.toFixed(1)}% utilized</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent requests */}
      <div style={CARD}>
        <h3 style={{ margin: "0 0 16px", fontSize: 14, color: "#555" }}>Recent Requests</h3>
        {!data || data.recent.length === 0 ? (
          <div style={{ color: "#aaa", fontSize: 13 }}>No requests yet</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f9f9f9" }}>
                {["Request ID", "Model", "Input", "Output", "Cost", "Latency", "Status", "Time"].map((h) => (
                  <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#666", fontWeight: 600, fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: 11 }}>{truncateId(r.requestId)}</td>
                  <td style={{ padding: "8px 12px" }}>{r.model}</td>
                  <td style={{ padding: "8px 12px" }}>{fmtNum(r.inputTokens)}</td>
                  <td style={{ padding: "8px 12px" }}>{fmtNum(r.outputTokens)}</td>
                  <td style={{ padding: "8px 12px" }}>{fmt(r.totalCostUsd)}</td>
                  <td style={{ padding: "8px 12px" }}>{r.latencyMs}ms</td>
                  <td style={{ padding: "8px 12px" }}>
                    <span style={{ color: r.statusCode === 200 ? "#00c9a7" : "#e84855", fontWeight: 600 }}>{r.statusCode}</span>
                  </td>
                  <td style={{ padding: "8px 12px", fontSize: 11, color: "#888" }}>{fmtDate(r.recordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
