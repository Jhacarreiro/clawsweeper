# External repair adapters

ClawSweeper repair is Codex-first. Operators that need a different local model/runtime can opt into an external command adapter without adding that runtime to ClawSweeper core.

Set `CLAWSWEEPER_REPAIR_ADAPTER_CMD` to a command path plus literal arguments. Shell syntax is intentionally rejected. The adapter receives a JSON payload on stdin and may edit the prepared target checkout. Exit `0` means the adapter completed. Exit `78` asks ClawSweeper to fall back to the normal Codex edit path.

ClawSweeper does not pass `GH_TOKEN` or broad secrets by default. The adapter environment is limited to `HOME`, `PATH`, locale/TMP variables, and `NODE_OPTIONS`. Extra variables must be named explicitly with `CLAWSWEEPER_REPAIR_ADAPTER_ENV_ALLOWLIST`.

Payload fields include:

```json
{
  "task": "repair_edit | rebase_conflict_fix",
  "repo": "owner/name",
  "target_dir": "/tmp/checkout",
  "fix_artifact": {},
  "repair_contract": {
    "must_touch": [],
    "must_not_touch": [],
    "must_prove": []
  },
  "allowed_files": [],
  "allowed_pr_refs": [],
  "validation_commands": [],
  "prompt": "the normal ClawSweeper repair prompt"
}
```

Security expectations:

- Treat `allowed_files` and `allowed_pr_refs` as hard capability boundaries.
- Do not read unrelated GitHub refs unless the operator has explicitly supplied a narrower credential and policy outside ClawSweeper.
- Keep provider/runtime dependencies in the adapter project, not in ClawSweeper.
- Keep the exact-head ClawSweeper review and GitHub checks as the final merge gate.
