import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinalizationPrompt,
  isPrematureNeedsHuman,
  normalizeCodexResult,
} from "../../dist/repair/openai-compatible/normalize-result.js";

const prompt = [
  "repo: example/project",
  "cluster_id: repair-example-project-123",
  "mode: plan",
  "## Source PR refs",
  "PR #123: source https://github.com/example/project/pull/123; local ref refs/remotes/clawsweeper/source-pr-123",
].join("\n");

test("normalizes action-scoped fix_artifact", () => {
  const raw = JSON.stringify({
    actions: [
      {
        action: "build_fix_artifact",
        fix_artifact: {
          summary: "Repair workflow",
          likely_files: ["scripts/workflows.sh"],
          validation_commands: ["bash -n scripts/workflows.sh"],
          source_prs: ["https://github.com/example/project/pull/123"],
          repair_strategy: "repair_contributor_branch",
          pr_title: "Repair workflow",
          pr_body: "Repair workflow for the contributor branch.",
        },
      },
    ],
  });
  const result = JSON.parse(normalizeCodexResult(raw, prompt, false));
  assert.equal(result.status, "planned");
  assert.equal(result.actions[0].action, "build_fix_artifact");
  assert.deepEqual(result.needs_human, []);
  assert.deepEqual(result.fix_artifact.likely_files, ["scripts/workflows.sh"]);
});

test("does not invent repo-specific defaults when fix evidence is missing", () => {
  const result = JSON.parse(
    normalizeCodexResult(
      JSON.stringify({ fix_needed: true, repair_strategy: "repair_contributor_branch" }),
      prompt,
      false,
    ),
  );
  assert.equal(result.status, "needs_human");
  assert.equal(result.fix_artifact, null);
  assert.match(result.needs_human.join("\n"), /missing_likely_files_evidence/);
  assert.match(result.needs_human.join("\n"), /missing_validation_commands_evidence/);
  assert.doesNotMatch(JSON.stringify(result), /scripts\/lib\/workflows\.sh/);
});

test("detects premature needs_human only before source-ref tool inspection", () => {
  const candidate = JSON.stringify({ status: "needs_human", fix_artifact: null });
  assert.equal(isPrematureNeedsHuman(candidate, prompt, 0), true);
  assert.equal(isPrematureNeedsHuman(candidate, prompt, 1), false);
});

test("finalization prompt is tool-free and evidence-based", () => {
  const finalPrompt = buildFinalizationPrompt(
    prompt,
    [{ role: "tool", content: "git diff evidence" }],
    false,
    "schema/repair/codex-result.schema.json",
  );
  assert.match(finalPrompt, /Return final JSON only/);
  assert.match(finalPrompt, /Do not call tools/);
  assert.match(finalPrompt, /git diff evidence/);
  assert.match(finalPrompt, /source PR is the suspect artifact/);
  assert.match(finalPrompt, /Never say to cherry-pick/);
  assert.match(finalPrompt, /Primary repair signal/);
  assert.match(finalPrompt, /secondary cleanup/);
});

test("needs_human fallback is not empty for non-fix nonconforming output", () => {
  const result = JSON.parse(normalizeCodexResult("not json", prompt, false));
  assert.equal(result.status, "needs_human");
  assert.equal(result.fix_artifact, null);
  assert.ok(result.needs_human.length > 0);
  assert.deepEqual(result.actions[0].evidence, result.needs_human);
});

