#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildFinalizationPrompt,
  isPrematureNeedsHuman,
  looksLikeCodexResultCandidate,
  normalizeCodexResult,
} from "./openai-compatible/normalize-result.js";
import { normalizeToolCalls, pseudoToolCalls } from "./openai-compatible/textual-tools.js";

type Message = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};
type ToolCall = { id: string; function: { name: string; arguments?: string } };

const args = process.argv.slice(2);
const cd = stringArg("--cd", process.cwd());
const outputLastMessage = stringArg("--output-last-message", "");
const outputSchema = stringArg("--output-schema", "");
const sandbox = stringArg("--sandbox", "workspace-write").toLowerCase();
const readOnlySandbox = sandbox === "read-only" || sandbox === "readonly";
const outputSchemaAbs = outputSchema ? path.resolve(outputSchema) : "";
const outputSchemaJson =
  outputSchemaAbs && fs.existsSync(outputSchemaAbs)
    ? JSON.parse(fs.readFileSync(outputSchemaAbs, "utf8"))
    : null;
const cwd = path.resolve(cd);
const baseUrl = requiredEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL").replace(/\/$/, "");
const model = requiredEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL");
const apiKeyEnv = process.env.CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV || "OPENAI_API_KEY";
const apiKey = process.env[apiKeyEnv] || "";
const maxTurns = numberEnvZeroMeansUnlimited("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS");
const maxRetries = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_RETRIES", 3);
const readLimit = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_READ_LIMIT", 200000);
const commandTimeoutMs = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_COMMAND_TIMEOUT_MS", 120000);
const requestTimeoutMs = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS", 600000);
const maxTokens = numberEnvAllowZero("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TOKENS", 0);
const commandOutputLimit = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_COMMAND_OUTPUT_LIMIT", 200000);
const diffOutputLimit = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_DIFF_OUTPUT_LIMIT", 200000);
const allowed = String(process.env.CLAWSWEEPER_OPENAI_COMPATIBLE_ALLOWED_FILES || "")
  .split(/[,:]/)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.normalize(entry));

if (!apiKey) throw new Error(`missing API key in ${apiKeyEnv}`);

const optionalToolArgs = new Set([
  "start",
  "end",
  "offset",
  "limit",
  "timeoutMs",
  "path",
  "maxResults",
  "replaceAll",
]);

const allTools = [
  tool(
    "read_file",
    "Read a UTF-8 text file under the target repository. Optional offset/limit are 1-based line controls.",
    {
      path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
      start: { type: "number" },
      end: { type: "number" },
    },
  ),
  tool("read_file_range", "Read a UTF-8 text file line range under the target repository.", {
    path: { type: "string" },
    start: { type: "number" },
    end: { type: "number" },
  }),
  tool(
    "write_file",
    "Write a complete UTF-8 text file under the target repository. Use only when whole-file replacement is intended.",
    {
      path: { type: "string" },
      content: { type: "string" },
    },
  ),
  tool(
    "replace_in_file",
    "Replace an exact string in a file. Safer than write_file for small localized edits.",
    {
      path: { type: "string" },
      search: { type: "string" },
      replacement: { type: "string" },
      replaceAll: { type: "boolean" },
    },
  ),
  tool("run_command", "Run a short validation command in the target repository.", {
    command: { type: "string" },
    timeoutMs: { type: "number" },
  }),
  tool(
    "search_files",
    "Search repository text with grep. Use this instead of broad shell exploration.",
    {
      pattern: { type: "string" },
      path: { type: "string" },
      maxResults: { type: "number" },
    },
  ),
  tool("apply_patch", "Apply a unified diff patch to the target repository.", {
    patch: { type: "string" },
  }),
  tool("git_diff", "Return git status and git diff for the target repository.", {}),
];
const readOnlyToolNames = new Set(["read_file", "read_file_range", "search_files", "git_diff"]);
const tools = readOnlySandbox
  ? allTools.filter((toolEntry) => readOnlyToolNames.has(toolEntry.function.name))
  : allTools;
