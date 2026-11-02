import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BLOCK_KINDS, EDGE_KINDS, IMPORT_WARNING_KINDS, LANGS, TRIGGERS, canContain, parseSignature, type Block, type Board, type Kind, type Lang } from "./board";
import { DEFAULT_MODULE, serialize } from "./serialize";

const KINDS = new Set<string>(BLOCK_KINDS);

const isText = (v: unknown) => typeof v === "string";
const isTextList = (v: unknown) => Array.isArray(v) && v.every(isText);
const isParamList = (v: unknown) =>
  Array.isArray(v) && v.every((p) => typeof p === "object" && p !== null && isText(p.name) && isText(p.type));
// The kind-specific fields each block must carry, with their check.
const FIELDS: Record<Kind, [string, (v: unknown) => boolean][]> = {
  module: [],
  class: [],
  interface: [],
  function: [["inputs", isParamList], ["returns", isText], ["errors", isTextList], ["intent", isText], ["steps", isTextList]],
  field: [["type", isText]],
  constant: [["type", isText], ["value", isText]],
  type: [["shape", (v) => v === "struct" || v === "enum"], ["members", isTextList]],
  library: [
    ["overrides", (v) => typeof v === "object" && v !== null && Object.entries(v).every(([k, x]) => LANGS.includes(k as Lang) && isText(x))],
  ],
  service: [["description", isText]],
  entry: [["trigger", (v) => TRIGGERS.includes(v as never)], ["detail", isText]],
};

export function archPath(boardPath: string): string {
  return boardPath.replace(/\.chisel\.json$/, "") + ".arch.md";
}

export function saveBoard(path: string, board: Board): void {
  validate(board);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path,JSON.stringify(board, null, 2) + "\n");
  writeFileSync(archPath(path), serialize(board).arch);
}

export function loadBoard(path: string): Board {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`${path} is not valid JSON: ${e.message}`);
    throw e;
  }
  return validate(data);
}

// Version 1 stored a function's signature as loose text. Version 2 splits it into inputs, a return and errors,
// and pins every block, so an old board opens exactly where its blocks were.
function migrateV1(old: { version: 1; blocks: unknown }): unknown {
  if (!Array.isArray(old.blocks)) return { ...old, version: 2 };
  const blocks = old.blocks.map((x) => {
    if (typeof x !== "object" || x === null) return x;
    if (x.kind !== "function" || typeof x.signature !== "string") return { ...x, pinned: true };
    const { signature, ...rest } = x;
    const { inputs, returns, loose } = parseSignature(signature);
    const warning = { kind: "loose-signature", message: "The parameter list didn't split into names and types: check the inputs." };
    return { ...rest, inputs, returns, errors: [], pinned: true, ...(loose && { importWarnings: [...(x.importWarnings ?? []), warning] }) };
  });
  return { ...old, version: 2, blocks };
}

// Board files are hand-editable, so check everything the serializer and UI rely on.
export function validate(data: unknown): Board {
  const fail = (msg: string): never => {
    throw new Error(`invalid board file: ${msg}`);
  };
  if ((data as { version?: unknown })?.version === 1) data = migrateV1(data as { version: 1; blocks: unknown });
  const b = data as Board;
  if (typeof b !== "object" || b === null) fail("expected an object");
  if (b.version !== 2) fail(`unsupported version ${JSON.stringify(b.version)} (expected 1 or 2)`);
  if (typeof b.name !== "string") fail("missing board name");
  if (!Array.isArray(b.blocks)) fail("missing blocks array");
  if (!Array.isArray(b.edges)) fail("missing edges array");
  b.blocks.forEach((x, i) => {
    if (typeof x !== "object" || x === null) fail(`block ${i} is not an object`);
  });
  const byId = new Map<string, Block>(b.blocks.map((x) => [x.id, x]));
  if (byId.size !== b.blocks.length) fail("duplicate block ids");
  for (const x of b.blocks) {
    if (typeof x.id !== "string" || typeof x.name !== "string") fail("every block needs a string id and name");
    if (x.id === DEFAULT_MODULE.id) fail(`the block id ${DEFAULT_MODULE.id} is reserved for the default module`);
    if (!KINDS.has(x.kind)) fail(`block ${x.id} has unknown kind "${x.kind}"`);
    const missing = FIELDS[x.kind].filter(([key, ok]) => !ok((x as unknown as Record<string, unknown>)[key])).map(([key]) => key);
    if (missing.length) fail(`${x.kind} ${x.id} needs ${missing.join(", ")}`);
    if (x.notes !== undefined && !isText(x.notes)) fail(`block ${x.id} has notes that are not text`);
    if (x.pinned !== undefined && typeof x.pinned !== "boolean") fail(`block ${x.id} has a pinned flag that is not true or false`);
    const src = x.source;
    if (src !== undefined && !(typeof src === "object" && src !== null && isText(src.id) && isText(src.path) && Number.isInteger(src.line)))
      fail(`block ${x.id} needs a source with an id, a path and a line`);
    const warnings = x.importWarnings;
    if (warnings !== undefined && !(Array.isArray(warnings) && warnings.every((w) => IMPORT_WARNING_KINDS.includes(w?.kind) && isText(w.message))))
      fail(`block ${x.id} has import warnings that are not a list of known kinds with messages`);
    if (x.parentId === undefined) continue;
    const parent = byId.get(x.parentId);
    if (!parent) fail(`block ${x.id} has parent "${x.parentId}" that does not exist`);
    if (!canContain(parent!.kind, x.kind)) fail(`block ${x.id} has parent ${parent!.id}, but a ${parent!.kind} cannot contain a ${x.kind}`);
  }
  const edgeIds = new Set<string>();
  b.edges.forEach((e, i) => {
    if (typeof e !== "object" || e === null || typeof e.id !== "string") fail(`edge ${i} needs a string id`);
    if (edgeIds.has(e.id)) fail("duplicate edge ids");
    edgeIds.add(e.id);
    for (const end of [e.source, e.target]) if (!byId.has(end)) fail(`edge ${e.id} points at "${end}", which is not a block`);
    if (!EDGE_KINDS.includes(e.kind)) fail(`edge ${e.id} has unknown kind "${e.kind}"`);
    if (e.label !== undefined && !isText(e.label)) fail(`edge ${e.id} has a label that is not text`);
    if (e.label !== undefined && e.kind !== "other") fail(`edge ${e.id} is "${e.kind}", but only "other" edges have labels`);
  });
  if (b.unindexed !== undefined && !isTextList(b.unindexed)) fail("unindexed must be a list of file paths");
  if (b.target !== undefined) {
    if (typeof b.target !== "object" || b.target === null || typeof b.target.repo !== "string" || !b.target.repo.trim())
      fail("target needs a repo path");
    if (!Array.isArray(b.target.checks) || !b.target.checks.every((c) => isTextList(c) && c.length > 0))
      fail("target checks must be commands, each a list of words");
  }
  // A parent cycle would make its blocks vanish from the architecture file.
  for (const x of b.blocks) {
    const seen = new Set<string>();
    for (let at: Block | undefined = x; at?.parentId; at = byId.get(at.parentId)) {
      if (seen.has(at.id)) fail(`blocks ${[...seen].join(", ")} form a parent cycle`);
      seen.add(at.id);
    }
  }
  return b;
}
