type Message = { role: string; content?: string | null; tool_call_id?: string };

function normalizeFinalContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "\n";
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? extractJsonObject(trimmed) ?? trimmed).trim();
  return `${candidate}\n`;
}

function extractJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function truncate(value: unknown, limit = 12000): string {
  const text = String(value ?? "");
  return text.length > limit
    ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`
    : text;
}

export function isPrematureNeedsHuman(
  normalizedContent: string,
  prompt: string,
  toolsExecuted: number,
): boolean {
  if (toolsExecuted > 0) return false;
  if (!prompt.includes("## Source PR refs")) return false;
  try {
    const obj = JSON.parse(normalizedContent);
    return obj?.status === "needs_human" && !obj?.fix_artifact;
  } catch {
    return false;
  }
}

export function looksLikeCodexResultCandidate(content: string): boolean {
  const obj = parseLooseObject(content);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = new Set(Object.keys(obj));
  if (keys.has("status") || keys.has("actions") || keys.has("fix_artifact")) return true;
  if (keys.has("needs_human") || keys.has("build_fix_artifact") || keys.has("repair_strategy"))
    return true;
  return false;
}

function codexResultContext(prompt: string) {
  const repo = promptVal(prompt, "repo") || "unknown/unknown";
  const number = prNum(prompt) || "0";
  const ref = number === "0" ? null : `#${number}`;
  const prUrl =
    repo !== "unknown/unknown" && number !== "0"
      ? `https://github.com/${repo}/pull/${number}`
      : null;
  return {
    repo,
    number,
    ref,
    prUrl,
    clusterId: promptVal(prompt, "cluster_id") || `repair-pr-${repo.replace("/", "-")}-${number}`,
  };
}

export function buildFinalizationPrompt(
  rawPrompt: string,
  messages: Message[],
  diffExists: boolean,
  outputSchema: string,
): string {
  const ctx = codexResultContext(rawPrompt);
  const primarySignal = primaryRepairSignal(rawPrompt);
  return [
    `Schema path: ${outputSchema}`,
    "Return final JSON only. Do not call tools. Do not emit DSML/tool_calls.",
    "This is repair-only PR intake. The source PR is the suspect artifact, not canonical source material.",
    "Never say to cherry-pick, apply, copy, or accept the source PR as-is. Build a repair artifact for unresolved review signals/check failures only.",
    "Prefer status=planned with action=build_fix_artifact when repair is possible.",
    "Use needs_human only for an exact unresolved blocker.",
    `repo: ${ctx.repo}`,
    `cluster_id: ${ctx.clusterId}`,
    `canonical_pr: ${ctx.prUrl ?? ""}`,
    `canonical: ${ctx.ref ?? ""}`,
    `current_git_diff_exists: ${diffExists ? "yes" : "no"}`,
    "Required fix_artifact minimum fields when planned: repair_strategy, source_prs, likely_files, validation_commands, summary, affected_surfaces, credit_notes, pr_title, pr_body.",
    "A planned fix_artifact must directly repair the primary repair signal. Do not substitute a secondary cleanup, duplicate check, refactor, log cleanup, or incidental improvement unless it is explicitly the primary signal.",
    "",
    "## Primary repair signal (authoritative; must be fixed)",
    primarySignal ? truncate(primarySignal, 2000) : "<none extracted>",
    primarySignal ? primarySignalChecklist(primarySignal) : "",
    "",
    "## Source PR refs / job essentials",
    truncate(extractFinalizationEssentials(rawPrompt), 4500),
    "",
    "## Evidence collected from tool loop",
    truncate(finalizationTranscript(messages), 6500),
  ].join("\n");
}


