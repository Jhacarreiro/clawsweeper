import { spawnSync } from "node:child_process";
import type { LooseRecord } from "./json-types.js";
import { parsePullRequestUrl } from "./github-ref.js";
import { sourcePullRequestRemoteRef } from "./source-pr-checkout.js";

export type RepairEvidencePack = {
  repo: string;
  cluster_id: string;
  source_prs: EvidenceSourcePullRequest[];
  repair_signals: EvidenceRepairSignal[];
  evidence_gates: {
    source_pr_ref_fetched: boolean;
    source_pr_diff_read: boolean;
    actionable_signal_read: boolean;
    relevant_hunk_read: boolean;
  };
  likely_files: string[];
  validation_hints: string[];
  operator_notes: string[];
};

type EvidenceSourcePullRequest = {
  number: number;
  url: string;
  local_ref: string;
  base_ref: string;
  diff_ref: string;
  changed_files: string[];
  diff_stat: string;
  relevant_hunks: EvidenceHunk[];
};

type EvidenceRepairSignal = {
  kind: string;
  text: string;
  mentioned_files: string[];
};

type EvidenceHunk = {
  file: string;
  reason: string;
  excerpt: string;
};

export function buildRepairEvidencePack(job: LooseRecord, targetDir: string): RepairEvidencePack {
  const repo = stringValue(job.frontmatter?.repo);
  const clusterId = stringValue(job.frontmatter?.cluster_id);
  const signals = extractRepairSignals(String(job.body ?? job.raw ?? ""));
  const signalFiles = unique(signals.flatMap((signal) => signal.mentioned_files));
  const baseRef = targetBaseRef(targetDir);
  const sourcePrs = sourcePullRequests(job).map(({ number, url }) => {
    const localRef = sourcePullRequestRemoteRef(number);
    const diffRef = hasMergeBase(targetDir, baseRef, localRef)
      ? `${baseRef}...${localRef}`
      : `${baseRef}..${localRef}`;
    const changedFiles = gitLines(targetDir, ["diff", "--name-only", diffRef]);
    const relevantFiles = selectRelevantFiles(changedFiles, signalFiles);
    return {
      number,
      url,
      local_ref: localRef,
      base_ref: baseRef,
      diff_ref: diffRef,
      changed_files: changedFiles,
      diff_stat: gitText(targetDir, ["diff", "--stat", diffRef]),
      relevant_hunks: relevantFiles.slice(0, 6).map((file) => ({
        file,
        reason: signalFiles.includes(file)
          ? "mentioned_by_repair_signal_and_changed"
          : "changed_in_source_pr",
        excerpt: truncate(gitText(targetDir, ["diff", "--unified=60", diffRef, "--", file]), 12000),
      })),
    };
  });
  const changedFiles = unique(sourcePrs.flatMap((pr) => pr.changed_files));
  const likelyFiles = selectRelevantFiles(changedFiles, signalFiles);
  return {
    repo,
    cluster_id: clusterId,
    source_prs: sourcePrs,
    repair_signals: signals,
    evidence_gates: {
      source_pr_ref_fetched: sourcePrs.some((pr) => gitRefExists(targetDir, pr.local_ref)),
      source_pr_diff_read: sourcePrs.some((pr) => pr.changed_files.length > 0),
      actionable_signal_read: signals.length > 0,
      relevant_hunk_read: sourcePrs.some((pr) => pr.relevant_hunks.length > 0),
    },
    likely_files: likelyFiles,
    validation_hints: validationHints(likelyFiles),
    operator_notes: [
      "Evidence pack is deterministic and generic; it is not a model conclusion.",
      "The model must base repair-only intake on the source PR diff, objective repair signals, and relevant hunks above before finalizing.",
    ],
  };
}

export function renderRepairEvidencePack(pack: RepairEvidencePack): string {
  return JSON.stringify(pack, null, 2);
}

