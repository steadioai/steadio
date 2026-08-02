import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUNDLED_MODEL_PRICING } from "./model-pricing.generated.js";

// Token pricing table — costs in USD per 1M tokens, stored as fractional cents
// Prices sourced from provider public pricing pages

export interface ModelPricing {
  inputCentsPerMillionTokens: number;
  outputCentsPerMillionTokens: number;
  updatedAt?: string;
  updatedBy?: string;
}

type PricingTable = Record<string, ModelPricing>;
export type ModelPricingSource = "built_in" | "bundled" | "file" | "environment";

export interface ModelPricingEntry extends ModelPricing {
  model: string;
  source: ModelPricingSource;
  overridden: boolean;
}

const DEFAULT_PRICING_TABLE: PricingTable = {
  // Anthropic Claude
  "claude-opus-4-8": { inputCentsPerMillionTokens: 1500, outputCentsPerMillionTokens: 7500 },
  "claude-sonnet-4-6": { inputCentsPerMillionTokens: 300, outputCentsPerMillionTokens: 1500 },
  "claude-haiku-4-5-20251001": { inputCentsPerMillionTokens: 80, outputCentsPerMillionTokens: 400 },
  // OpenAI
  "gpt-4o": { inputCentsPerMillionTokens: 250, outputCentsPerMillionTokens: 1000 },
  "gpt-4o-mini": { inputCentsPerMillionTokens: 15, outputCentsPerMillionTokens: 60 },
  "gpt-4-turbo": { inputCentsPerMillionTokens: 1000, outputCentsPerMillionTokens: 3000 },
  "gpt-3.5-turbo": { inputCentsPerMillionTokens: 50, outputCentsPerMillionTokens: 150 },
  // Gemini
  "gemini-2.0-flash": { inputCentsPerMillionTokens: 10, outputCentsPerMillionTokens: 40 },
  "gemini-1.5-pro": { inputCentsPerMillionTokens: 125, outputCentsPerMillionTokens: 500 },
};

interface PricingSnapshot {
  table: PricingTable;
  entries: ModelPricingEntry[];
  envOverrides: PricingTable;
  bundledBaseline: PricingTable;
}

let cachedPricingSnapshot: PricingSnapshot | undefined;
let cachedPricingSource: string | undefined;

export function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getPricing(model);
  if (!pricing) {
    return 0;
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCentsPerMillionTokens;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCentsPerMillionTokens;
  return Math.ceil(inputCost + outputCost);
}

export function getPricing(model: string): ModelPricing | undefined {
  return getPricingSnapshot().table[model];
}

export function getKnownModels(): string[] {
  return Object.keys(getPricingSnapshot().table);
}

export function listModelPricing(): ModelPricingEntry[] {
  return getPricingSnapshot().entries;
}

export function getModelPricingEntry(model: string): ModelPricingEntry | undefined {
  return listModelPricing().find((entry) => entry.model === model);
}

export function getWritablePricingFilePath(): string {
  return resolve(
    process.env["STEADIO_MODEL_PRICING_MANAGEMENT_FILE"]
      ?? process.env["STEADIO_MODEL_PRICING_FILE"]
      ?? ".steadio-model-pricing.json",
  );
}

export function setModelPricing(
  model: string,
  pricing: Omit<ModelPricing, "updatedAt" | "updatedBy">,
  updatedBy = "operator",
): ModelPricingEntry {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error("Model name is required");
  }
  if (!isValidRate(pricing.inputCentsPerMillionTokens) || !isValidRate(pricing.outputCentsPerMillionTokens)) {
    throw new Error("inputCentsPerMillionTokens and outputCentsPerMillionTokens must be non-negative numbers");
  }

  const snapshot = getPricingSnapshot();
  if (snapshot.envOverrides[normalizedModel]) {
    throw new Error(
      `Model ${normalizedModel} is controlled by STEADIO_MODEL_PRICING_JSON and cannot be changed through the management API`,
    );
  }

  const filePath = getWritablePricingFilePath();
  const currentFileTable = existsSync(filePath)
    ? parsePricingJson(readFileSync(filePath, "utf8"), filePath)
    : {};
  const updatedAt = new Date().toISOString();
  const nextFileTable: PricingTable = {
    ...currentFileTable,
    [normalizedModel]: {
      inputCentsPerMillionTokens: pricing.inputCentsPerMillionTokens,
      outputCentsPerMillionTokens: pricing.outputCentsPerMillionTokens,
      updatedAt,
      updatedBy,
    },
  };

  writeFileSync(filePath, JSON.stringify(nextFileTable, null, 2) + "\n");
  cachedPricingSnapshot = undefined;
  cachedPricingSource = undefined;

  const entry = getModelPricingEntry(normalizedModel);
  if (!entry) {
    throw new Error(`Failed to load updated pricing for ${normalizedModel}`);
  }
  return entry;
}

