import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(
  path.join(process.cwd(), "src/repair/openai-compatible-tools-runner.ts"),
  "utf8",
);

test("OpenAI-compatible runner rewrites gh pr view review context to REST endpoints", () => {
  assert.match(source, /function rewriteUnsupportedGhPrView/);
  assert.match(source, /gh_api_rest_rewrite/);
  assert.match(source, /pulls\/\$\{pr\}\/comments/);
  assert.match(source, /pulls\/\$\{pr\}\/reviews/);
  assert.match(source, /issues\/\$\{pr\}\/comments/);
  assert.match(source, /git remote get-url origin/);
  assert.match(source, /repo_inference_failed/);
});

test("OpenAI-compatible runner enforces read-only sandbox tool boundaries", () => {
  assert.match(source, /const readOnlySandbox = sandbox === "read-only"/);
  assert.match(source, /github_pr_context/);
  assert.match(source, /const readOnlyToolNames = new Set/);
  assert.match(source, /allTools\.filter\(\(toolEntry\) => readOnlyToolNames\.has\(toolEntry\.function\.name\)\)/);
  assert.match(source, /tool not allowed by sandbox/);
});

test("OpenAI-compatible runner keeps GitHub token out of model shell while allowing deterministic GitHub helper", () => {
  assert.match(source, /const githubToken =/);
  assert.match(source, /delete process\.env\.GH_TOKEN/);
  assert.match(source, /function githubPrContext/);
  assert.match(source, /spawnSync\("gh", \["api", apiPath\]/);
  assert.match(source, /env: \{ \.\.\.process\.env, GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken \}/);
});
