# Repair model backend configuration

ClawSweeper repair workers can use different model backends without putting provider, model, URL, or key settings in ad-hoc shell commands.

A user-level config can be placed at:

```text
~/.config/clawsweeper/model-backend.json
```

Set CLAWSWEEPER_MODEL_BACKEND_CONFIG to use another path.
A repository-local config can also be used for development at:

```text
config/model-backend.json
```

That local file is ignored by git. Commit only the safe example file:

```text
config/model-backend.example.json
```

## Shape

```json
{
  "schema_version": 1,
  "backend": "openai-compatible-tools",
  "openai_compatible": {
    "base_url": "https://api.example.com/v1",
    "model": "provider/model-name",
    "api_key_env": "PROVIDER_API_KEY",
    "max_turns": 0,
    "max_tokens": 0
  }
}
```

`api_key_env` is the name of an environment variable already present in the runtime. Do not put API key values in this file. `max_turns` omitted, blank, or `0` means no turn limit; `max_tokens` omitted, blank, or `0` means do not send an explicit provider token cap.

## Backends

- `codex-cli`: run the Codex CLI and let Codex read its own `CODEX_HOME` configuration.
- `openai-compatible-tools`: run ClawSweeper's OpenAI-compatible tool loop and fill its generic `base_url`, `model`, and `api_key_env` from this config.

Environment variables such as `CLAWSWEEPER_MODEL_BACKEND` and `CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL` remain supported as emergency/backcompat overrides, but normal operator commands should not include them.

## Operator command

```bash
corepack pnpm run repair:worker -- jobs/<owner>/inbox/<job>.md --mode autonomous
```

If the execute gate is closed, open only the gate for that invocation:

```bash
CLAWSWEEPER_ALLOW_EXECUTE=1 corepack pnpm run repair:worker -- jobs/<owner>/inbox/<job>.md --mode autonomous
```
