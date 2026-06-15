# Repair-only OpenAI-compatible adapter — notes

Date: 2026-06-13
Branch: `feature/repair-only-intake`
Status: working engineering note

## Why this exists

Repair-only PR intake now detects objective repair candidates instead of doing broad PR review. In a live target repository, the corrected intake selected only PRs with current objective blockers such as merge/check failures or unresolved review threads.

Execution exposed a backend mismatch. The existing repair worker expected Codex-native output-schema support, but some deployments use OpenAI-compatible Chat Completions backends where that native Codex behaviour is not available.

## Core idea

Do not treat tool use and final structured output as the same phase.

```text
job.md
  -> prepare target checkout
  -> fetch source PR refs
  -> bounded tool loop
  -> finalization without tools
  -> deterministic normalize/validate
  -> result.json / fix_artifact
```

For OpenAI-compatible providers, final JSON should be a separate finalization phase plus local validation, not another LLM schema-repair loop.

## Key learnings

### Deterministic intake first

Only current blockers create repair jobs: bad merge state, failed/cancelled/timed-out checks, current `CHANGES_REQUESTED`, unresolved current review threads. Historic CodeRabbit comments are context, not triggers. This fixed the initial 8/8 overmatching and got us to 2/8.

### Source PR refs are mandatory for third-party repos

For repos not owned by us, checkout starts on base `main`. The worker fetches PR heads into local refs:

```bash
git fetch origin refs/pull/<number>/head:clawsweeper/source-pr-<number>
```

The model must inspect with `git diff main...clawsweeper/source-pr-<number>` and `git show clawsweeper/source-pr-<number>:path`.

### Pseudo-tool-call parsing is required

Pioneer/DeepSeek may emit tool calls as text instead of native `tool_calls`, including JSON objects and DSML blocks. The adapter has to parse and normalize these into internal tool calls.

### Local normalization, not LLM schema repair

The earlier schema-repair LLM call caused timeouts and more malformed output. For `codex-result.schema.json`, use local parse/normalize/validate.

### Finalization must be isolated and compact

If max tool turns are exhausted after tool results, make a final call with tools disabled. Passing the full tool transcript can keep Pioneer/DeepSeek in tool-call mode. Use a compact isolated prompt: schema path, repo/cluster/canonical PR, source PR refs/job essentials, compact evidence, explicit “JSON only, no tools, no DSML”.

### Normalize multiple fix_artifact shapes

The model may return `{"fix_needed": true, "build_fix_artifact": {...}}` or `{"actions": [{"action": "build_fix_artifact", "fix_artifact": {...}}]}`. Preserve both into canonical `status=planned`, `action=build_fix_artifact`, `needs_human=[]`, `fix_artifact={...}`.

### Block premature needs_human

If output is `needs_human`, `toolsExecuted == 0`, and prompt has `## Source PR refs`, reject it and force source-ref inspection. We saw false claims that `clawsweeper/source-pr-460` was unavailable even though it was prepared.

## Current green milestone

A forced run against `#460` produced:

```text
status: planned
action: build_fix_artifact
needs_human: []
fix_artifact: true
repair_strategy: repair_contributor_branch
source_prs: [https://github.com/example/project/pull/123]
likely_files: [scripts/lib/workflows.sh]
validation_commands: [bash -n scripts/lib/workflows.sh]
```

This is the key behavioural milestone: the adapter can produce a planned repair artifact instead of false `needs_human`.

## Weak points still present

1. `openai-compatible-tools-runner.ts` is too monolithic: provider transport, tool loop, textual tools, finalization, normalization, and quirks are mixed.
2. Provider quirks are scattered conditionals instead of an explicit profile.
3. No durable `Step[]` model yet; finalization is built from message slicing.
4. No-diff `build_fix_artifact` can still use misleading language like “Applied fixes”. It should say “plan/propose repair artifact”.
5. Schema-valid does not mean evidence-supported. Need a later evidence-support check.
6. The pipeline reaches `result.json` / `fix_artifact`; it does not yet deliver the GitHub fix.
7. Tests are mostly live integration tests. Need fixtures for pseudo-tools, DSML, init JSON, premature `needs_human`, action-scoped `fix_artifact`, boolean fields, finalization, and no-diff language.

## External learning sources

### Vercel AI SDK

Most useful practical reference: multi-step tool loop, `stopWhen`, explicit steps, structured output after tool use, and OpenAI-compatible caveats.

- https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
- https://vercel.com/academy/ai-sdk/multi-step-and-generative-ui
- https://github.com/vercel/ai/discussions/3323
- https://github.com/vercel/ai/issues/5197

### OpenAI Agents / API docs

Canonical loop: call model, inspect output, execute tool calls, continue, final output.

- https://developers.openai.com/api/docs/guides/agents/running-agents
- https://openai.github.io/openai-agents-python/tools/
- https://openai.github.io/openai-agents-python/human_in_the_loop/

### Pydantic AI

Useful taxonomy: Tool Output, Native Output, Prompted Output.

- https://pydantic.dev/docs/ai/core-concepts/output/
- https://pydantic.dev/docs/ai/tools-toolsets/tools/
- https://github.com/pydantic/pydantic-ai/issues/1192

### Instructor

Worth studying before expanding the normalizer: extraction-first structured output, retries, and provider-specific quirks.

## Refactor direction inspired by Vercel

Keep our integration, but split responsibilities:

```text
src/repair/openai-compatible/
  profile.ts
  provider.ts
  tools.ts
  textual-tools.ts
  loop.ts
  finalization.ts
  normalize-result.ts
  evidence.ts
```

Core types:

```ts
type ProviderProfile = {
  name: string;
  parseTextualToolCalls: boolean;
  parseDsmlToolCalls: boolean;
  finalizationMode: "same_history" | "isolated_summary";
  structuredOutputMode: "native" | "prompt_json_then_validate";
  ignoreNonFinalSystemJson: boolean;
  normalizeActionScopedFixArtifact: boolean;
  blockPrematureNeedsHumanBeforeTools: boolean;
  maxToolSteps: number;
};

type Step = {
  index: number;
  assistantText?: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
};
```

Pioneer/DeepSeek profile should set textual/DSML parsing on, isolated summary finalization, prompt+validate structured output, ignore non-final system JSON, normalize action-scoped fix artifacts, and block premature `needs_human`.

## Humanizer next

Study humanizer for maintainer-facing language, not tool-loop mechanics. Extract:

- machine summary -> maintainer-safe language;
- contributor credit preservation;
- avoiding “applied/fixed” claims when only a plan exists;
- exact blockers vs generic `needs_human`;
- precise, non-accusatory PR bodies/comments.

Humanizer should run after structural normalization and validation:

```text
raw model result
  -> structural normalizer
  -> schema validation
  -> evidence support check
  -> humanizer/language pass
  -> final result.json / PR body
```

## Recommended next steps

1. Preserve current green behaviour with unit fixtures.
2. Add deterministic tests around all provider-quirk cases observed.
3. Refactor monolithic runner into Vercel-style steps/profile modules.
4. Add provider profile for Pioneer/DeepSeek.
5. Add language sanitization for no-diff `build_fix_artifact`.
6. Study humanizer and integrate it as a post-normalization pass.
7. Only then wire downstream GitHub delivery for `repair_contributor_branch` / replacement PR.
