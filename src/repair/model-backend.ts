import path from "node:path";
import type { JsonValue } from "./json-types.js";
import { repoRoot } from "./paths.js";

export type ModelBackend = "codex-cli" | "openai-compatible-tools";

export function modelBackend(): ModelBackend {
  const raw = String(process.env.CLAWSWEEPER_MODEL_BACKEND ?? "codex-cli")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (raw === "codex" || raw === "codex-cli") return "codex-cli";
  if (raw === "openai-compatible" || raw === "openai-compatible-tools")
    return "openai-compatible-tools";
  throw new Error(`unsupported CLAWSWEEPER_MODEL_BACKEND: ${raw}`);
}

export function modelBackendCommand(): string {
  if (process.env.CLAWSWEEPER_MODEL_COMMAND?.trim()) {
    return process.env.CLAWSWEEPER_MODEL_COMMAND.trim();
  }
  return modelBackend() === "openai-compatible-tools" ? process.execPath : "codex";
}

export function modelBackendArgs(args: string[]): string[] {
  if (modelBackend() !== "openai-compatible-tools") return args;
  return [path.join(repoRoot(), "dist/repair/openai-compatible-tools-runner.js"), ...args];
}

export function modelBackendEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (modelBackend() !== "openai-compatible-tools") return env;
  const out = { ...env };
  const apiKeyEnv =
    out.CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV ||
    out.OPENAI_COMPATIBLE_API_KEY_ENV ||
    "OPENAI_API_KEY";
  out.CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV = apiKeyEnv;
  return out;
}

export function modelBackendLabel(defaultLabel: JsonValue = "model worker"): string {
  return modelBackend() === "openai-compatible-tools"
    ? "OpenAI-compatible tool worker"
    : String(defaultLabel);
}
