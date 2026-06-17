import { useState, useEffect, useCallback } from "react";
import { api, type AgentRow, type AttributionSummary, type AgentDetail, type TeamRow, type HistoryBucket, type BudgetRow, type RunawayEvent, type LiveCostEvent } from "../lib/api.js";

export function useAgentAttribution(period = "7d", teamId?: string) {
  const [data, setData] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.attribution.agents(teamId, period);
      setData(result.agents);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [period, teamId]);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return { data, loading, error, refresh: load };
}

export function useSummary(opts: { agentId?: string; period?: string; teamId?: string }) {
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
    const interval = setInterval(fetch, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [opts.agentId, opts.period, opts.teamId]);

  return { data, loading };
}

export function useAgentDetail(agentId: string, period = "7d") {
  const [data, setData] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      setLoading(true);
      try {
        const result = await api.attribution.agentDetail(agentId, period);
        if (!cancelled) { setData(result); setError(null); }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetch();
    const interval = setInterval(fetch, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [agentId, period]);

  return { data, loading, error };
}

export function useTeamAttribution(period = "7d") {
  const [data, setData] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      setLoading(true);
      try {
        const result = await api.attribution.teams(period);
        if (!cancelled) { setData(result.teams); setError(null); }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetch();
    const interval = setInterval(fetch, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [period]);

  return { data, loading, error };
}

export function useCostHistory(opts: { period?: string; agentId?: string; teamId?: string }) {
  const [data, setData] = useState<HistoryBucket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const result = await api.attribution.history(opts);
        if (!cancelled) setData(result.history);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetch();
    const interval = setInterval(fetch, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [opts.period, opts.agentId, opts.teamId]);

  return { data, loading };
}

export function useBudgets(scope?: string, scopeId?: string) {
  const [data, setData] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.budgets.list(scope, scopeId);
      setData(result.budgets);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [scope, scopeId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error, refresh: load };
}

export function useRunaways(opts?: { agentId?: string; teamId?: string }) {
  const [data, setData] = useState<RunawayEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await api.runaways.list(opts);
      setData(result.runaways);
    } finally {
      setLoading(false);
    }
  }, [opts?.agentId, opts?.teamId]);

  useEffect(() => {
    void load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return { data, loading, refresh: load };
}

export function useLiveStream(onEvent: (e: LiveCostEvent) => void) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/events/stream");

    es.addEventListener("cost", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data as string) as LiveCostEvent;
        onEvent(data);
      } catch { /* ignore malformed */ }
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      setConnected(false);
    };
  }, [onEvent]);

  return { connected };
}
