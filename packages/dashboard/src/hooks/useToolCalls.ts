import { useState, useEffect } from "react";
import { api, type ToolCallsResponse } from "../lib/api.js";

export function useToolCalls(opts: { agentId?: string; period?: string }) {
  const [data, setData] = useState<ToolCallsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      setLoading(true);
      setError(null);
      try {
        const callOpts: Parameters<typeof api.costs.toolCalls>[0] = { limit: 100 };
        if (opts.period) callOpts.period = opts.period;
        if (opts.agentId) callOpts.agentId = opts.agentId;
        const result = await api.costs.toolCalls(callOpts);
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(String(err));
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
  }, [opts.agentId, opts.period]);

  return { data, loading, error };
}
