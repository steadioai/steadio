import { Hono } from "hono";
import { z } from "zod";
import { isOperatorContext, requireOperatorMiddleware } from "../middleware/operator-auth.js";
import {
  getModelPricingEntry,
  getWritablePricingFilePath,
  listModelPricing,
  setModelPricing,
} from "../pricing.js";

export const pricingRoutes = new Hono();

// Reads are available to any authenticated team member (see rates used by cost
// attribution). Mutations remain operator-only via requireOperatorMiddleware below.

const upsertPricingSchema = z.object({
  inputCentsPerMillionTokens: z.number().min(0),
  outputCentsPerMillionTokens: z.number().min(0),
  updatedBy: z.string().trim().min(1).optional(),
}).strict();

pricingRoutes.get("/", (c) => {
  const canEdit = isOperatorContext(c);
  return c.json({
    pricing: listModelPricing(),
    writableFile: canEdit ? getWritablePricingFilePath() : "",
    canEdit,
  });
});

pricingRoutes.get("/:model", (c) => {
  const model = c.req.param("model");
  const pricing = getModelPricingEntry(model);
  if (!pricing) {
    return c.json({
      model,
      configured: false,
      error: "missing_pricing",
      message: "No model pricing is configured. Add a custom rate before relying on cost attribution for this model.",
    }, 404);
  }

  return c.json({ configured: true, pricing });
});

pricingRoutes.put("/:model", requireOperatorMiddleware, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }

  const parsed = upsertPricingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.format() }, 400);
  }

  try {
    const pricing = setModelPricing(c.req.param("model") as string, {
      inputCentsPerMillionTokens: parsed.data.inputCentsPerMillionTokens,
      outputCentsPerMillionTokens: parsed.data.outputCentsPerMillionTokens,
    }, parsed.data.updatedBy ?? "operator");

    return c.json({ pricing });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update pricing";
    const status = message.includes("STEADIO_MODEL_PRICING_JSON") ? 409 : 400;
    return c.json({ error: "pricing_update_failed", message }, status);
  }
});
