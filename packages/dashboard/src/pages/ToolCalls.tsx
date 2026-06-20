import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { useToolCalls } from "../hooks/useToolCalls.js";

const PERIODS = ["1d", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtCost(n: number | null | undefined) {
  if (n == null || n === 0) return "-";
  return `$${Number(n).toFixed(6)}`;
}

const STATUS_COLOR: Record<string, string> = {
  success: "#22c55e",
  error: "#ef4444",
};

export function ToolCallsPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const [agentFilter, setAgentFilter] = useState("");

  const trimmedAgent = agentFilter.trim();
  const hookOpts: { period: Period; agentId?: string } = { period };
  if (trimmedAgent) hookOpts.agentId = trimmedAgent;

  const { data, loading, error } = useToolCalls(hookOpts);

  const toolCalls = data?.toolCalls ?? [];
  const topTools = data?.topTools ?? [];

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Tool Call Log</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            placeholder="Filter by agent ID…"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: "1px solid #ddd",
              fontSize: 13,
              width: 220,
            }}
          />
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

      {/* Summary bar */}
      {data && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 16,
            marginBottom: 32,
          }}
        >
          <StatCard label="Total Calls" value={String(data.total)} />
          <StatCard label="Unique Tools" value={String(topTools.length)} />
          <StatCard
            label="Error Rate"
            value={
              data.total > 0
                ? `${((topTools.reduce((s, t) => s + Number(t.errorCount), 0) / data.total) * 100).toFixed(1)}%`
                : "0%"
            }
          />
        </div>
      )}

      {/* Top tools chart */}
      {topTools.length > 0 && (
        <div
          style={{
            background: "white",
            border: "1px solid #eee",
            borderRadius: 8,
            padding: "20px 16px",
            marginBottom: 32,
          }}
        >
          <h2 style={{ margin: "0 0 16px", fontSize: 16 }}>Top Tools by Call Count</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              data={topTools.slice(0, 15)}
              margin={{ top: 0, right: 16, bottom: 40, left: 0 }}
            >
              <XAxis
                dataKey="toolName"
                tick={{ fontSize: 11 }}
                interval={0}
                angle={-35}
                textAnchor="end"
              />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                formatter={(value: number, name: string) => [
                  value,
                  name === "callCount" ? "Calls" : "Errors",
                ]}
              />
              <Bar dataKey="callCount" name="callCount" radius={[4, 4, 0, 0]}>
                {topTools.slice(0, 15).map((entry, i) => (
                  <Cell
                    key={i}
                    fill={Number(entry.errorCount) > 0 ? "#f97316" : "#0066ff"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tool call table */}
      <div
        style={{
          background: "white",
          border: "1px solid #eee",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px",
            borderBottom: "1px solid #eee",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>Recent Tool Calls</h2>
          {data && (
            <span style={{ fontSize: 13, color: "#888" }}>
              Showing {toolCalls.length} of {data.total}
            </span>
          )}
        </div>

        {error ? (
          <div style={{ padding: 24, color: "#ef4444" }}>Error: {error}</div>
        ) : loading ? (
          <div style={{ padding: 24, color: "#888" }}>Loading…</div>
        ) : toolCalls.length === 0 ? (
          <div style={{ padding: 24, color: "#888" }}>
            No tool calls yet. Route your first LLM call through the proxy and use tools to see data here.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f9f9f9" }}>
                  {["Timestamp", "Agent", "Tool Name", "Status", "Latency", "Est. Cost"].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          padding: "8px 16px",
                          textAlign: "left",
                          fontSize: 13,
                          color: "#666",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {toolCalls.map((tc) => (
                  <tr key={tc.id} style={{ borderTop: "1px solid #eee" }}>
                    <td
                      style={{
                        padding: "10px 16px",
                        fontSize: 12,
                        color: "#666",
                        whiteSpace: "nowrap",
                        fontFamily: "monospace",
                      }}
                    >
                      {fmtTime(tc.recordedAt)}
                    </td>
                    <td
                      style={{
                        padding: "10px 16px",
                        fontSize: 12,
                        fontFamily: "monospace",
                        maxWidth: 200,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={tc.agentId}
                    >
                      {tc.agentId}
                    </td>
                    <td
                      style={{
                        padding: "10px 16px",
                        fontSize: 13,
                        fontWeight: 500,
                      }}
                    >
                      {tc.toolName}
                    </td>
                    <td style={{ padding: "10px 16px" }}>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 12,
                          fontWeight: 600,
                          color: STATUS_COLOR[tc.resultStatus] ?? "#888",
                          background:
                            tc.resultStatus === "success" ? "#f0fdf4" : "#fef2f2",
                          padding: "2px 8px",
                          borderRadius: 999,
                        }}
                      >
                        {tc.resultStatus === "success" ? "✓" : "✗"} {tc.resultStatus}
                        {tc.errorType && (
                          <span style={{ fontWeight: 400, color: "#888" }}>
                            ({tc.errorType})
                          </span>
                        )}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "10px 16px",
                        fontSize: 13,
                        color: "#555",
                      }}
                    >
                      {tc.latencyMs != null ? `${tc.latencyMs}ms` : "-"}
                    </td>
                    <td
                      style={{
                        padding: "10px 16px",
                        fontSize: 13,
                        fontFamily: "monospace",
                        color: "#555",
                      }}
                    >
                      {fmtCost(tc.costUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #eee",
        borderRadius: 8,
        padding: 20,
      }}
    >
      <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: -1 }}>{value}</div>
    </div>
  );
}
