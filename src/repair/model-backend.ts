import path from "node:path";
import type { JsonValue } from "./json-types.js";
import {
  normalizeBackend,
  readModelBackendConfig,
  type ModelBackend,
} from "./model-backend-config.js";
import { repoRoot } from "./paths.js";

export type { ModelBackend } from "./model-backend-config.js";

export function modelBackend(env: NodeJS.ProcessEnv = process.env): ModelBackend {
  if (env.CLAWSWEEPER_MODEL_BACKEND?.trim()) {
    return normalizeBackend(env.CLAWSWEEPER_MODEL_BACKEND, "codex-cli");
  }
  const config = readModelBackendConfig(env);
  return normalizeBackend(config.backend, "codex-cli");
}

export function modelBackendCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAWSWEEPER_MODEL_COMMAND?.trim()) {
    return env.CLAWSWEEPER_MODEL_COMMAND.trim();
  }
  return modelBackend(env) === "openai-compatible-tools" ? process.execPath : "codex";
}

export function modelBackendArgs(args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (modelBackend(env) !== "openai-compatible-tools") return args;
  return [path.join(repoRoot(), "dist/repair/openai-compatible-tools-runner.js"), ...args];
}

export function modelBackendEnv(
  env: NodeJS.ProcessEnv = process.env,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (modelBackend(env) !== "openai-compatible-tools") return env;
  const out = { ...env };
  restoreGitHubToken(out, parentEnv);
  const config = readModelBackendConfig(env).openaiCompatible ?? {};

  setIfMissing(out, "CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL", config.baseUrl);
  setIfMissing(out, "CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL", config.model);
  setIfMissing(out, "CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS", numberSetting(config.maxTurns));
  setIfMissing(out, "CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TOKENS", numberSetting(config.maxTokens));
  setIfMissing(out, "CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_RETRIES", numberSetting(config.maxRetries));

  const apiKeyEnv =
    out.CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV ||
    out.OPENAI_COMPATIBLE_API_KEY_ENV ||
    config.apiKeyEnv ||
    "OPENAI_API_KEY";
  out.CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV = apiKeyEnv;
  return out;
}

export function modelBackendLabel(defaultLabel: JsonValue = "model worker"): string {
  return modelBackend() === "openai-compatible-tools"
    ? "OpenAI-compatible tool worker"
    : String(defaultLabel);
}

function setIfMissing(env: NodeJS.ProcessEnv, key: string, value: string | undefined) {
  if (env[key] || value === undefined) return;
  env[key] = value;
}

function numberSetting(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function restoreGitHubToken(env: NodeJS.ProcessEnv, parentEnv: NodeJS.ProcessEnv) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || parentEnv.GH_TOKEN || parentEnv.GITHUB_TOKEN;
  if (!token) return;
  if (!env.GH_TOKEN) env.GH_TOKEN = token;
  if (!env.GITHUB_TOKEN) env.GITHUB_TOKEN = token;
}