function primarySignalChecklist(signal: string): string {
  const terms = importantSignalTerms(signal).slice(0, 8);
  return [
    "Checklist for this primary signal:",
    "- The fix_artifact must directly address the primary signal above.",
    "- Make summary, pr_title, pr_body, likely_files, and validation_commands point at that signal.",
    "- Secondary findings may be mentioned only as supporting context; they must not replace the primary signal.",
    terms.length ? `- Strong signal terms to preserve/address: ${terms.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function finalizationTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages.slice(-12)) {
    if (msg.role === "assistant" && msg.content) {
      const text = String(msg.content);
      if (
        text.includes("tool_call") ||
        text.includes("fix_artifact") ||
        text.includes("build_fix_artifact")
      ) {
        lines.push(`assistant: ${truncate(text, 1200)}`);
      }
    }
    if (msg.role === "tool" && msg.content) lines.push(`tool: ${truncate(msg.content, 1800)}`);
  }
  return lines.join("\n\n") || "No tool evidence captured.";
}

function extractFinalizationEssentials(prompt: string): string {
  const sections = [
    sectionFrom(prompt, "## Repair evidence pack", "## Cluster preflight artifact"),
    sectionFrom(prompt, "## Job file", "## Target checkout"),
    sectionFrom(prompt, "## Source PR refs", "## Required final output"),
  ].filter(Boolean);
  if (sections.length > 0) return sections.join("\n\n");
  return prompt
    .split(/\r?\n/)
    .filter((line) => /repo:|cluster_id:|source:|source_prs|repair_strategy|pull\//.test(line))
    .join("\n");
}

function sectionFrom(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) return "";
  const endIndex = text.indexOf(end, startIndex + start.length);
  return text.slice(startIndex, endIndex >= 0 ? endIndex : startIndex + 3000);
}

export function normalizeCodexResult(content: string, prompt: string, diffExists: boolean): string {
  const repo = promptVal(prompt, "repo") || "unknown/unknown";
  const cluster = promptVal(prompt, "cluster_id") || "openai-compatible-fallback";
  const rawMode = promptVal(prompt, "mode");
  const mode = ["plan", "execute", "autonomous"].includes(rawMode) ? rawMode : "autonomous";
  const num = prNum(prompt) || "0";
  const ref = `#${num}`;
  const prUrl =
    repo !== "unknown/unknown" && num !== "0" ? `https://github.com/${repo}/pull/${num}` : null;
  const obj = parseLooseObject(content);
  const textualToolCall = content.includes("<｜DSML｜tool_calls") || content.includes("tool_calls");
  const summary =
    str(obj.summary) ||
    str(obj.notes) ||
    str(obj.reason) ||
    str(obj.result) ||
    str(obj.blocked_reason) ||
    firstChangeRationale(obj) ||
    (textualToolCall
      ? "Adapter finalization returned tool calls instead of final JSON."
      : diffExists
        ? "OpenAI-compatible worker produced a diff but returned non-conforming structured output."
        : "OpenAI-compatible worker returned non-conforming structured output.");
  const needs = arr(obj.needs_human ?? obj.blockers ?? obj.exact_blocker_evidence);
  if (textualToolCall && needs.length === 0) needs.push("adapter_finalization_returned_tool_calls");
  let synthesizedFixArtifact = synthesizeFixArtifact(obj, repo, ref, prUrl, summary);
  if (synthesizedFixArtifact && sourcePrTreatedAsCanonical(synthesizedFixArtifact, prUrl, ref)) {
    needs.push("source_pr_treated_as_canonical");
    synthesizedFixArtifact = null;
  }
  if (synthesizedFixArtifact && !fixArtifactSatisfiesPrimaryRepairSignal(prompt, synthesizedFixArtifact)) {
    needs.push("fix_artifact_missing_primary_repair_signal");
    synthesizedFixArtifact = null;
  }
  if (!synthesizedFixArtifact && (obj.fix_needed === true || str(obj.repair_strategy) || arr(obj.source_prs).length > 0 || obj.build_fix_artifact || obj.fix_artifact || firstBuildFixAction(obj))) {
    if (needs.length === 0) needs.push("missing_fix_artifact_evidence");
    if (!arr(obj.likely_files).length && !arr(obj.fix_artifact?.likely_files).length && !arr(obj.build_fix_artifact?.likely_files).length) needs.push("missing_likely_files_evidence");
    if (!arr(obj.validation_commands).length && !arr(obj.fix_artifact?.validation_commands).length && !arr(obj.build_fix_artifact?.validation_commands).length) needs.push("missing_validation_commands_evidence");
  }
  const action = synthesizedFixArtifact ? "build_fix_artifact" : "needs_human";
  const humanNeeds = action === "needs_human" && needs.length === 0 ? [summary] : needs;
  return `${JSON.stringify(
    {
      status: action === "needs_human" ? "needs_human" : "planned",
      repo,
      cluster_id: cluster,
      mode,
      summary,
      actions: [
        {
          target: action === "build_fix_artifact" ? `cluster:${cluster}` : ref,
          action,
          status: "planned",
          idempotency_key: `${cluster}-${action}`,
          classification: action === "needs_human" ? "needs_human" : "canonical",
          target_kind: action === "build_fix_artifact" ? null : "pull_request",
          target_updated_at:
            action === "build_fix_artifact"
              ? null
              : promptUpdatedAt(prompt) || new Date().toISOString(),
          canonical: ref,
          duplicate_of: null,
          candidate_fix: null,
          comment: null,
          evidence: humanNeeds.length ? humanNeeds : [summary],
          reason: humanNeeds[0] || summary,
        },
      ],
      needs_human: humanNeeds,
      canonical: ref,
      canonical_issue: null,
      canonical_pr: prUrl,
      merge_preflight: [],
      fix_artifact: synthesizedFixArtifact,
    },
    null,
    2,
  )}\n`;
}

function firstBuildFixAction(obj: any): any {
  const actions = Array.isArray(obj.actions) ? obj.actions : [];
  return actions.find(
    (entry: any) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry.action === "build_fix_artifact" || entry.fix_artifact),
  );
}

