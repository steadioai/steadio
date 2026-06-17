import { useState } from "react";
import { Link } from "react-router-dom";
import { useRunaways, useBudgets } from "../hooks/useAttribution.js";

const CARD: React.CSSProperties = {
  background: "white",
  border: "1px solid #eee",
  borderRadius: 8,
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmt(n: number | null | undefined) {
  return `$${Number(n ?? 0).toFixed(4)}`;
}

function TriggerBadge({ type }: { type: string }) {
  const color = type === "velocity" ? "#f6c90e" : "#e84855";
  const bg = type === "velocity" ? "#fffbeb" : "#fff0f0";
  return (
    <span style={{ background: bg, color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>
      {type}
    </span>
  );
}

function ActionBadge({ action }: { action: string }) {
  const color = action === "circuit_break" ? "#e84855" : "#0066ff";
  const bg = action === "circuit_break" ? "#fff0f0" : "#e8f0fe";
  return (
    <span style={{ background: bg, color, borderRadius: 4, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>
      {action.replace("_", " ")}
    </span>
  );
}

function UtilBar({ pct, warning }: { pct: number; warning: number }) {
  const color = pct >= 100 ? "#e84855" : pct >= warning ? "#f6c90e" : "#00c9a7";
  return (
    <div style={{ background: "#f0f0f0", borderRadius: 4, height: 6, width: "100%", minWidth: 80, overflow: "hidden" }}>
      <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: color }} />
    </div>
  );
}

export function AlertHistoryPage() {
  const [agentFilter, setAgentFilter] = useState("");
  const { data: runaways, loading: runawaysLoading, refresh } = useRunaways(
    agentFilter ? { agentId: agentFilter } : undefined
  );
  const { data: budgets } = useBudgets();

  // Combine runaway events and over-threshold budgets into a unified event timeline
  const budgetAlerts = budgets.filter((b) => b.utilizationPercent >= b.warningThresholdPercent);

  const totalAlerts = runaways.length + budgetAlerts.length;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Alert History</h1>
        <span style={{ fontSize: 13, color: "#888" }}>{totalAlerts} active alerts</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <input
            placeholder="Filter by agent ID…"
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            style={{ padding: "4px 10px", border: "1px solid #ddd", borderRadius: 4, fontSize: 13, width: 200 }}
          />
          <button onClick={refresh} style={{ padding: "4px 12px", border: "1px solid #ddd", borderRadius: 4, background: "white", cursor: "pointer", fontSize: 13 }}>
            Refresh
          </button>
        </div>
      </div>

      {/* Budget alerts section */}
      {budgetAlerts.length > 0 && (
        <div style={{ ...CARD, marginBottom: 24 }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid #eee", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚠️</span>
            <h2 style={{ margin: 0, fontSize: 15 }}>Budget Threshold Alerts</h2>
            <span style={{ fontSize: 12, color: "#888" }}>{budgetAlerts.length} budgets at or above threshold</span>
          </div>
          {budgetAlerts.map((b) => (
            <div key={b.id} style={{ padding: "14px 16px", borderBottom: "1px solid #f5f5f5", display: "grid", gridTemplateColumns: "1fr auto auto 200px", alignItems: "center", gap: 16, fontSize: 13 }}>
              <div>
                <div style={{ fontFamily: "monospace", fontSize: 12, color: "#555" }}>{b.scope}: {b.scopeId}</div>
                <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{b.period} period • {b.enforcementMode} enforcement</div>
              </div>
              <div style={{ fontWeight: 600 }}>{fmt(b.currentSpendUsd)}</div>
              <div style={{ color: "#888" }}>of {fmt(b.capUsd)}</div>
              <div>
                <UtilBar pct={b.utilizationPercent} warning={b.warningThresholdPercent} />
                <div style={{ fontSize: 11, color: b.utilizationPercent >= 100 ? "#e84855" : "#f6c90e", marginTop: 3, fontWeight: 600 }}>
                  {b.utilizationPercent.toFixed(1)}%
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Runaway events */}
      <div style={CARD}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #eee", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>🔴</span>
          <h2 style={{ margin: 0, fontSize: 15 }}>Runaway & Circuit Breaker Events</h2>
        </div>

        {runawaysLoading ? (
          <div style={{ padding: 24, color: "#888" }}>Loading…</div>
        ) : runaways.length === 0 ? (
          <div style={{ padding: 40, color: "#aaa", textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
            <div>No runaway events detected. All agents operating normally.</div>
          </div>
        ) : (
          <div>
            <div style={{ padding: "8px 16px", background: "#f9f9f9", display: "grid", gridTemplateColumns: "140px 1fr 100px 120px 100px auto", gap: 12, fontSize: 12, color: "#888", fontWeight: 600 }}>
              <span>Time</span>
              <span>Agent</span>
              <span>Trigger</span>
              <span>Action</span>
              <span>Est. Cost</span>
              <span>Cooldown Until</span>
            </div>
            {runaways.map((r) => (
              <div key={r.id} style={{ padding: "12px 16px", borderTop: "1px solid #eee", display: "grid", gridTemplateColumns: "140px 1fr 100px 120px 100px auto", gap: 12, alignItems: "center", fontSize: 13 }}>
                <span style={{ fontSize: 11, color: "#888", whiteSpace: "nowrap" }}>{fmtDate(r.detectedAt)}</span>
                <div>
                  <Link
                    to={`/agents/${encodeURIComponent(r.agentId)}`}
                    style={{ color: "#0066ff", textDecoration: "none", fontFamily: "monospace", fontSize: 12 }}
                  >
                    {r.agentId.length > 20 ? `${r.agentId.slice(0, 10)}…${r.agentId.slice(-8)}` : r.agentId}
                  </Link>
                  <div style={{ fontSize: 11, color: "#aaa" }}>team: {r.teamId.length > 16 ? r.teamId.slice(0, 14) + "…" : r.teamId}</div>
                </div>
                <TriggerBadge type={r.triggerType} />
                <ActionBadge action={r.actionTaken} />
                <span style={{ color: "#e84855", fontWeight: 600 }}>{fmt(r.estimatedCostUsd)}</span>
                <span style={{ fontSize: 11, color: "#888" }}>
                  {r.overriddenAt
                    ? <span style={{ color: "#00c9a7" }}>overridden</span>
                    : r.cooldownUntil
                    ? fmtDate(r.cooldownUntil)
                    : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
