import assert from "node:assert/strict";
import test from "node:test";

import {
  dsmlToolCalls,
  normalizeToolCalls,
  pseudoToolCalls,
} from "../../dist/repair/openai-compatible/textual-tools.js";

const allowed = [
  "read_file",
  "read_file_range",
  "write_file",
  "replace_in_file",
  "run_command",
  "search_files",
  "apply_patch",
  "git_diff",
];

function argsOf(call: { function: { arguments?: string } }) {
  return JSON.parse(call.function.arguments || "{}");
}

test("normalizes native tool calls and strips unsupported args", () => {
  const calls = normalizeToolCalls(
    [
      {
        id: "native-1",
        function: {
          name: "run_command",
          arguments: JSON.stringify({ command: "git status", unexpected: true }),
        },
      },
    ],
    allowed,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, "native-1");
  assert.deepEqual(argsOf(calls[0]!), { command: "git status" });
});

test("parses loose JSON pseudo tool calls", () => {
  const calls = pseudoToolCalls(
    JSON.stringify({ type: "read_file_range", path: "src/index.ts", start: 1, end: 8 }),
    allowed,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.function.name, "read_file_range");
  assert.deepEqual(argsOf(calls[0]!), { path: "src/index.ts", start: 1, end: 8 });
});

test("parses OpenAI-like textual tool_calls array", () => {
  const calls = pseudoToolCalls(
    JSON.stringify({
      tool_calls: [
        { function: { name: "search_files", arguments: JSON.stringify({ pattern: "TODO", path: "src" }) } },
      ],
    }),
    allowed,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.function.name, "search_files");
  assert.deepEqual(argsOf(calls[0]!), { pattern: "TODO", path: "src" });
});

test("parses DSML invoke blocks", () => {
  const calls = dsmlToolCalls(
    '<｜DSML｜tool_calls><invoke name="read_file_range"><parameter name="path">src/a.ts</parameter><parameter name="start">2</parameter><parameter name="end">5</parameter></invoke></｜DSML｜tool_calls>',
    allowed,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.function.name, "read_file_range");
  assert.deepEqual(argsOf(calls[0]!), { path: "src/a.ts", start: 2, end: 5 });
});

test("rejects unknown tools and corrupted parameter keys", () => {
  assert.deepEqual(pseudoToolCalls(JSON.stringify({ type: "delete_everything", path: "." }), allowed), []);
  assert.deepEqual(
    pseudoToolCalls(JSON.stringify({ type: "read_file", "parameter name=path": "src/a.ts" }), allowed),
    [],
  );
});