test("normalizes repair artifact enum and PR shorthand when aligned with primary repair signal", () => {
  const alignedPrompt =
    prompt +
    '\n## Repair evidence pack\n```json\n{"repair_signals":[{"kind":"review_thread_unresolved","text":"Preserve the retry reason when the fallback path handles overlapping worker scopes; do not replace the fallback with a hard failure."}]}\n```\n';
  const raw = JSON.stringify({
    status: "planned",
    action: "build_fix_artifact",
    fix_artifact: {
      repair_strategy: "Preserve retry fallback reason",
      source_prs: [123],
      likely_files: ["scripts/workflows.sh"],
      validation_commands: ["bash -n scripts/workflows.sh"],
      summary: "Preserve the retry reason in the fallback path for overlapping worker scopes.",
      affected_surfaces: ["retry fallback", "worker scope handling"],
      pr_title: "Preserve fallback retry reason",
      pr_body:
        "Keeps the fallback path and passes the overlap/retry reason through instead of turning it into a hard failure.",
    },
  });
  const result = JSON.parse(normalizeCodexResult(raw, alignedPrompt, false));
  assert.equal(result.status, "planned");
  assert.equal(result.fix_artifact.repair_strategy, "repair_contributor_branch");
  assert.deepEqual(result.fix_artifact.source_prs, ["https://github.com/example/project/pull/123"]);
});

test("rejects schema-shaped repair artifacts that miss the primary repair signal", () => {
  const signalPrompt =
    prompt +
    '\n## Repair evidence pack\n```json\n{"repair_signals":[{"kind":"review_thread_unresolved","text":"Preserve the retry reason when the fallback path handles overlapping worker scopes; do not replace the fallback with a hard failure."}]}\n```\n';
  const raw = JSON.stringify({
    status: "planned",
    action: "build_fix_artifact",
    fix_artifact: {
      repair_strategy: "Fix coding subtask counting",
      source_prs: [123],
      likely_files: ["scripts/workflows.sh"],
      validation_commands: ["bash -n scripts/workflows.sh"],
      summary: "Correct coding subtask counting and numbered-line parsing.",
      affected_surfaces: ["subtask counting"],
      pr_title: "Fix coding subtask counting",
      pr_body: "Updates numbered subtask parsing.",
    },
  });
  const result = JSON.parse(normalizeCodexResult(raw, signalPrompt, false));
  assert.equal(result.status, "needs_human");
  assert.equal(result.fix_artifact, null);
  assert.match(result.needs_human.join("\n"), /fix_artifact_missing_primary_repair_signal/);
});

test("rejects artifacts that treat the source PR as canonical", () => {
  const signalPrompt =
    prompt +
    '\n## Repair evidence pack\n```json\n{"repair_signals":[{"kind":"review_changes_requested","text":"Replace unsafe feature detection that can mis-detect support under strict shell mode, and cache the support detection result."}]}\n```\n';
  const raw = JSON.stringify({
    status: "planned",
    action: "build_fix_artifact",
    repair_strategy: "Cherry-pick the changes from PR #123 to add the original fix as-is.",
    source_prs: ["https://github.com/example/project/pull/123"],
    likely_files: ["scripts/lib/spawn.sh"],
    validation_commands: ["bash -n scripts/lib/spawn.sh"],
    summary: "Apply fix from PR #123.",
    affected_surfaces: ["Gemini CLI compatibility"],
    pr_title: "Apply source PR",
    pr_body: "Cherry-pick from #123.",
  });
  const result = JSON.parse(normalizeCodexResult(raw, signalPrompt, false));
  assert.equal(result.status, "needs_human");
  assert.equal(result.fix_artifact, null);
  assert.match(result.needs_human.join("\n"), /source_pr_treated_as_canonical/);
  assert.doesNotMatch(result.needs_human.join("\n"), /fix_artifact_missing_primary_repair_signal/);
});

test("accepts artifacts that cover primary repair signal terms despite generic preflight gates", () => {
  const signalPrompt =
    prompt +
    '\n## Repair evidence pack\n```json\n{"evidence_gates":[{"kind":"merge_preflight","text":"mergeStateStatus=BLOCKED"}],"repair_signals":[{"kind":"review_changes_requested","text":"Replace unsafe feature detection that can mis-detect support under strict shell mode, and cache the support detection result."}]}\n```\n';
  const raw = JSON.stringify({
    status: "planned",
    action: "build_fix_artifact",
    repair_strategy:
      "Replace the unsafe feature detection with a robust strict-mode-safe check and cache the support detection result.",
    source_prs: [123],
    likely_files: ["scripts/lib/runner.sh"],
    validation_commands: ["bash -n scripts/lib/runner.sh"],
    summary: "Fix unsafe feature detection and cache the support result.",
    affected_surfaces: ["feature detection", "strict shell mode"],
    pr_title: "Harden feature detection",
    pr_body:
      "Replace unsafe detection with strict-mode-safe logic and cache the support detection result.",
  });
  const result = JSON.parse(normalizeCodexResult(raw, signalPrompt, false));
  assert.equal(result.status, "planned");
  assert.equal(result.actions[0].action, "build_fix_artifact");
  assert.deepEqual(result.needs_human, []);
  assert.equal(result.fix_artifact.repair_strategy, "repair_contributor_branch");
});

