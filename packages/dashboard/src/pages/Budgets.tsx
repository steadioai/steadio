import { useState, useEffect, useCallback } from "react";
import { api, type BudgetRow } from "../lib/api.js";

const SCOPES = ["team", "agent"] as const;
const PERIODS = ["daily", "weekly", "monthly"] as const;
const ENFORCEMENT_MODES = ["alert", "throttle", "kill"] as const;

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const color = clamped >= 90 ? "#e53e3e" : clamped >= 75 ? "#d97706" : "#0066ff";
  return (
    <div style={{ background: "#f0f0f0", borderRadius: 4, height: 8, width: "100%", minWidth: 80 }}>
      <div
        style={{
          width: `${clamped}%`,
          background: color,
          height: "100%",
          borderRadius: 4,
          transition: "width 0.3s ease",
        }}
      />
    </div>
  );
}

const DEFAULT_FORM = {
  scope: "team" as string,
  scopeId: "",
  period: "monthly" as string,
  capUsd: "",
  warningThresholdPercent: "80",
  enforcementMode: "alert" as string,
};

export function BudgetsPage() {
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.budgets.list();
      setBudgets(result.budgets);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const cap = parseFloat(form.capUsd);
    if (isNaN(cap) || cap <= 0) {
      setFormError("Cap must be a positive number.");
      return;
    }
    if (!form.scopeId.trim()) {
      setFormError("Scope ID is required.");
      return;
    }
    setSubmitting(true);
    try {
      await api.budgets.create({
        scope: form.scope,
        scopeId: form.scopeId.trim(),
        period: form.period,
        capUsd: cap,
        warningThresholdPercent: parseInt(form.warningThresholdPercent, 10) || 80,
        enforcementMode: form.enforcementMode,
      });
      setForm(DEFAULT_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await api.budgets.delete(id);
      await load();
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Budget Management</h1>
        <button
          onClick={() => { setShowForm(true); setFormError(null); }}
          style={{
            marginLeft: "auto",
            padding: "8px 16px",
            background: "#0066ff",
            color: "white",
            border: "none",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + New Budget
        </button>
      </div>

      {showForm && (
        <div
          style={{
            background: "white",
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 24,
            marginBottom: 24,
          }}
        >
          <h2 style={{ margin: "0 0 16px", fontSize: 16 }}>Create Budget</h2>
          <form onSubmit={(e) => void handleCreate(e)}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Scope
                <select
                  value={form.scope}
                  onChange={(e) => setForm({ ...form, scope: e.target.value })}
                  style={inputStyle}
                >
                  {SCOPES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Scope ID
                <input
                  type="text"
                  placeholder="team-id or agent-id"
                  value={form.scopeId}
                  onChange={(e) => setForm({ ...form, scopeId: e.target.value })}
                  style={inputStyle}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Period
                <select
                  value={form.period}
                  onChange={(e) => setForm({ ...form, period: e.target.value })}
                  style={inputStyle}
                >
                  {PERIODS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Cap (USD)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="10.00"
                  value={form.capUsd}
                  onChange={(e) => setForm({ ...form, capUsd: e.target.value })}
                  style={inputStyle}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Warning Threshold (%)
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={form.warningThresholdPercent}
                  onChange={(e) => setForm({ ...form, warningThresholdPercent: e.target.value })}
                  style={inputStyle}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Enforcement Mode
                <select
                  value={form.enforcementMode}
                  onChange={(e) => setForm({ ...form, enforcementMode: e.target.value })}
                  style={inputStyle}
                >
                  {ENFORCEMENT_MODES.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            </div>

            {formError && (
              <div style={{ color: "#e53e3e", fontSize: 13, marginTop: 12 }}>{formError}</div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button
                type="submit"
                disabled={submitting}
                style={{
                  padding: "8px 16px",
                  background: submitting ? "#aaa" : "#0066ff",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 14,
                  cursor: submitting ? "not-allowed" : "pointer",
                }}
              >
                {submitting ? "Creating..." : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                style={{
                  padding: "8px 16px",
                  background: "white",
                  color: "#333",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div style={{ background: "white", border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 24, color: "#888" }}>Loading...</div>
        ) : error ? (
          <div style={{ padding: 24, color: "#e53e3e" }}>{error}</div>
        ) : budgets.length === 0 ? (
          <div style={{ padding: 24, color: "#888" }}>
            No budgets configured. Create one to enforce spending limits on agents or teams.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f9f9f9" }}>
                {["Scope", "Scope ID", "Period", "Limit", "Enforcement", "Current Spend", "Utilization", ""].map((h) => (
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
                ))}
              </tr>
            </thead>
            <tbody>
              {budgets.map((b) => (
                <tr key={b.id} style={{ borderTop: "1px solid #eee" }}>
                  <td style={{ padding: "12px 16px", fontSize: 13 }}>
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 4,
                        background: b.scope === "team" ? "#e8f0fe" : "#fef3c7",
                        color: b.scope === "team" ? "#1a56db" : "#92400e",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {b.scope}
                    </span>
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13, fontFamily: "monospace" }}>
                    {b.scopeId}
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13, textTransform: "capitalize" }}>
                    {b.period}
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600 }}>
                    ${Number(b.capUsd).toFixed(2)}
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13 }}>
                    <EnforcementBadge mode={b.enforcementMode} />
                  </td>
                  <td style={{ padding: "12px 16px", fontSize: 13 }}>
                    ${Number(b.currentSpendUsd).toFixed(4)}
                  </td>
                  <td style={{ padding: "12px 16px", minWidth: 160 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <ProgressBar percent={b.utilizationPercent} />
                      <span style={{ fontSize: 11, color: "#888" }}>
                        {Number(b.utilizationPercent).toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <button
                      onClick={() => void handleDelete(b.id)}
                      disabled={deletingId === b.id}
                      style={{
                        padding: "4px 10px",
                        background: "white",
                        color: deletingId === b.id ? "#aaa" : "#e53e3e",
                        border: `1px solid ${deletingId === b.id ? "#ddd" : "#e53e3e"}`,
                        borderRadius: 4,
                        fontSize: 12,
                        cursor: deletingId === b.id ? "not-allowed" : "pointer",
                      }}
                    >
                      {deletingId === b.id ? "Deleting..." : "Delete"}
                    </button>
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

function EnforcementBadge({ mode }: { mode: string }) {
  const styles: Record<string, { bg: string; color: string }> = {
    alert: { bg: "#e8f4fd", color: "#1a56db" },
    throttle: { bg: "#fef3c7", color: "#92400e" },
    kill: { bg: "#fee2e2", color: "#991b1b" },
  };
  const s = styles[mode] ?? { bg: "#f0f0f0", color: "#333" };
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 4,
        background: s.bg,
        color: s.color,
        fontSize: 12,
        fontWeight: 600,
        textTransform: "capitalize",
      }}
    >
      {mode}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ddd",
  borderRadius: 4,
  fontSize: 13,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};
