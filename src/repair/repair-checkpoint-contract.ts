import type { JsonValue, LooseRecord } from "./json-types.js";

export interface RepairCheckpointContract {
  mustTouch: string[];
  match: "any" | "all";
  scope: "every_checkpoint";
}

export function repairCheckpointContract(
  fixArtifact: LooseRecord,
): RepairCheckpointContract | null {
  const raw = fixArtifact.repair_contract;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const mustTouch = uniqueStrings(
    jsonStringArray(raw.must_touch).map(normalizeRepairContractPath).filter(Boolean),
  );
  if (mustTouch.length === 0) return null;
  return {
    mustTouch,
    match: raw.match === "all" ? "all" : "any",
    scope: "every_checkpoint",
  };
}

export function enforceRepairCheckpointContract({
  fixArtifact,
  phase,
  status,
}: {
  fixArtifact: LooseRecord;
  phase: JsonValue;
  status: string;
}): void {
  const contract = repairCheckpointContract(fixArtifact);
  if (!contract) return;

  const changedFiles = changedFilesFromPorcelainStatusZ(status);
  const matched = contract.mustTouch.filter((expected) =>
    changedFiles.some((file) => changedFileMatchesContract(file, expected)),
  );
  const ok =
    contract.match === "all" ? matched.length === contract.mustTouch.length : matched.length > 0;
  if (ok) return;

  throw new Error(
    [
      `repair checkpoint contract rejected ${String(phase || "checkpoint")}: no required repair_contract.must_touch file changed`,
      `match=${contract.match}`,
      `must_touch=${contract.mustTouch.join(", ")}`,
      `changed_files=${changedFiles.join(", ") || "none"}`,
    ].join("; "),
  );
}

export function changedFilesFromPorcelainStatusZ(status: string): string[] {
  const fields = status.split("\0").filter(Boolean);
  const out: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = normalizeRepairContractPath(entry.slice(3));
    if (file) out.push(file);
    if ((code.includes("R") || code.includes("C")) && fields[index + 1]) index += 1;
  }
  return uniqueStrings(out);
}

export function validateRepairCheckpointContractShape(fixArtifact: LooseRecord): string[] {
  const raw = fixArtifact.repair_contract;
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return ["fix_artifact.repair_contract must be an object when present"];
  }

  const errors: string[] = [];
  if (!Array.isArray(raw.must_touch) || raw.must_touch.length === 0) {
    errors.push("fix_artifact.repair_contract.must_touch must be a non-empty list");
  }
  for (const value of raw.must_touch ?? []) {
    if (!normalizeRepairContractPath(value)) {
      errors.push(
        `fix_artifact.repair_contract.must_touch contains an unsafe path: ${String(value)}`,
      );
    }
  }
  if (raw.match !== undefined && raw.match !== "any" && raw.match !== "all") {
    errors.push("fix_artifact.repair_contract.match must be any or all");
  }
  if (raw.scope !== undefined && raw.scope !== "every_checkpoint") {
    errors.push("fix_artifact.repair_contract.scope must be every_checkpoint");
  }
  return errors;
}

function jsonStringArray(value: JsonValue): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function changedFileMatchesContract(changedFile: string, expected: string): boolean {
  const prefix = expected.replace(/\/$/, "");
  return changedFile === expected || changedFile.startsWith(`${prefix}/`);
}

function normalizeRepairContractPath(value: JsonValue): string {
  const pathValue = String(value ?? "").trim();
  if (!pathValue || pathValue.startsWith("/") || pathValue.includes("\0")) return "";
  if (/[`$;&|<>()[\]{}*?~]/.test(pathValue)) return "";
  if (pathValue.split(/[\\/]/).includes("..")) return "";
  return pathValue.replace(/^\.\//, "");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
