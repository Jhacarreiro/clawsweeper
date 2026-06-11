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
const allowed = String(process.env.CLAWSWEEPER_OPENAI_COMPATIBLE_ALLOWED_FILES || "")
  .split(/[,:]/)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.normalize(entry));

if (!apiKey) throw new Error(`missing API key in ${apiKeyEnv}`);

const tools = [
  tool("read_file", "Read a UTF-8 text file under the target repository.", {
    path: { type: "string" },
  }),
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
    if (calls.length === 0) break;
    for (const call of calls) {
      process.stdout.write(`tool_call: ${call.function.name} ${call.function.arguments || "{}"}\n`);
      const result = executeTool(call);
      process.stdout.write(`tool_result: ${truncate(result.content, 2000)}\n`);
      messages.push(result);
    }
  }
  if (outputLastMessage) {
    fs.mkdirSync(path.dirname(path.resolve(outputLastMessage)), { recursive: true });
    fs.writeFileSync(outputLastMessage, normalizeFinalContent(finalContent));
  }
  finalDiffSummary();
}

async function chat(messages: Message[]): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.1 }),
    });
    const text = await res.text();
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
      return toolResult(call.id, {
        ok: true,
        path: rel,
        content: truncate(fs.readFileSync(abs, "utf8"), readLimit),
      });
    }
    if (call.function.name === "read_file_range") {
      const { rel, abs } = assertPath(parsed.path, false);
      const start = Math.max(1, Number(parsed.start || 1));
      const end = Math.max(start, Number(parsed.end || start));
      const lines = fs.readFileSync(abs, "utf8").split(/\n/);
      const content = lines
        .slice(start - 1, end)
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n");
      return toolResult(call.id, {
        ok: true,
        path: rel,
        start,
        end,
        content: truncate(content, readLimit),
      });
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

function tool(name: string, description: string, properties: Record<string, any>) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required: Object.keys(properties).filter(
          (key) => !["start", "end", "timeoutMs"].includes(key),
        ),
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
