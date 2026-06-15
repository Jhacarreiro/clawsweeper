export type ToolCall = { id: string; function: { name: string; arguments?: string } };

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

export function normalizeToolCalls(calls: ToolCall[], allowedTools: readonly string[]): ToolCall[] {
  return calls.map((call, index) => normalizeToolCall(call, index, allowedTools)).filter(Boolean) as ToolCall[];
}

function normalizeToolCall(call: ToolCall, index: number, allowedTools: readonly string[]): ToolCall | null {
  const name = call.function?.name || "";
  if (!allowedTools.includes(name)) return null;
  let rawArgs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rawArgs = parsed;
  } catch {
    return null;
  }
  const args = sanitizePseudoArgs(name, rawArgs);
  if (!args) return null;
  return {
    id: call.id || `tool-${Date.now()}-${index}`,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function parseLooseObject(content: string): any {
  const t = normalizeFinalContent(content).trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return {};
}

export function pseudoToolCalls(content: unknown, allowedTools: readonly string[]): ToolCall[] {
  if (typeof content !== "string" || !content.trim()) return [];
  const parsed = parseLooseObject(content);
  const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [parsed];
  return calls
    .map((entry: unknown, index: number) => normalizePseudoToolCall(entry, index, allowedTools))
    .concat(dsmlToolCalls(content, allowedTools))
    .filter(Boolean) as ToolCall[];
}

export function dsmlToolCalls(content: string, allowedTools: readonly string[]): ToolCall[] {
  if (!content.includes("DSML") || !content.includes("invoke")) return [];
  const out: ToolCall[] = [];
  const invokeRe = /<[^>]*invoke name="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*invoke>/g;
  let invoke: RegExpExecArray | null;
  while ((invoke = invokeRe.exec(content))) {
    const name = invoke[1] || "";
    const body = invoke[2] || "";
    const args: Record<string, unknown> = {};
    const paramRe = /<[^>]*parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*parameter>/g;
    let param: RegExpExecArray | null;
    while ((param = paramRe.exec(body))) {
      const key = param[1] || "";
      const raw = (param[2] || "").trim();
      if (key) args[key] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    }
    const normalized = normalizePseudoToolCall({ type: name, ...args }, out.length, allowedTools);
    if (normalized) out.push(normalized);
  }
  return out;
}

function normalizePseudoToolCall(entry: unknown, index: number, allowedTools: readonly string[]): ToolCall | null {
  const item =
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
  const fn =
    item.function && typeof item.function === "object" && !Array.isArray(item.function)
      ? (item.function as Record<string, unknown>)
      : null;
  const name =
    typeof item.name === "string"
      ? item.name
      : typeof item.type === "string"
        ? item.type
        : typeof item.tool === "string"
          ? item.tool
          : typeof fn?.name === "string"
            ? fn.name
            : "";
  if (!allowedTools.includes(name)) return null;

  const rawArgs = pseudoArgs(item, fn);
  const args = sanitizePseudoArgs(name, rawArgs);
  if (!args) return null;
  return {
    id: `pseudo-${Date.now()}-${index}`,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function pseudoArgs(
  item: Record<string, unknown>,
  fn: Record<string, unknown> | null,
): Record<string, unknown> {
  const candidate = item.arguments ?? fn?.arguments ?? item.input ?? item.parameters ?? item.params;
  if (typeof candidate === "string") {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {}
  }
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate))
    return candidate as Record<string, unknown>;
  return { ...item };
}

function sanitizePseudoArgs(
  name: string,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> | null {
  const args: Record<string, unknown> = { ...rawArgs };
  for (const key of [
    "name",
    "type",
    "tool",
    "function",
    "arguments",
    "tool_calls",
    "reply",
    "input",
    "parameters",
    "params",
  ])
    delete args[key];
  if (Object.keys(args).some((key) => key.includes("｜") || key.includes("parameter name")))
    return null;
  if (name === "run_command") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command || command === "undefined") return null;
    return pickArgs(args, ["command", "timeoutMs"]);
  }
  if (name === "read_file" || name === "read_file_range") {
    if (typeof args.path !== "string" || !args.path.trim()) return null;
    return pickArgs(args, ["path", "offset", "limit", "start", "end"]);
  }
  if (name === "write_file") {
    if (typeof args.path !== "string" || typeof args.content !== "string") return null;
    return pickArgs(args, ["path", "content"]);
  }
  if (name === "replace_in_file") {
    if (
      typeof args.path !== "string" ||
      typeof args.search !== "string" ||
      typeof args.replacement !== "string"
    )
      return null;
    return pickArgs(args, ["path", "search", "replacement", "replaceAll"]);
  }
  if (name === "search_files") {
    if (typeof args.pattern !== "string" || !args.pattern.trim()) return null;
    return pickArgs(args, ["pattern", "path", "maxResults"]);
  }
  if (name === "apply_patch") {
    if (typeof args.patch !== "string" || !args.patch.trim()) return null;
    return pickArgs(args, ["patch"]);
  }
  if (name === "git_diff") return {};
  return args;
}

function pickArgs(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}