function getPricingSnapshot(): PricingSnapshot {
  const source = getPricingSourceFingerprint();
  if (cachedPricingSnapshot && cachedPricingSource === source) {
    return cachedPricingSnapshot;
  }

  const bundledBaseline = loadBundledBaseline();
  const fileOverrides = loadPricingFileOverrides();
  const envOverrides = loadPricingJsonOverrides();
  const table = { ...DEFAULT_PRICING_TABLE, ...bundledBaseline, ...fileOverrides, ...envOverrides };
  cachedPricingSnapshot = {
    table,
    entries: buildPricingEntries(bundledBaseline, fileOverrides, envOverrides),
    envOverrides,
    bundledBaseline,
  };
  cachedPricingSource = source;
  return cachedPricingSnapshot;
}

function getPricingSourceFingerprint(): string {
  const pricingFile = getReadablePricingFilePath();
  const fileMtime = pricingFile && existsSync(pricingFile)
    ? statSync(pricingFile).mtimeMs.toString()
    : "";
  return [
    pricingFile ?? "",
    fileMtime,
    process.env["STEADIO_MODEL_PRICING_MANAGEMENT_FILE"] ?? "",
    process.env["STEADIO_MODEL_PRICING_JSON"] ?? "",
  ].join("\0");
}

// The committed OpenAI/Anthropic baseline snapshot (regenerated on a schedule by
// scripts/refresh-model-pricing.mjs). Imported as a typed module so it survives
// bundler/serverless file-tracing; validated defensively so a malformed generated
// module degrades to DEFAULT_PRICING_TABLE rather than breaking cost attribution.
function loadBundledBaseline(): PricingTable {
  try {
    return parsePricingTable(BUNDLED_MODEL_PRICING as unknown, "model-pricing.generated.ts");
  } catch (err) {
    console.warn(`[pricing] ignoring bundled pricing module: ${(err as Error).message}`);
    return {};
  }
}

function getReadablePricingFilePath(): string | undefined {
  const configured = process.env["STEADIO_MODEL_PRICING_FILE"];
  if (configured) return configured;

  const managementFile = process.env["STEADIO_MODEL_PRICING_MANAGEMENT_FILE"];
  if (managementFile && existsSync(managementFile)) return managementFile;

  const defaultFile = getWritablePricingFilePath();
  return existsSync(defaultFile) ? defaultFile : undefined;
}

function loadPricingFileOverrides(): PricingTable {
  const pricingFile = getReadablePricingFilePath();
  if (pricingFile) {
    return parsePricingJson(readFileSync(pricingFile, "utf8"), pricingFile);
  }
  return {};
}

function loadPricingJsonOverrides(): PricingTable {
  const pricingJson = process.env["STEADIO_MODEL_PRICING_JSON"];
  if (pricingJson) {
    return parsePricingJson(pricingJson, "STEADIO_MODEL_PRICING_JSON");
  }
  return {};
}

function buildPricingEntries(
  bundledBaseline: PricingTable,
  fileOverrides: PricingTable,
  envOverrides: PricingTable,
): ModelPricingEntry[] {
  const models = new Set([
    ...Object.keys(DEFAULT_PRICING_TABLE),
    ...Object.keys(bundledBaseline),
    ...Object.keys(fileOverrides),
    ...Object.keys(envOverrides),
  ]);

  return Array.from(models)
    .sort()
    .map((model) => {
      const source: ModelPricingSource = envOverrides[model]
        ? "environment"
        : fileOverrides[model]
          ? "file"
          : bundledBaseline[model]
            ? "bundled"
            : "built_in";
      const pricing =
        envOverrides[model] ?? fileOverrides[model] ?? bundledBaseline[model] ?? DEFAULT_PRICING_TABLE[model];
      if (!pricing) {
        throw new Error(`Pricing table is missing rate data for ${model}`);
      }
      // "overridden" flags an operator (file/env) rate replacing a shipped rate
      // (built-in or bundled). The scheduled bundled refresh is not an operator override.
      const shipped = Boolean(DEFAULT_PRICING_TABLE[model]) || Boolean(bundledBaseline[model]);
      return {
        model,
        ...pricing,
        source,
        overridden: (source === "environment" || source === "file") && shipped,
      };
    });
}

function parsePricingJson(raw: string, source: string): PricingTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid model pricing JSON from ${source}: ${(err as Error).message}`);
  }
  return parsePricingTable(parsed, source);
}

function parsePricingTable(parsed: unknown, source: string): PricingTable {
  if (!isRecord(parsed)) {
    throw new Error(`Invalid model pricing from ${source}: expected an object keyed by model name`);
  }

  const table: PricingTable = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      throw new Error(`Invalid pricing for ${model} from ${source}: expected an object`);
    }

    const input = value["inputCentsPerMillionTokens"];
    const output = value["outputCentsPerMillionTokens"];
    if (!isValidRate(input) || !isValidRate(output)) {
      throw new Error(
        `Invalid pricing for ${model} from ${source}: inputCentsPerMillionTokens and outputCentsPerMillionTokens must be non-negative numbers`,
      );
    }

    const pricing: ModelPricing = {
      inputCentsPerMillionTokens: input,
      outputCentsPerMillionTokens: output,
    };
    if (typeof value["updatedAt"] === "string") pricing.updatedAt = value["updatedAt"];
    if (typeof value["updatedBy"] === "string") pricing.updatedBy = value["updatedBy"];

    table[model] = pricing;
  }

  return table;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
