import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRepairEvidencePack, extractRepairSignals } from "../../dist/repair/evidence-pack.js";

test("extracts objective repair signals and mentioned files generically", () => {
  const signals = extractRepairSignals([
    "Repair signals:",
    "- review_thread_unresolved: In `src/main.sh`: restore fallback behavior.",
    "- check_failed: Unit Tests failed around packages/api/index.ts",
    "- review_actionable: Prompt block @scripts/lib/workflows.sh",
    "",
    "## Other section",
    "- ignored: later content",
  ].join("\n"));
  assert.equal(signals.length, 3);
  assert.equal(signals[0]?.kind, "review_thread_unresolved");
  assert.deepEqual(signals[0]?.mentioned_files, ["src/main.sh"]);
  assert.deepEqual(signals[1]?.mentioned_files, ["packages/api/index.ts"]);
  assert.deepEqual(signals[2]?.mentioned_files, ["scripts/lib/workflows.sh"]);
});

test("builds a source PR evidence pack from local refs and repair signals", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-evidence-pack-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
  execFileSync("git", ["config", "user.email", "smoke@example.invalid"], { cwd: tmp });
  execFileSync("git", ["config", "user.name", "smoke"], { cwd: tmp });
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "main.sh"), "#!/usr/bin/env bash\necho ok\n");
  execFileSync("git", ["add", "."], { cwd: tmp });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: tmp });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-qb", "source-pr"], { cwd: tmp });
  fs.writeFileSync(path.join(tmp, "src", "main.sh"), "#!/usr/bin/env bash\necho broken\nreturn 1\n");
  execFileSync("git", ["add", "."], { cwd: tmp });
  execFileSync("git", ["commit", "-qm", "source pr"], { cwd: tmp });
  const prSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", "main"], { cwd: tmp });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", baseSha], { cwd: tmp });
  execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: tmp });
  execFileSync("git", ["update-ref", "refs/remotes/clawsweeper/source-pr-123", prSha], { cwd: tmp });

  const job = {
    frontmatter: {
      repo: "example/project",
      cluster_id: "repair-pr-example-project-123",
      canonical: ["#123"],
      candidates: ["#123"],
    },
    body: [
      "# Repair-only PR intake",
      "",
      "## Repair signals",
      "- review_thread_unresolved: In `src/main.sh`: restore fallback instead of hard failing.",
    ].join("\n"),
  };
  const pack = buildRepairEvidencePack(job, tmp);
  assert.equal(pack.repo, "example/project");
  assert.deepEqual(pack.evidence_gates, {
    source_pr_ref_fetched: true,
    source_pr_diff_read: true,
    actionable_signal_read: true,
    relevant_hunk_read: true,
  });
  assert.deepEqual(pack.likely_files, ["src/main.sh"]);
  assert.equal(pack.source_prs[0]?.diff_ref, "origin/main...refs/remotes/clawsweeper/source-pr-123");
  assert.match(pack.source_prs[0]?.relevant_hunks[0]?.excerpt ?? "", /return 1/);
  assert.ok(pack.validation_hints.includes("bash -n <changed shell scripts>"));
});
