import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findModelBackendConfigPath,
  readModelBackendConfig,
} from "../../dist/repair/model-backend-config.js";
import {
  modelBackend,
  modelBackendArgs,
  modelBackendCommand,
  modelBackendEnv,
} from "../../dist/repair/model-backend.js";

test("loads generic OpenAI-compatible backend config from a ClawSweeper file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-model-backend-"));
  const configPath = path.join(dir, "model-backend.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      backend: "openai-compatible-tools",
      base_url: "https://api.example.com/v1",
      model: "example/model",
      api_key_env: "EXAMPLE_API_KEY",
      max_turns: 10,
      max_tokens: 0,
      max_retries: 3,
    }),
  );

  const env = { CLAWSWEEPER_MODEL_BACKEND_CONFIG: configPath };
  assert.equal(findModelBackendConfigPath(env), configPath);
  assert.equal(readModelBackendConfig(env).backend, "openai-compatible-tools");
  assert.equal(modelBackend(env), "openai-compatible-tools");
  assert.equal(modelBackendCommand(env), process.execPath);
  assert.match(modelBackendArgs(["exec"], env)[0], /openai-compatible-tools-runner\.js$/);

  const out = modelBackendEnv(env);
  assert.equal(out.CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL, "https://api.example.com/v1");
  assert.equal(out.CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL, "example/model");
  assert.equal(out.CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV, "EXAMPLE_API_KEY");
  assert.equal(out.CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS, "10");
  assert.equal(out.CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TOKENS, "0");
  assert.equal(out.CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_RETRIES, "3");
});

test("environment values remain emergency overrides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-model-backend-"));
  const configPath = path.join(dir, "model-backend.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      backend: "openai-compatible-tools",
      base_url: "https://api.example.com/v1",
      model: "example/model",
      api_key_env: "EXAMPLE_API_KEY",
    }),
  );

  const env = {
    CLAWSWEEPER_MODEL_BACKEND_CONFIG: configPath,
    CLAWSWEEPER_MODEL_BACKEND: "codex-cli",
  };
  assert.equal(modelBackend(env), "codex-cli");
  assert.equal(modelBackendCommand(env), "codex");
  assert.deepEqual(modelBackendArgs(["exec"], env), ["exec"]);
  assert.equal(modelBackendEnv(env), env);

  const openAiEnv = {
    CLAWSWEEPER_MODEL_BACKEND_CONFIG: configPath,
    CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL: "override/model",
  };
  assert.equal(modelBackendEnv(openAiEnv).CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL, "override/model");
});


test("OpenAI-compatible backend passes GitHub token only to the deterministic helper channel", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-model-backend-"));
  const configPath = path.join(dir, "model-backend.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      backend: "openai-compatible-tools",
      base_url: "https://api.example.com/v1",
      model: "example/model",
      api_key_env: "EXAMPLE_API_KEY",
    }),
  );

  const strippedEnv = { CLAWSWEEPER_MODEL_BACKEND_CONFIG: configPath };
  const out = modelBackendEnv(strippedEnv, { GH_TOKEN: "ghp_test_token" });
  assert.equal(out.GH_TOKEN, undefined);
  assert.equal(out.GITHUB_TOKEN, undefined);
  assert.equal(out.CLAWSWEEPER_OPENAI_COMPATIBLE_GITHUB_TOKEN, "ghp_test_token");
});


test("OpenAI-compatible retry config requires positive integer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-model-backend-"));
  const configPath = path.join(dir, "model-backend.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      backend: "openai-compatible-tools",
      base_url: "https://api.example.com/v1",
      model: "example/model",
      api_key_env: "EXAMPLE_API_KEY",
      max_retries: 0,
    }),
  );
  assert.throws(() => readModelBackendConfig({ CLAWSWEEPER_MODEL_BACKEND_CONFIG: configPath }), /max_retries/);
});