function synthesizeFixArtifact(
  obj: any,
  repo: string,
  ref: string,
  prUrl: string | null,
  summary: string,
) {
  const topAction = firstBuildFixAction(obj);
  const wantsFix =
    obj.fix_needed === true ||
    str(obj.repair_strategy) ||
    arr(obj.source_prs).length > 0 ||
    obj.build_fix_artifact ||
    obj.fix_artifact ||
    topAction;
  if (!wantsFix) return null;
  const action = topAction;
  const actionFix = action?.fix_artifact;
  const nested =
    obj.fix_artifact && typeof obj.fix_artifact === "object" && !Array.isArray(obj.fix_artifact)
      ? obj.fix_artifact
      : obj.build_fix_artifact &&
          typeof obj.build_fix_artifact === "object" &&
          !Array.isArray(obj.build_fix_artifact)
        ? obj.build_fix_artifact
        : actionFix && typeof actionFix === "object" && !Array.isArray(actionFix)
          ? actionFix
          : {};
  const artifactSummary =
    str(nested.summary) ||
    str(nested.fix_summary) ||
    str(obj.fix_summary) ||
    firstChangeRationale(nested) ||
    str(obj.notes) ||
    str(action?.reason) ||
    summary;
  const likelyFiles = arr(nested.likely_files).length
    ? arr(nested.likely_files)
    : arr(nested.files_changed).length
      ? arr(nested.files_changed)
      : arr(nested.changed_files).length
        ? arr(nested.changed_files)
        : changePaths(nested).length
        ? changePaths(nested)
        : arr(obj.likely_files).length
          ? arr(obj.likely_files)
          : [];
  const validationCommands = arr(nested.validation_commands).length
    ? arr(nested.validation_commands)
    : arr(nested.validation?.ran).length
      ? arr(nested.validation.ran)
      : validationList(nested.validation).length
        ? validationList(nested.validation)
        : arr(obj.validation_commands).length
        ? arr(obj.validation_commands)
        : arr(obj.validation?.ran).length
          ? arr(obj.validation.ran)
          : validationList(obj.validation).length
            ? validationList(obj.validation)
            : [];
  if (likelyFiles.length === 0 || validationCommands.length === 0) return null;
  const validationSummary =
    str(nested.validation_summary) ||
    str(obj.validation_summary) ||
    arr(nested.validation?.results).join("; ") ||
    validationSummaryFromList(nested.validation) ||
    arr(obj.validation?.results).join("; ") ||
    validationSummaryFromList(obj.validation);
  return {
    summary: artifactSummary,
    affected_surfaces: arr(nested.affected_surfaces).length
      ? arr(nested.affected_surfaces)
      : arr(obj.affected_surfaces).length
        ? arr(obj.affected_surfaces)
        : ["repair-only PR intake"],
    likely_files: likelyFiles,
    linked_refs: [ref],
    validation_commands: validationSummary
      ? [...validationCommands, `# ${validationSummary}`]
      : validationCommands,
    changelog_required: nested.changelog_required === true || obj.changelog_required === true,
    credit_notes: [prUrl ? `Source PR: ${prUrl}` : "Preserve contributor credit."],
    pr_title: str(nested.pr_title) || str(obj.pr_title) || `Repair ${repo} ${ref}`,
    pr_body: str(nested.pr_body) || str(obj.pr_body) || str(obj.notes) || artifactSummary,
    source_prs: normalizeSourcePrs(
      arr(obj.source_prs).length ? arr(obj.source_prs) : arr(nested.source_prs),
      prUrl,
    ),
    repair_strategy: normalizeRepairStrategy(
      str(obj.repair_strategy) || str(nested.repair_strategy),
    ),
    allow_no_pr: nested.allow_no_pr === true || obj.allow_no_pr === true,
    branch_update_blockers: arr(nested.branch_update_blockers).length
      ? arr(nested.branch_update_blockers)
      : arr(obj.branch_update_blockers),
  };
}