export function extractRepairSignals(body: string): EvidenceRepairSignal[] {
  const lines = body.split(/\r?\n/);
  const out: EvidenceRepairSignal[] = [];
  let inSignals = false;
  for (const line of lines) {
    if (/^(?:##\s+)?Repair signals:?$/i.test(line.trim())) {
      inSignals = true;
      continue;
    }
    if (inSignals && (/^##\s+/.test(line.trim()) || /^[A-Z][A-Za-z ]+:$/.test(line.trim()))) break;
    if (!inSignals) continue;
    const match = line.match(/^\s*-\s+([^:]+):\s*(.+)$/);
    if (!match) continue;
    const text = (match[2] ?? "").trim();
    out.push({
      kind: (match[1] ?? "repair_signal").trim(),
      text,
      mentioned_files: mentionedFiles(text),
    });
  }
  return out;
}

function sourcePullRequests(job: LooseRecord): { number: number; url: string }[] {
  const repo = stringValue(job.frontmatter?.repo);
  const refs = new Map<number, string>();
  for (const value of [
    ...(Array.isArray(job.frontmatter?.canonical) ? job.frontmatter.canonical : []),
    ...(Array.isArray(job.frontmatter?.candidates) ? job.frontmatter.candidates : []),
  ]) {
    const parsed = parsePullRequestUrl(value);
    if (parsed) {
      if (!repo || parsed.repo.toLowerCase() === repo.toLowerCase())
        refs.set(parsed.number, parsed.url);
      continue;
    }
    const shorthand = String(value ?? "")
      .trim()
      .match(/^#?(\d+)$/);
    if (shorthand?.[1] && repo)
      refs.set(Number(shorthand[1]), `https://github.com/${repo}/pull/${shorthand[1]}`);
  }
  return [...refs].map(([number, url]) => ({ number, url }));
}

function mentionedFiles(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/`@?([^`]+)`/g)) addFileMentions(out, match[1] ?? "");
  for (const match of text.matchAll(/@?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@-]+)+)/g))
    addFileMentions(out, match[1] ?? "");
  return unique(out);
}

function addFileMentions(out: string[], value: string): void {
  for (const part of value.split(/[\s,]+/)) {
    const cleaned = part
      .trim()
      .replace(/^@/, "")
      .replace(/^\/+/, "")
      .replace(/[).:,;]+$/, "");
    if (
      !cleaned ||
      cleaned.includes("http") ||
      cleaned.startsWith("github.com/") ||
      cleaned.startsWith("www.")
    )
      continue;
    if (!cleaned.includes("/")) continue;
    if (/^[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+$/.test(cleaned) && !cleaned.includes(".")) continue;
    out.push(cleaned);
  }
}

function selectRelevantFiles(changedFiles: string[], signalFiles: string[]): string[] {
  const exact = changedFiles.filter((file) => signalFiles.includes(file));
  const parentMatches = changedFiles.filter((file) =>
    signalFiles.some(
      (signalFile) =>
        file.startsWith(`${signalFile.replace(/\/$/, "")}/`) ||
        signalFile.startsWith(`${file.replace(/\/$/, "")}/`),
    ),
  );
  return unique([...exact, ...parentMatches, ...changedFiles]).slice(0, 12);
}

function validationHints(files: string[]): string[] {
  const hints = new Set<string>();
  if (files.some((file) => file.endsWith(".sh"))) hints.add("bash -n <changed shell scripts>");
  if (
    files.some(
      (file) =>
        file.endsWith(".ts") ||
        file.endsWith(".tsx") ||
        file.endsWith(".js") ||
        file.endsWith(".jsx"),
    )
  )
    hints.add("run the narrowest package test/lint command for changed JS/TS files");
  if (
    files.some(
      (file) => file.startsWith("test/") || file.includes("/test") || file.includes("tests/"),
    )
  )
    hints.add("run the touched or nearest tests when available");
  if (hints.size === 0 && files.length > 0)
    hints.add("run the narrowest repo-native validation for the touched files");
  return [...hints];
}

function targetBaseRef(targetDir: string): string {
  const ref = gitText(targetDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
  return ref || "origin/HEAD";
}

function hasMergeBase(targetDir: string, baseRef: string, localRef: string): boolean {
  return gitStatus(targetDir, ["merge-base", baseRef, localRef]) === 0;
}

function gitRefExists(targetDir: string, ref: string): boolean {
  return gitStatus(targetDir, ["rev-parse", "--verify", ref]) === 0;
}

function gitLines(targetDir: string, args: string[]): string[] {
  return gitText(targetDir, args)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitText(targetDir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", targetDir, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
  });
  return result.status === 0 ? result.stdout : "";
}

function gitStatus(targetDir: string, args: string[]): number | null {
  const result = spawnSync("git", ["-C", targetDir, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return result.status ?? null;
}

function truncate(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`
    : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
