import assert from "node:assert/strict";
import test from "node:test";

import {
  changedFilesFromNameOnlyZ,
  changedFilesFromPorcelainStatusZ,
  enforceRepairCheckpointContract,
  repairCheckpointContract,
  validateRepairCheckpointContractShape,
} from "../../dist/repair/repair-checkpoint-contract.js";

test("repair contract is explicit and ignores incomplete likely_files", () => {
  assert.equal(repairCheckpointContract({ likely_files: ["src/a.ts"] }), null);
  assert.deepEqual(
    repairCheckpointContract({
      likely_files: ["src/a.ts"],
      repair_contract: { must_touch: ["src/a.ts"], match: "any", scope: "every_checkpoint" },
    }),
    { mustTouch: ["src/a.ts"], match: "any", scope: "every_checkpoint" },
  );
});

test("repair contract validates schema-level shape", () => {
  assert.deepEqual(validateRepairCheckpointContractShape({}), []);
  assert.deepEqual(
    validateRepairCheckpointContractShape({
      repair_contract: { must_touch: ["src/a.ts"], match: "any", scope: "every_checkpoint" },
    }),
    [],
  );
  assert.match(
    validateRepairCheckpointContractShape({
      repair_contract: { must_touch: ["../secret"], match: "one", scope: "whole_repair" },
    }).join("\n"),
    /unsafe path|match must be any or all|scope must be every_checkpoint/,
  );
  assert.match(
    validateRepairCheckpointContractShape({
      repair_contract: { must_touch: ["src/a.ts"], scope: "every_checkpoint" },
    }).join("\n"),
    /match must be any or all/,
  );
  assert.match(
    validateRepairCheckpointContractShape({
      repair_contract: { must_touch: ["src/a.ts"], match: "any" },
    }).join("\n"),
    /scope must be every_checkpoint/,
  );
  assert.match(
    validateRepairCheckpointContractShape({
      repair_contract: {
        must_touch: ["src/a.ts", 7],
        match: "any",
        scope: "every_checkpoint",
        extra: true,
      },
    }).join("\n"),
    /entries must be strings|extra is not allowed/,
  );
});

test("porcelain v1 z parser preserves spaces and rename destinations", () => {
  const status = [
    " M docs/file with space.md",
    "R  docs/new name.md",
    "docs/old name.md",
    "?? docs/untracked nested/file.md",
    "",
  ].join("\0");
  assert.deepEqual(changedFilesFromPorcelainStatusZ(status), [
    "docs/file with space.md",
    "docs/new name.md",
    "docs/untracked nested/file.md",
  ]);
});

test("name-only z parser preserves spaces", () => {
  assert.deepEqual(changedFilesFromNameOnlyZ("src/file with space.ts\0docs/guide.md\0"), [
    "src/file with space.ts",
    "docs/guide.md",
  ]);
});

test("checkpoint contract supports any and all semantics", () => {
  const status = " M src/a.ts\0 M src/b.ts\0";
  assert.doesNotThrow(() =>
    enforceRepairCheckpointContract({
      phase: "initial",
      status,
      fixArtifact: {
        repair_contract: {
          must_touch: ["src/a.ts", "src/c.ts"],
          match: "any",
          scope: "every_checkpoint",
        },
      },
    }),
  );
  assert.doesNotThrow(() =>
    enforceRepairCheckpointContract({
      phase: "base-sync-1",
      status: " M docs/other.md\0",
      changedFiles: ["src/a.ts"],
      fixArtifact: {
        repair_contract: {
          must_touch: ["src/a.ts"],
          match: "any",
          scope: "every_checkpoint",
        },
      },
    }),
  );
  assert.throws(
    () =>
      enforceRepairCheckpointContract({
        phase: "initial",
        status,
        fixArtifact: {
          repair_contract: {
            must_touch: ["src/a.ts", "src/c.ts"],
            match: "all",
            scope: "every_checkpoint",
          },
        },
      }),
    /repair checkpoint contract rejected initial/,
  );
});