const REPAIR_STRATEGIES = new Set([
  "repair_contributor_branch",
  "replace_uneditable_branch",
  "new_fix_pr",
  "already_fixed_on_main",
  "needs_human",
]);

function normalizeRepairStrategy(value: string): string {
  const raw = value.trim().toLowerCase().replace(/[ -]+/g, "_");
  if (REPAIR_STRATEGIES.has(raw)) return raw;
  const text = value.toLowerCase();
  if (/already[_ -]?fixed|fixed on main|already on main/.test(text)) return "already_fixed_on_main";
  if (/needs? human|manual|blocked/.test(text)) return "needs_human";
  if (/uneditable|replace[_ -]?uneditable|replace[^.]{0,80}branch|replacement[^.]{0,80}branch/.test(text)) return "replace_uneditable_branch";
  if (/new .*fix|new .*pr|follow.?up/.test(text)) return "new_fix_pr";
  return "repair_contributor_branch";
}

function normalizeSourcePrs(values: string[], prUrl: string | null): string[] {
  const urls: string[] = [];
  const fallbackNumber = prUrl?.match(/\/pull\/(\d+)$/)?.[1] ?? "";
  const fallbackPrefix = fallbackNumber ? prUrl!.slice(0, -fallbackNumber.length) : "";
  const candidates = values.length > 0 ? values : prUrl ? [prUrl] : [];
  for (const value of candidates) {
    const text = value.trim();
    if (!text) continue;
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/i.test(text)) {
      urls.push(text);
      continue;
    }
    const number = text.match(/^#?(\d+)$/)?.[1];
    if (number && fallbackPrefix) urls.push(`${fallbackPrefix}${number}`);
  }
  if (urls.length === 0 && prUrl) urls.push(prUrl);
  return [...new Set(urls)];
}


function sourcePrTreatedAsCanonical(artifact: any, prUrl: string | null, ref: string): boolean {
  const text = artifactText(artifact);
  const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prNumber = prUrl?.match(/\/pull\/(\d+)$/)?.[1] ?? ref.replace(/^#/, "");
  const sourceRefPattern = prNumber
    ? new RegExp(`(?:source\\s+pr|pr|#)\\s*#?${prNumber}`, "i")
    : new RegExp(escapedRef, "i");
  return (
    /\bcherry[- ]pick\b/i.test(text) ||
    /\bapply\s+(?:the\s+)?(?:fix|changes|patch)\s+from\s+(?:the\s+)?(?:source\s+)?pr\b/i.test(text) ||
    /\bapply\s+(?:the\s+)?(?:source\s+)?pr\s+as[- ]is\b/i.test(text) ||
    /\bcopy\s+(?:the\s+)?(?:source\s+)?pr\b/i.test(text) ||
    /\baccept\s+(?:the\s+)?(?:source\s+)?pr\b/i.test(text) ||
    /\bcanonical\s+(?:source\s+)?pr\b/i.test(text) ||
    (/\bapply\b/i.test(text) && sourceRefPattern.test(text) && /\bas[- ]is\b/i.test(text))
  );
}

function fixArtifactSatisfiesPrimaryRepairSignal(prompt: string, artifact: any): boolean {
  const signal = primaryRepairSignal(prompt);
  if (!signal) return true;
  const text = artifactText(artifact);
  const terms = importantSignalTerms(signal);
  if (terms.length === 0) return true;
  const hits = terms.filter((term) => text.includes(term)).length;
  const requiredHits = Math.max(3, Math.ceil(terms.length * 0.4));
  return hits >= Math.min(requiredHits, terms.length);
}

function primaryRepairSignal(prompt: string): string {
  const signals = extractRepairSignals(prompt);
  return (
    signals.find((signal) => signal.kind === "review_thread_unresolved")?.text ||
    signals.find((signal) => signal.kind === "review_changes_requested")?.text ||
    signals.find((signal) => meaningfulRepairSignalText(signal.text))?.text ||
    ""
  );
}

function extractRepairSignals(prompt: string): Array<{ kind: string; text: string }> {
  const signals: Array<{ kind: string; text: string }> = [];
  const pattern = /"kind":\s*"([^"\\]+)"[\s\S]{0,1800}?"text":\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of prompt.matchAll(pattern)) {
    const kind = match[1] || "";
    const text = decodeJsonString(match[2] || "");
    if (!kind || !text) continue;
    signals.push({ kind, text });
  }
  return signals;
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

function meaningfulRepairSignalText(text: string): boolean {
  return !/^(mergeStateStatus|mergeable|state)=/i.test(text.trim());
}

