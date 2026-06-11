# ClawSweeper model backends

Read when changing the model runtime used by repair workers.

ClawSweeper defaults to the historical Codex CLI backend. Operators can switch repair workers to an OpenAI-compatible tool runner without changing repair policy, GitHub mutation logic, or deterministic executors.

## Backends

### `codex-cli`

Default upstream-compatible mode.

```text
CLAWSWEEPER_MODEL_BACKEND=codex-cli
```

The repair workflow runs `.github/actions/setup-codex`, configures Codex, and worker subprocesses execute `codex exec ...`.

### `openai-compatible-tools`

Direct OpenAI-compatible chat/completions backend with controlled tools.

```text
CLAWSWEEPER_MODEL_BACKEND=openai-compatible-tools
CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL=https://example-provider.invalid/v1
CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL=provider/model-id
CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV=CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY
CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY=...
```

The backend runner accepts the same minimal worker invocation shape that repair workers already use:

```text
exec --cd <target-checkout> --output-last-message <path> [--output-schema <path>] -
```

It reads the prompt from stdin, calls `<base_url>/chat/completions`, and exposes controlled tools:

- `read_file`
- `read_file_range`
- `write_file`
- `run_command`
- `git_diff`

The deterministic ClawSweeper executor still owns commit, push, PR creation, comments, merge/close gates, and result application.

## GitHub Actions configuration

For GitHub Actions, set repository variables:

```text
CLAWSWEEPER_MODEL_BACKEND=openai-compatible-tools
CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL=https://example-provider.invalid/v1
CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL=provider/model-id
```

Set repository secret:

```text
CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY=<provider key>
```

When `CLAWSWEEPER_MODEL_BACKEND=openai-compatible-tools`, `repair-cluster-worker.yml` skips `setup-codex`.

## Local Pioneer example

Gallivanter can use its existing environment secret without hardcoding the provider upstream:

```bash
CLAWSWEEPER_MODEL_BACKEND=openai-compatible-tools \
CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL=https://api.pioneer.ai/v1 \
CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV=PIONEER_API_KEY \
CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL=deepseek-ai/DeepSeek-V4-Pro \
pnpm run repair:worker -- jobs/example.md --mode autonomous
```

Do not print provider keys in logs or documentation.