test("finalization prompt elevates primary signal over secondary cleanup", () => {
  const signalPrompt =
    prompt +
    '\n## Repair evidence pack\n```json\n{"repair_signals":[{"kind":"review_thread_unresolved","text":"Preserve the retry reason when the fallback path handles overlapping worker scopes; do not replace the fallback with a hard failure."}]}\n```\n';
  const finalPrompt = buildFinalizationPrompt(
    signalPrompt,
    [{ role: "tool", content: "remove duplicate conditional check" }],
    false,
    "schema/repair/codex-result.schema.json",
  );
  assert.match(finalPrompt, /Preserve the retry reason/);
  assert.match(finalPrompt, /overlapping worker scopes/);
  assert.match(finalPrompt, /Secondary findings may be mentioned only as supporting context/);
});

test("normalizes build_fix_artifact alias fields", () => {
  const signalPrompt =
    prompt +
    '\n## Repair evidence pack\n```json\n{"repair_signals":[{"kind":"review_changes_requested","text":"Replace unsafe feature detection that can mis-detect support under strict shell mode, and cache the support detection result."}]}\n```\n';
  const raw = JSON.stringify({
    outcome: "fix_needed",
    repair_strategy: "repair_contributor_branch",
    source_prs: ["https://github.com/example/project/pull/123"],
    build_fix_artifact: {
      fix_summary:
        "Replace unsafe feature detection with strict-mode-safe support detection and cache the support result.",
      changed_files: ["scripts/lib/runner.sh"],
      validation: ["bash -n scripts/lib/runner.sh passed", "Changed section matches source branch"],
      notes: "Repair artifact uses alias fields from a non-schema final answer.",
    },
  });
  const result = JSON.parse(normalizeCodexResult(raw, signalPrompt, true));
  assert.equal(result.status, "planned");
  assert.deepEqual(result.fix_artifact.likely_files, ["scripts/lib/runner.sh"]);
  assert.match(
    result.fix_artifact.validation_commands.join("\n"),
    /bash -n scripts\/lib\/runner\.sh/,
  );
  assert.match(
    result.fix_artifact.validation_commands.join("\n"),
    /Changed section matches source branch/,
  );
});

test("normalizes alias artifact when review signal contains boilerplate before code terms", () => {
  const signalPrompt =
    prompt +
    '\n## Repair evidence pack\n```json\n{"repair_signals":[{"kind":"review_changes_requested","text":"review by bot requested changes: Actionable comments posted. Verify each finding against current code. Inline comments: In `scripts/lib/runner.sh`: Replace `feature --help | grep -q -- --flag` because it is unsafe under strict_mode and can mis-detect support; cache support detection."}]}\n```\n';
  const raw = JSON.stringify({
    outcome: "fix_needed",
    repair_strategy: "repair_contributor_branch",
    source_prs: ["https://github.com/example/project/pull/123"],
    build_fix_artifact: {
      fix_summary:
        "Replace feature --help grep -q flag support detection with strict_mode-safe logic and cache support detection.",
      changed_files: ["scripts/lib/runner.sh"],
      validation: ["bash -n scripts/lib/runner.sh passed"],
    },
  });
  const result = JSON.parse(normalizeCodexResult(raw, signalPrompt, true));
  assert.equal(result.status, "planned");
  assert.deepEqual(result.needs_human, []);
});
