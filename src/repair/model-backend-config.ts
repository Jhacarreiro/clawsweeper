import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { repoRoot } from "./paths.js";

export type ModelBackend = "codex-cli" | "openai-compatible-tools";

export type OpenAiCompatibleConfig = {
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  maxTurns?: number;
  maxTokens?: number;
  maxRetries?: number;
};

export type ModelBackendConfig = {
  backend?: ModelBackend;
  openaiCompatible?: OpenAiCompatibleConfig;
  sourcePath?: string;
};

const DEFAULT_LOCAL_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "clawsweeper",
  "model-backend.json",
);

export function readModelBackendConfig(env: NodeJS.ProcessEnv = process.env): ModelBackendConfig {
  const configPath = findModelBackendConfigPath(env);
  if (!configPath) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  return { ...normalizeModelBackendConfig(parsed, configPath), sourcePath: configPath };
}

export function findModelBackendConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.CLAWSWEEPER_MODEL_BACKEND_CONFIG ?? "").trim();
  if (explicit) return path.resolve(expandHome(explicit));

  const candidates = [
    DEFAULT_LOCAL_CONFIG_PATH,
    path.join(repoRoot(), "config", "model-backend.json"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "";
}

export function normalizeBackend(
  value: JsonValue,
  fallback: ModelBackend = "codex-cli",
): ModelBackend {
  const raw = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (raw === "codex" || raw === "codex-cli") return "codex-cli";
  if (raw === "openai-compatible" || raw === "openai-compatible-tools") {
    return "openai-compatible-tools";
  }
  throw new Error(`unsupported model backend: ${raw}`);
}

function normalizeModelBackendConfig(value: unknown, label: string): ModelBackendConfig {
  const config = record(value, label);
  const backend = normalizeBackend(config.backend ?? config.default_backend, "codex-cli");
  const nestedOpenaiCompatible = optionalRecord(
    config.openai_compatible ?? config.openaiCompatible,
    `${label}.openai_compatible`,
  );
  const openaiSource = nestedOpenaiCompatible ?? config;
  const openaiConfig: OpenAiCompatibleConfig = {};
  setOptional(
    openaiConfig,
    "baseUrl",
    optionalString(openaiSource.base_url ?? openaiSource.baseUrl),
  );
  setOptional(openaiConfig, "model", optionalString(openaiSource.model));
  setOptional(
    openaiConfig,
    "apiKeyEnv",
    optionalString(openaiSource.api_key_env ?? openaiSource.apiKeyEnv ?? openaiSource.key_env),
  );
  setOptional(
    openaiConfig,
    "maxTurns",
    optionalInteger(openaiSource.max_turns ?? openaiSource.maxTurns, {
      label: `${label}.max_turns`,
      minimum: 0,
    }),
  );
  setOptional(
    openaiConfig,
    "maxTokens",
    optionalInteger(openaiSource.max_tokens ?? openaiSource.maxTokens, {
      label: `${label}.max_tokens`,
      minimum: 0,
    }),
  );
  setOptional(
    openaiConfig,
    "maxRetries",
    optionalInteger(openaiSource.max_retries ?? openaiSource.maxRetries, {
      label: `${label}.max_retries`,
      minimum: 1,
    }),
  );

  const result: ModelBackendConfig = { backend };
  if (Object.keys(openaiConfig).length > 0) result.openaiCompatible = openaiConfig;
  return result;
}

function record(value: unknown, label: string): LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid model backend config ${label}: expected object`);
  }
  return value as LooseRecord;
}

function optionalRecord(value: JsonValue, label: string): LooseRecord | undefined {
  if (value === undefined || value === null) return undefined;
  return record(value, label);
}

function optionalString(value: JsonValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function optionalInteger(
  value: JsonValue,
  { label, minimum }: { label: string; minimum: number },
): number | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return number;
}

function setOptional<K extends keyof OpenAiCompatibleConfig>(
  config: OpenAiCompatibleConfig,
  key: K,
  value: OpenAiCompatibleConfig[K] | undefined,
) {
  if (value !== undefined) config[key] = value;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
