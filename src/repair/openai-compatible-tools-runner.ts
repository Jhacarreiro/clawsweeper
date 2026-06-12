#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
const cwd = path.resolve(cd);
const baseUrl = requiredEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_BASE_URL").replace(/\/$/, "");
const model = requiredEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_MODEL");
const apiKeyEnv = process.env.CLAWSWEEPER_OPENAI_COMPATIBLE_API_KEY_ENV || "OPENAI_API_KEY";
const apiKey = process.env[apiKeyEnv] || "";
const maxTurns = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TURNS", 20);
const maxRetries = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_RETRIES", 1);
const readLimit = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_READ_LIMIT", 18000);
const commandTimeoutMs = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_COMMAND_TIMEOUT_MS", 120000);
const requestTimeoutMs = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS", 60000);
const maxTokens = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_TOKENS", 1400);
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

const tools = [
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

async function main() {
  const prompt = fs.readFileSync(0, "utf8");
  const schemaInstruction = outputSchema
    ? `The final answer must be valid JSON matching the requested output schema path: ${outputSchema}. Do not wrap JSON in markdown.`
    : "For implementation tasks, summarize the changes made and validation run.";
  const messages: Message[] = [
    {
      role: "system",
      content: [
        "You are ClawSweeper's coding worker.",
        "The user prompt is the ClawSweeper repair prompt. Follow it as the source of truth.",
        "The target checkout, branch, and sandbox have already been prepared by ClawSweeper.",
        "When the repair prompt asks for repository inspection with rg/sed/git, use the available tools: search_files, read_file_range, run_command, and git_diff.",
        "If the repair prompt names a pull request or source_pr URL and read-only gh is available, inspect PR comments, reviews, review threads, and check status with gh before deciding what to edit.",
        "Make the narrowest concrete edit that satisfies the fix artifact.",
        "Prefer replace_in_file for localized edits. Use write_file only for intended whole-file replacement.",
        "Do not push, open PRs, comment, label, merge, or inspect secrets.",
        "Before returning, ensure git_diff reflects the intended change and summarize the validation you ran.",
        "Use tools to inspect and edit files. Do not pretend to use tools.",
        `Target repository cwd: ${cwd}.`,
        `Allowed write files: ${allowed.join(", ") || "all files under cwd"}.`,
        schemaInstruction,
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ];
  let finalContent = "";
  let exhausted = true;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const data = await chat(messages, turn + 1);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("missing assistant message");
    messages.push(msg);
    if (msg.content) {
      finalContent = String(msg.content);
      process.stdout.write(`assistant:\n${finalContent}\n`);
    }
    const calls = (msg.tool_calls ?? []) as ToolCall[];
    process.stderr.write(`[openai-compatible-tools] turn=${turn + 1} tool_calls=${calls.length}\n`);
    if (calls.length === 0) {
      if (outputSchema && !isValidJson(finalContent)) {
        messages.push({
          role: "user",
          content: [
            "Your previous final answer was not valid JSON.",
            `Return only valid JSON matching this schema path: ${outputSchema}.`,
            "Do not use markdown. Do not include explanatory prose outside the JSON object.",
          ].join("\n"),
        });
        finalContent = "";
        continue;
      }
      exhausted = false;
      break;
    }
    for (const call of calls) {
      process.stdout.write(`tool_call: ${call.function.name} ${call.function.arguments || "{}"}\n`);
      const result = executeTool(call);
      process.stdout.write(`tool_result: ${truncate(result.content, 2000)}\n`);
      messages.push(result);
    }
  }
  const diffExistsAtEnd = worktreeHasDiff();
  if (exhausted) {
    finalContent = JSON.stringify({
      status: diffExistsAtEnd ? "completed_with_diff" : "blocked",
      reason: `openai-compatible-tools max_turns_exhausted after ${maxTurns} turns`,
      partial_summary: finalContent || null,
    });
  }
  if (outputLastMessage) {
    fs.mkdirSync(path.dirname(path.resolve(outputLastMessage)), { recursive: true });
    fs.writeFileSync(outputLastMessage, normalizeFinalContent(finalContent));
  }
  finalDiffSummary();
  if (exhausted && !diffExistsAtEnd) process.exit(2);
}

async function chat(messages: Message[], turn: number): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const body = JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0,
      max_tokens: maxTokens,
    });
    const startedAt = Date.now();
    process.stderr.write(
      `[openai-compatible-tools] chat_start turn=${turn} attempt=${attempt}/${maxRetries} messages=${messages.length} bytes=${Buffer.byteLength(body)} timeout_ms=${requestTimeoutMs} max_tokens=${maxTokens}\n`,
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

function executeTool(call: ToolCall): Message {
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
      const timeout = Math.min(Number(parsed.timeoutMs || commandTimeoutMs), commandTimeoutMs);
      const result = spawnSync("bash", ["-lc", String(parsed.command)], {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: 1024 * 1024,
      });
      return toolResult(call.id, {
        ok: result.status === 0,
        status: result.status,
        signal: result.signal,
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
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
        stderr: truncate(result.stderr, 2000),
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
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
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
        diff: truncate(diff.stdout, 50000),
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
  const maxLines = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_READ_LINES", 240);
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
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return `${(fenced?.[1] ?? trimmed).trim()}\n`;
}

function isValidJson(content: string): boolean {
  const normalized = normalizeFinalContent(content).trim();
  if (!normalized) return false;
  try {
    JSON.parse(normalized);
    return true;
  } catch {
    return false;
  }
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
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
