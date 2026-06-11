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
const maxRetries = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_MAX_RETRIES", 3);
const readLimit = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_READ_LIMIT", 18000);
const commandTimeoutMs = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_COMMAND_TIMEOUT_MS", 120000);
const requestTimeoutMs = numberEnv("CLAWSWEEPER_OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS", 120000);
const allowed = String(process.env.CLAWSWEEPER_OPENAI_COMPATIBLE_ALLOWED_FILES || "")
  .split(/[,:]/)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.normalize(entry));

if (!apiKey) throw new Error(`missing API key in ${apiKeyEnv}`);

const optionalToolArgs = new Set(["start", "end", "offset", "limit", "timeoutMs"]);

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
  tool("write_file", "Write a complete UTF-8 text file under the target repository.", {
    path: { type: "string" },
    content: { type: "string" },
  }),
  tool("run_command", "Run a short validation command in the target repository.", {
    command: { type: "string" },
    timeoutMs: { type: "number" },
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
        "You are ClawSweeper's OpenAI-compatible coding worker.",
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
    const data = await chat(messages);
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
  if (exhausted) {
    finalContent = JSON.stringify({
      status: "blocked",
      reason: `openai-compatible-tools max_turns_exhausted after ${maxTurns} turns`,
      partial_summary: finalContent || null,
    });
  }
  if (outputLastMessage) {
    fs.mkdirSync(path.dirname(path.resolve(outputLastMessage)), { recursive: true });
    fs.writeFileSync(outputLastMessage, normalizeFinalContent(finalContent));
  }
  finalDiffSummary();
  if (exhausted) process.exit(2);
}

async function chat(messages: Message[]): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let res: Response;
    let text = "";
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.1 }),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (error) {
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      throw new Error(
        `OpenAI-compatible backend request failed after ${requestTimeoutMs}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
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
  const rel = path.normalize(String(input || "").replace(/^\/+/, ""));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`invalid relative path: ${input}`);
  const abs = path.resolve(cwd, rel);
  if (!abs.startsWith(cwd + path.sep) && abs !== cwd) throw new Error(`path outside cwd: ${input}`);
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

function finalDiffSummary() {
  const status = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
  const stat = spawnSync("git", ["diff", "--stat"], { cwd, encoding: "utf8" });
  process.stdout.write(`RUNNER_FINAL_DIFF_EXISTS=${status.stdout.trim() ? "1" : "0"}\n`);
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
