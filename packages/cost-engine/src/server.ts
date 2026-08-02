import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = parseInt(process.env["PORT"] ?? "3002", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[cost-engine] listening on http://localhost:${info.port}`);
});
