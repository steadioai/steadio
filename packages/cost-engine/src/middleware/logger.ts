import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

export function jsonLogger(service: string): MiddlewareHandler {
  return async (c, next) => {
    const requestId =
      c.req.header("x-request-id") ??
      c.req.header("x-steadio-request-id") ??
      randomUUID();

    c.set("requestId" as never, requestId);
    c.header("x-request-id", requestId);

    const start = Date.now();
    await next();
    const ms = Date.now() - start;

    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        service,
        requestId,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        ms,
      }) + "\n",
    );
  };
}