const allowedToolNames = tools.map((toolEntry) => toolEntry.function.name);

async function main() {
  const rawPrompt = fs.readFileSync(0, "utf8");
  const prompt = compactRepairOnlyPrompt(rawPrompt);
  const schemaInstruction = outputSchema
    ? `The final answer must be valid JSON matching the requested output schema path: ${outputSchema}. Do not wrap JSON in markdown.`
    : "For implementation tasks, summarize the changes made and validation run.";
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are emulating `codex exec` for ClawSweeper.",
        "Follow the stdin prompt exactly; do not invent a different workflow or role.",
        `The target checkout, branch, and sandbox have already been prepared by ClawSweeper. Sandbox: ${sandbox}.`,
        readOnlySandbox
          ? "Read-only sandbox is active: write_file, replace_in_file, apply_patch, and run_command are unavailable. Use read_file, read_file_range, search_files, and git_diff only."
          : "Write-capable sandbox is active: use write_file, replace_in_file, apply_patch, and run_command only when necessary.",
        "When the repair prompt asks for repository inspection with rg/sed/git, use the available tools exposed in this request.",
        "If the repair prompt names a pull request or source_pr URL and read-only gh is available, inspect PR comments, reviews, review threads, and check status with gh before deciding what to edit.",
        readOnlySandbox
          ? "Do not attempt edits in this planning pass; return a schema-valid repair result based on read-only evidence."
          : "Make the narrowest concrete edit that satisfies the fix artifact.",
        readOnlySandbox
          ? "Write tools are intentionally unavailable in read-only mode."
          : "Prefer replace_in_file for localized edits. Use write_file only for intended whole-file replacement.",
        "Do not push, open PRs, comment, label, merge, or inspect secrets.",
        "Before returning, ensure git_diff reflects the intended change and summarize the validation you ran.",
        "Use tools to inspect and edit files. Do not pretend to use tools.",
        "Repair-only mode: the prompt already identifies the PR and concrete repair signals. Do not perform a broad repository audit.",
        "Inspect only the source PR/comment/check evidence and the smallest relevant file ranges needed to fix that signal.",
        "After a concrete issue is verified, edit immediately, run narrow validation, then stop and return the required JSON.",
        "If you cannot verify and edit within a small number of tool calls, return a schema-valid blocked/needs_human result instead of continuing exploration.",
        "For pr-repair-intake jobs, do not emit keep_canonical/merge/close verdicts. The deterministic intake already found a current repair signal.",
        "For pr-repair-intake jobs, emit fix_needed plus build_fix_artifact when repair is possible; otherwise emit needs_human with exact blocker evidence.",
        `Target repository cwd: ${cwd}.`,
        readOnlySandbox
          ? "Allowed write files: none in read-only sandbox."
          : `Allowed write files: ${allowed.join(", ") || "all files under cwd"}.`,
        schemaInstruction,
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ];
  let finalContent = "";
  let exhausted = true;
  let toolsExecuted = 0;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const data = await chat(messages, turn + 1, true);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("missing assistant message");
    messages.push(msg);
    if (msg.content) {
      finalContent = String(msg.content);
      process.stdout.write(`assistant:\n${finalContent}\n`);
    }
    const calls = normalizeToolCalls(
      ((msg.tool_calls ?? []) as ToolCall[]).concat(pseudoToolCalls(msg.content, allowedToolNames)),
      allowedToolNames,
    );
    process.stderr.write(`[openai-compatible-tools] turn=${turn + 1} tool_calls=${calls.length}\n`);
    if (calls.length === 0) {
      const validationErrors = validateFinalContent(finalContent);
      if (outputSchema && validationErrors.length > 0) {
        if (outputSchema.endsWith("codex-result.schema.json")) {
          if (looksLikeCodexResultCandidate(finalContent)) {
            const normalized = normalizeCodexResult(finalContent, rawPrompt, worktreeHasDiff());
            const normalizedErrors = validateFinalContent(normalized);
            if (normalizedErrors.length === 0) {
              if (isPrematureNeedsHuman(normalized, rawPrompt, toolsExecuted)) {
                messages.push({
                  role: "user",
                  content: [
                    "Do not return needs_human before inspecting the prepared source PR ref.",
                    "The prompt includes Source PR refs. Use run_command/read_file_range/git diff/git show to inspect them now.",
                    "Only return needs_human after tool evidence proves an exact blocker.",
                  ].join("\n"),
                });
                finalContent = "";
                continue;
              }
              finalContent = normalized;
              exhausted = false;
              break;
            }
          }
          if (toolsExecuted > 0) {
            messages.push({
              role: "user",
              content: [
                "Your previous assistant message was neither a supported tool call nor valid final JSON.",
                "Continue the repair run: either use a supported tool call, or return final JSON matching the requested schema.",
                "Do not return prose-only analysis.",
              ].join("\n"),
            });
            finalContent = "";
            continue;
          }
        }
        messages.push({
          role: "user",
          content: [
            "Your previous final answer did not satisfy the requested structured output contract.",
            `Return only valid JSON matching this schema path: ${outputSchema}.`,
            "Do not use markdown. Do not include explanatory prose outside the JSON object.",
            "Validation failures:",
            ...validationErrors.slice(0, 20).map((error: string) => `- ${error}`),
          ].join("\n"),
        });
        continue;
      }
      exhausted = false;
      break;
    }
    for (const call of calls) {
      process.stdout.write(`tool_call: ${call.function.name} ${call.function.arguments || "{}"}\n`);
      const result = executeTool(call);
      toolsExecuted += 1;
      process.stdout.write(`tool_result: ${truncate(result.content, 2000)}\n`);
      messages.push(result);
    }
  }
  const diffExistsAtEnd = worktreeHasDiff();
  if (exhausted && outputSchema && outputSchema.endsWith("codex-result.schema.json")) {
    if (toolsExecuted > 0) {
      process.stderr.write(
        "[openai-compatible-tools] finalization_start reason=max_turns_after_tools\n",
      );
      const finalMessages: Message[] = [
        {
          role: "system",
          content: [
            "You are producing the final ClawSweeper repair result.",
            "Tools are unavailable. Do not call tools. Do not emit DSML/tool_calls.",
            "Return JSON only. No markdown. No prose outside JSON.",
          ].join("\n"),
        },
        {
          role: "user",
          content: buildFinalizationPrompt(rawPrompt, messages, diffExistsAtEnd, outputSchema),
        },
      ];
      const data = await chat(finalMessages, maxTurns + 1, false);
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("missing final assistant message");
      finalContent = String(msg.content ?? "");
      if (finalContent) process.stdout.write(`assistant_finalization:\n${finalContent}\n`);
    }
    finalContent = normalizeCodexResult(finalContent, rawPrompt, diffExistsAtEnd);
    exhausted = false;
  } else if (exhausted && outputSchema) {
    messages.push({
      role: "user",
      content: [
        "Tool budget is exhausted. Do not call tools again.",
        `Return only valid JSON matching this schema path: ${outputSchema}.`,
        "Base the decision on the evidence already collected and the current git diff.",
        "If evidence or changes are insufficient, return a conservative blocked or needs_human result that still satisfies the schema.",
        "Do not use markdown. Do not include prose outside the JSON object.",
      ].join("\n"),
    });
    const data = await chat(messages, maxTurns + 1, false);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("missing final assistant message");
    finalContent = String(msg.content ?? "");
    if (finalContent) process.stdout.write(`assistant:\n${finalContent}\n`);
  } else if (exhausted) {
    finalContent = JSON.stringify({
      status: diffExistsAtEnd ? "completed_with_diff" : "blocked",
      reason: `openai-compatible-tools max_turns_exhausted after ${maxTurns} turns`,
      partial_summary: finalContent || null,
    });
  }
  if (outputSchema && outputSchema.endsWith("codex-result.schema.json"))
    finalContent = normalizeCodexResult(finalContent, rawPrompt, diffExistsAtEnd);
  let finalValidationErrors = validateFinalContent(finalContent);
  if (
    outputSchema &&
    finalValidationErrors.length > 0 &&
    finalContent.trim() &&
    !outputSchema.endsWith("codex-result.schema.json")
  ) {
    process.stderr.write(
      "[openai-compatible-tools] schema_repair_start errors=" +
        JSON.stringify(finalValidationErrors.slice(0, 20)) +
        "\n",
    );
    const repairMessages: Message[] = [
      {
        role: "system",
        content: [
          "You are emulating `codex exec --output-schema` for ClawSweeper.",
          "Repair the provided JSON so it satisfies the requested JSON schema.",
          "Return only the corrected JSON object. Do not use markdown or explanatory prose.",
          "Do not add properties that are not allowed by the schema.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Schema path: ${outputSchema}`,
          "Validation failures:",
          ...finalValidationErrors.slice(0, 40).map((error: string) => `- ${error}`),
          "Current JSON candidate:",
          normalizeFinalContent(finalContent).trim(),
        ].join("\n"),
      },
    ];
    const repair = await chat(repairMessages, maxTurns + 2, false);
    const repairMsg = repair.choices?.[0]?.message;
    if (repairMsg?.content) {
      finalContent = String(repairMsg.content);
      process.stdout.write(`assistant_schema_repair:\n${finalContent}\n`);
      finalValidationErrors = validateFinalContent(finalContent);
    }
  }
  if (outputSchema && finalValidationErrors.length > 0) {
    process.stderr.write(
      "[openai-compatible-tools] schema_invalid errors=" +
        JSON.stringify(finalValidationErrors.slice(0, 20)) +
        "\n",
    );
    finalDiffSummary();
    if (!outputSchema.endsWith("codex-result.schema.json")) process.exit(2);
    finalContent = normalizeCodexResult(finalContent, rawPrompt, diffExistsAtEnd);
    finalValidationErrors = validateFinalContent(finalContent);
    if (finalValidationErrors.length > 0) process.exit(2);
  }
  if (outputLastMessage) {
    fs.mkdirSync(path.dirname(path.resolve(outputLastMessage)), { recursive: true });
    fs.writeFileSync(outputLastMessage, normalizeFinalContent(finalContent));
  }
  finalDiffSummary();
  if (exhausted && !diffExistsAtEnd && !outputSchema.endsWith("codex-result.schema.json"))
    process.exit(2);
}

