import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Redis } from "ioredis";

export const SSE_CHANNEL = "cost:live";

export function createSseRouter(redis: Redis) {
  const app = new Hono();

  // GET /api/events/stream — SSE for real-time cost updates
  app.get("/api/events/stream", (c) => {
    return streamSSE(c, async (stream) => {
      // Each SSE connection gets its own subscriber instance
      const sub = redis.duplicate();
      await sub.subscribe(SSE_CHANNEL);

      const onMessage = async (_channel: string, message: string) => {
        await stream.writeSSE({ data: message, event: "cost" });
      };

      sub.on("message", onMessage);

      // Keep alive ping every 30s
      const ping = setInterval(async () => {
        await stream.writeSSE({ data: "", event: "ping" });
      }, 30_000);

      // Clean up when client disconnects
      stream.onAbort(() => {
        clearInterval(ping);
        sub.off("message", onMessage);
        sub.disconnect();
      });

      // Block until abort
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
    });
  });

  return app;
}