function artifactText(artifact: any): string {
  return [
    artifact.repair_strategy,
    artifact.summary,
    artifact.pr_title,
    artifact.pr_body,
    ...(Array.isArray(artifact.affected_surfaces) ? artifact.affected_surfaces : []),
    ...(Array.isArray(artifact.likely_files) ? artifact.likely_files : []),
    ...(Array.isArray(artifact.validation_commands) ? artifact.validation_commands : []),
    ...(Array.isArray(artifact.credit_notes) ? artifact.credit_notes : []),
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join("\n");
}

function importantSignalTerms(signal: string): string[] {
  const lower = signal.toLowerCase().replace(/https?:\/\/\S+/g, " ");
  const codeTerms = [...lower.matchAll(/`([^`]+)`/g)].flatMap((match) => tokenizeSignalTerms(match[1] ?? "", 3));
  const generalTerms = tokenizeSignalTerms(lower, 5);
  return [...new Set([...codeTerms, ...generalTerms])]
    .filter((term) => !REVIEW_SIGNAL_STOPWORDS.has(term))
    .slice(0, 16);
}

function tokenizeSignalTerms(value: string, minLength: number): string[] {
  const pattern = new RegExp(`[a-z_][a-z0-9_-]{${Math.max(0, minLength - 1)},}`, "g");
  return value.match(pattern) ?? [];
}

const REVIEW_SIGNAL_STOPWORDS = new Set([
  "review",
  "thread",
  "coderabbitai",
  "potential",
  "issue",
  "major",
  "quick",
  "status",
  "github",
  "comments",
  "comment",
  "current",
  "branch",
  "around",
  "line",
  "lines",
  "requested",
  "changes",
  "actionable",
  "posted",
  "details",
  "summary",
  "prompt",
  "agents",
  "agent",
  "verify",
  "finding",
  "findings",
  "against",
  "still-valid",
  "still",
  "valid",
  "skip",
  "rest",
  "brief",
  "reason",
  "minimal",
  "validate",
  "inline",
  "file",
  "files",
  "view",
  "html_url",
  "created_at",
  "body",
  "user",
]);


function validationList(value: any): string[] {
  const values = arr(value);
  if (values.length === 0) return [];
  return values.map(validationCommandFromText).filter(Boolean);
}

function validationCommandFromText(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const beforePassed = text.match(/^(.+?)\s+(?:passed|passes|succeeded|ok)\b/i)?.[1]?.trim();
  if (beforePassed && looksLikeValidationCommand(beforePassed)) return beforePassed;
  if (looksLikeValidationCommand(text)) return text;
  return `# ${text}`;
}

function looksLikeValidationCommand(value: string): boolean {
  return /^(bash|sh|shellcheck|bats|npm|pnpm|yarn|node|python3?|pytest|go test|cargo test|make|cmake|ruby|bundle)\b/.test(value.trim());
}

function validationSummaryFromList(value: any): string {
  const values = arr(value).filter((entry) => !looksLikeValidationCommand(entry));
  return values.join("; ");
}

function firstChangeRationale(obj: any): string {
  const changes = Array.isArray(obj?.changes) ? obj.changes : [];
  for (const change of changes) {
    const rationale = str(change?.rationale);
    if (rationale) return rationale;
  }
  return "";
}

function changePaths(obj: any): string[] {
  const changes = Array.isArray(obj?.changes) ? obj.changes : [];
  return changes.map((change: any) => str(change?.path)).filter(Boolean);
}

function promptVal(prompt: string, key: string): string {
  const p = `${key}:`;
  for (const line of prompt.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(p)) return t.slice(p.length).trim();
  }
  return "";
}
function promptUpdatedAt(prompt: string): string {
  return prompt.match(/"updated_at": "([^"]+)"/)?.[1] || "";
}
function prNum(prompt: string): string {
  const a = prompt.match(/\/pull\/(\d+)/);
  if (a?.[1]) return a[1];
  const b = prompt.match(/#(\d+)/);
  return b?.[1] || "";
}
function parseLooseObject(content: string): any {
  const t = normalizeFinalContent(content).trim();
  try {
    return JSON.parse(t);
  } catch {}
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {}
  }
  return {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}
function arr(v: unknown): string[] {
  if (typeof v === "boolean" || v == null) return [];
  const xs = Array.isArray(v) ? v : [v];
  return xs
    .filter((x) => typeof x !== "boolean" && x != null)
    .map((x) => (typeof x === "string" ? x.trim() : JSON.stringify(x)))
    .filter(Boolean);
}