async function chat(messages: Message[], turn: number, allowTools: boolean): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: 0,
    };
    if (maxTokens > 0) payload.max_tokens = maxTokens;
    if (allowTools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    if (outputSchema && !allowTools) payload.response_format = { type: "json_object" };
    const body = JSON.stringify(payload);
    const startedAt = Date.now();
    process.stderr.write(
      `[openai-compatible-tools] chat_start turn=${turn} attempt=${attempt}/${maxRetries} messages=${messages.length} bytes=${Buffer.byteLength(body)} timeout_ms=${requestTimeoutMs} max_tokens=${maxTokens > 0 ? maxTokens : "provider_default"}\n`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let res: Response;
    let text = "";
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      process.stderr.write(
        `[openai-compatible-tools] chat_error turn=${turn} attempt=${attempt}/${maxRetries} elapsed_ms=${elapsed} error=${truncate(error instanceof Error ? error.message : String(error), 300)}\n`,
      );
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw new Error(
        `OpenAI-compatible backend request failed after ${elapsed}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
    const elapsed = Date.now() - startedAt;
    process.stderr.write(
      `[openai-compatible-tools] chat_done turn=${turn} attempt=${attempt}/${maxRetries} status=${res.status} elapsed_ms=${elapsed} response_bytes=${Buffer.byteLength(text)}\n`,
    );
    if (!res.ok) {
      if ([429, 502, 503, 504].includes(res.status) && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw new Error(`OpenAI-compatible backend HTTP ${res.status}: ${truncate(text, 1000)}`);
    }
    return JSON.parse(text);
  }
  throw new Error("OpenAI-compatible backend retry exhausted");
}

function compactRepairOnlyPrompt(prompt: string): string {
  if (!prompt.includes("source: pr-repair-intake") && !prompt.includes("# Repair-only PR intake")) {
    return prompt;
  }
  const jobStart = prompt.indexOf("## Job file");
  const evidenceStart = prompt.indexOf("## Repair evidence pack");
  const preflightStart = prompt.indexOf("## Cluster preflight artifact");
  const jobSectionEnd = [evidenceStart, preflightStart].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const jobSection =
    jobStart >= 0
      ? prompt.slice(jobStart, jobSectionEnd ?? undefined)
      : prompt;
  const evidencePack =
    evidenceStart >= 0
      ? prompt.slice(evidenceStart, preflightStart >= 0 ? preflightStart : evidenceStart + 36000)
      : "";
  const preflight = preflightStart >= 0 ? prompt.slice(preflightStart, preflightStart + 6000) : "";
  const sourceRefsStart = prompt.indexOf("## Source PR refs");
  const requiredOutputStart = prompt.indexOf("## Required final output");
  const sourceRefs =
    sourceRefsStart >= 0
      ? prompt.slice(
          sourceRefsStart,
          requiredOutputStart >= 0 ? requiredOutputStart : sourceRefsStart + 4000,
        )
      : "";
  return [
    "# Compact repair-only ClawSweeper prompt",
    "",
    "This is a deterministic pr-repair-intake job. A current repair signal already exists.",
    "Do not perform a normal review verdict. Do not return keep_canonical just because the PR is approved or clean.",
    "Required outcome: produce a schema-valid repair result with fix_needed/build_fix_artifact, or needs_human/blocked with exact blocker evidence.",
    "Focus on the repair evidence pack first: repair_signals, evidence_gates, likely_files, changed_files, and relevant_hunks.",
    "If evidence_gates.source_pr_diff_read/actionable_signal_read/relevant_hunk_read are true, you may return final JSON immediately without exploratory tools.",
    "Do not waste tool turns on git branch, git log, or generic status checks; those are not repair evidence.",
    "If you use tools, inspect only the source diff or relevant file hunks named by the evidence pack, for example git diff <diff_ref> -- <likely_files>.",
    "If a source PR branch needs repair, use repair_strategy=repair_contributor_branch and source_prs with the full PR URL.",
    "Do not push, merge, close, comment, or label.",
    "",
    evidencePack.trim(),
    "",
    jobSection.trim(),
    "",
    sourceRefs.trim(),
    "",
    preflight.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

function commandFromArgs(parsed: Record<string, unknown>): string {
  const direct = typeof parsed.command === "string" ? parsed.command.trim() : "";
  if (direct && direct !== "undefined") return direct;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim() && value.trim() !== "command") continue;
    const candidate = key.trim();
    if (/^(git|sed|awk|grep|cat|head|tail|bash|sh|npm|pnpm|python3?|node)\b/.test(candidate))
      return candidate;
  }
  return "";
}


function rewriteUnsupportedGhPrView(command: string): string | null {
  if (!/\bgh\s+pr\s+view\b/.test(command)) return null;
  if (!/--json\s+[^\n]*(reviews|reviewRequests|comments)/.test(command)) return null;
  const number = command.match(/\bgh\s+pr\s+view\s+(\d+)\b/)?.[1];
  const repo = command.match(/--repo\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/)?.[1];
  if (!number) return null;
  const repoSetup = repo
    ? ""
    : "REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\\.git$##'); if [ -z \"$REPO\" ]; then echo '{\"source\":\"gh_api_rest_rewrite\",\"error\":\"repo_inference_failed\"}'; exit 2; fi; BASE=\"repos/$REPO\"";
  const base = repo ? shellQuote(`repos/${repo}`) : '"$BASE"';
  const pr = shellQuote(number);
  return [
    repoSetup,
    "echo '{\"source\":\"gh_api_rest_rewrite\",\"reason\":\"gh pr view review/comment fields use GraphQL fields that can require extra org scopes; using REST with the same GH_TOKEN\",\"review_comments\":'",
    `gh api ${base}/pulls/${pr}/comments --jq '[.[] | {path,line,side,user:.user.login,body,html_url,created_at}]'`,
    "echo ',\"reviews\":'",
    `gh api ${base}/pulls/${pr}/reviews --jq '[.[] | {state,user:.user.login,body,html_url,submitted_at}]'`,
    "echo ',\"issue_comments\":'",
    `gh api ${base}/issues/${pr}/comments --jq '[.[] | {user:.user.login,body,html_url,created_at}]'`,
    "echo '}'",
  ].filter(Boolean).join(" && ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function executeTool(call: ToolCall): Message {
  if (!allowedToolNames.includes(call.function.name)) {
    return toolResult(call.id, {
      ok: false,
      error: `tool not allowed by sandbox ${sandbox}: ${call.function.name}`,
    });
  }
  let parsed: any = {};
  try {
    parsed = JSON.parse(call.function.arguments || "{}");
  } catch (error) {
    return toolResult(call.id, { ok: false, error: `bad JSON args: ${String(error)}` });
  }
  try {
    if (call.function.name === "read_file") {
      const { rel, abs } = assertPath(parsed.path, false);
      const range = lineRange(parsed);
      if (range) return readFileRange(call.id, rel, abs, range.start, range.end);
      return readFileRange(call.id, rel, abs, 1, defaultReadLineEnd(abs));
    }
    if (call.function.name === "read_file_range") {
      const { rel, abs } = assertPath(parsed.path, false);
      const start = Math.max(1, Number(parsed.start || 1));
      const end = Math.max(start, Number(parsed.end || start));
      return readFileRange(call.id, rel, abs, start, end);
    }
    if (call.function.name === "write_file") {
      const { rel, abs } = assertPath(parsed.path, true);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(parsed.content ?? ""));
      return toolResult(call.id, {
        ok: true,
        path: rel,
        bytes: Buffer.byteLength(String(parsed.content ?? "")),
      });
    }
    if (call.function.name === "replace_in_file") {
      const { rel, abs } = assertPath(parsed.path, true);
      const search = String(parsed.search ?? "");
      const replacement = String(parsed.replacement ?? "");
      const replaceAll = parsed.replaceAll === true;
      if (!search) return toolResult(call.id, { ok: false, error: "missing search" });
      const before = fs.readFileSync(abs, "utf8");
      const occurrences = before.split(search).length - 1;
      if (occurrences === 0)
        return toolResult(call.id, { ok: false, path: rel, error: "search string not found" });
      if (occurrences > 1 && !replaceAll) {
        return toolResult(call.id, {
          ok: false,
          path: rel,
          error: `search string matched ${occurrences} times; set replaceAll=true or use a more specific search`,
        });
      }
      const after = replaceAll
        ? before.split(search).join(replacement)
        : before.replace(search, replacement);
      fs.writeFileSync(abs, after);
      return toolResult(call.id, {
        ok: true,
        path: rel,
        occurrences,
        replaceAll,
        bytes: Buffer.byteLength(after),
      });
    }
    if (call.function.name === "run_command") {
      let command = commandFromArgs(parsed);
      if (!command) return toolResult(call.id, { ok: false, error: "missing command" });
      command = rewriteUnsupportedGhPrView(command) ?? command;
      const timeout = Math.min(Number(parsed.timeoutMs || commandTimeoutMs), commandTimeoutMs);
      const result = spawnSync("bash", ["-lc", command], {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: 1024 * 1024,
      });
      return toolResult(call.id, {
        ok: result.status === 0,
        status: result.status,
        signal: result.signal,
        stdout: truncate(result.stdout, commandOutputLimit),
        stderr: truncate(result.stderr, commandOutputLimit),
      });
    }
    if (call.function.name === "search_files") {
      const relPath = parsed.path ? assertPath(String(parsed.path), false).rel : ".";
      const maxResults = Math.max(1, Math.min(Number(parsed.maxResults || 50), 200));
      const pattern = String(parsed.pattern || "");
      if (!pattern.trim()) return toolResult(call.id, { ok: false, error: "missing pattern" });
      const result = spawnSync("grep", ["-RIn", "--exclude-dir=.git", "--", pattern, relPath], {
        cwd,
        encoding: "utf8",
        timeout: Math.min(commandTimeoutMs, 30000),
        maxBuffer: 1024 * 1024,
      });
      const lines = String(result.stdout || "")
        .split(/\n/)
        .filter(Boolean)
        .slice(0, maxResults);
      return toolResult(call.id, {
        ok: result.status === 0 || result.status === 1,
        status: result.status,
        pattern,
        path: relPath,
        matches: lines,
        truncated: lines.length >= maxResults,
        stderr: truncate(result.stderr, Math.min(commandOutputLimit, 2000)),
      });
    }
    if (call.function.name === "apply_patch") {
      const patch = String(parsed.patch || "");
      if (!patch.trim()) return toolResult(call.id, { ok: false, error: "missing patch" });
      const result = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
        cwd,
        input: patch,
        encoding: "utf8",
        timeout: Math.min(commandTimeoutMs, 30000),
        maxBuffer: 1024 * 1024,
      });
      return toolResult(call.id, {
        ok: result.status === 0,
        status: result.status,
        stdout: truncate(result.stdout, commandOutputLimit),
        stderr: truncate(result.stderr, commandOutputLimit),
      });
    }
    if (call.function.name === "git_diff") {
      const status = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
      const diff = spawnSync("git", ["diff", "--", "."], {
        cwd,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      });
      return toolResult(call.id, {
        ok: true,
        status: status.stdout,
        diff: truncate(diff.stdout, diffOutputLimit),
      });
    }
    return toolResult(call.id, { ok: false, error: `unknown tool ${call.function.name}` });
  } catch (error) {
    return toolResult(call.id, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function lineRange(parsed: Record<string, unknown>): { start: number; end: number } | null {
  const rawStart = parsed.start ?? parsed.offset;
  const rawEnd = parsed.end;
  const rawLimit = parsed.limit;
  if (rawStart === undefined && rawEnd === undefined && rawLimit === undefined) return null;
  const start = Math.max(1, Number(rawStart ?? 1));
  if (rawEnd !== undefined) return { start, end: Math.max(start, Number(rawEnd)) };
  const limit = Math.max(1, Number(rawLimit ?? 120));
  return { start, end: start + limit - 1 };
}

function defaultReadLineEnd(abs: string): number {
  const maxLines = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_READ_LINES", 1000);
  const lineCount = fs.readFileSync(abs, "utf8").split(/\n/).length;
  return Math.min(lineCount, maxLines);
}

function readFileRange(id: string, rel: string, abs: string, start: number, end: number): Message {
  const lines = fs.readFileSync(abs, "utf8").split(/\n/);
  const boundedEnd = Math.min(Math.max(start, end), lines.length);
  const content = lines
    .slice(start - 1, boundedEnd)
    .map((line, i) => `${start + i}: ${line}`)
    .join("\n");
  return toolResult(id, {
    ok: true,
    path: rel,
    start,
    end: boundedEnd,
    total_lines: lines.length,
    truncated_before: start > 1,
    truncated_after: boundedEnd < lines.length,
    content: truncate(content, readLimit),
  });
}

function tool(name: string, description: string, properties: Record<string, any>) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required: Object.keys(properties).filter((key) => !optionalToolArgs.has(key)),
      },
    },
  };
}

function toolResult(id: string, obj: unknown): Message {
  return { role: "tool", tool_call_id: id, content: JSON.stringify(obj) };
}

function assertPath(input: string, write: boolean) {
  const raw = String(input || "");
  const rawAbs = path.isAbsolute(raw) ? path.resolve(raw) : null;
  const abs = rawAbs ?? path.resolve(cwd, path.normalize(raw.replace(/^\/+/, "")));
  if (!abs.startsWith(cwd + path.sep) && abs !== cwd) throw new Error(`path outside cwd: ${input}`);
  const rel = path.relative(cwd, abs) || ".";
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`invalid repository path: ${input}`);
  if (write && allowed.length > 0 && !allowed.includes(rel)) {
    throw new Error(`write denied for ${rel}; allowed: ${allowed.join(", ")}`);
  }
  return { rel, abs };
}

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

function validateFinalContent(content: string): string[] {
  if (!outputSchema) return [];
  const normalized = normalizeFinalContent(content).trim();
  if (!normalized) return ["final output is empty"];
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    return [
      `final output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (!outputSchemaJson) return [];
  return validateSchemaValue(outputSchemaJson, parsed, "$", []).slice(0, 40);
}

function validateSchemaValue(schema: any, value: unknown, at: string, errors: string[]): string[] {
  if (!schema || typeof schema !== "object" || errors.length >= 40) return errors;
  if (Array.isArray(schema.anyOf)) {
    const alternatives = schema.anyOf.map((candidate: any) =>
      validateSchemaValue(candidate, value, at, []),
    );
    if (alternatives.some((candidateErrors: string[]) => candidateErrors.length === 0))
      return errors;
    errors.push(`${at} does not match any allowed schema variant`);
    return errors;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type: string) => schemaTypeMatches(type, value))) {
    errors.push(`${at} expected type ${types.join("|")}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(
      `${at} expected one of ${schema.enum.map((entry: unknown) => JSON.stringify(entry)).join(", ")}`,
    );
    return errors;
  }
  if (schema.type === "object" || (value && typeof value === "object" && !Array.isArray(value))) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${at}.${key} is required`);
      if (errors.length >= 40) return errors;
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) errors.push(`${at}.${key} is not allowed`);
        if (errors.length >= 40) return errors;
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in obj) validateSchemaValue(childSchema, obj[key], `${at}.${key}`, errors);
      if (errors.length >= 40) return errors;
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.slice(0, 20).forEach((entry, index) => {
      validateSchemaValue(schema.items, entry, `${at}[${index}]`, errors);
    });
  }
  return errors;
}

function schemaTypeMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function worktreeHasDiff(): boolean {
  const diff = spawnSync("git", ["diff", "--quiet", "--", "."], { cwd, encoding: "utf8" });
  return diff.status === 1;
}

function finalDiffSummary() {
  const status = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
  const stat = spawnSync("git", ["diff", "--stat"], { cwd, encoding: "utf8" });
  process.stdout.write(`RUNNER_FINAL_DIFF_EXISTS=${worktreeHasDiff() ? "1" : "0"}\n`);
  if (status.stdout) process.stdout.write(`RUNNER_FINAL_STATUS:\n${status.stdout}`);
  if (stat.stdout) process.stdout.write(`RUNNER_FINAL_DIFF_STAT:\n${stat.stdout}`);
}

function stringArg(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : fallback;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() === "") return fallback;
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function numberEnvZeroMeansUnlimited(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  if (value === 0) return Number.POSITIVE_INFINITY;
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function numberEnvAllowZero(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() === "") return 0;
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function truncate(value: unknown, limit = 12000): string {
  const text = String(value ?? "");
  return text.length > limit
    ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`
    : text;
}


main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
