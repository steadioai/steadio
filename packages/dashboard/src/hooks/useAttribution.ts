import { useState, useEffect } from "react";
import { api, type AgentRow, type AttributionSummary } from "../lib/api.js";

export function useAgentAttribution(period = "7d") {
  const [data, setData] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      setLoading(true);
      try {
        const result = await api.attribution.agents(undefined, period);
        if (!cancelled) setData(result.agents);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetch();
    const interval = setInterval(fetch, 60_000); // refresh every 60s
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [period]);

  return { data, loading, error };
}

export function useSummary(opts: { agentId?: string; period?: string }) {
  const [data, setData] = useState<AttributionSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const result = await api.attribution.summary(opts);
        if (!cancelled) setData(result.summary);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetch();
    return () => { cancelled = true; };
  }, [opts.agentId, opts.period]);

  return { data, loading };
}
