import { readFileSync, writeFileSync } from "node:fs";
import type { Board } from "./board";
import { serialize } from "./serialize";

const KINDS = new Set(["module", "function"]);

export function archPath(boardPath: string): string {
  return boardPath.replace(/\.scaffold\.json$/, "") + ".arch.md";
}

export function saveBoard(path: string, board: Board): void {
  validate(board);
  writeFileSync(path, JSON.stringify(board, null, 2) + "\n");
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

// Board files are hand-editable, so check everything the serializer and UI rely on.
export function validate(data: unknown): Board {
  const fail = (msg: string): never => {
    throw new Error(`invalid board file: ${msg}`);
  };
  const b = data as Board;
  if (typeof b !== "object" || b === null) fail("expected an object");
  if (b.version !== 1) fail(`unsupported version ${JSON.stringify(b.version)} (expected 1)`);
  if (typeof b.name !== "string") fail("missing board name");
  if (!Array.isArray(b.blocks)) fail("missing blocks array");
  if (!Array.isArray(b.edges)) fail("missing edges array");
  const ids = new Set(b.blocks.map((x) => x.id));
  for (const x of b.blocks) {
    if (typeof x.id !== "string" || typeof x.name !== "string") fail("every block needs a string id and name");
    if (!KINDS.has(x.kind)) fail(`block ${x.id} has unknown kind "${x.kind}"`);
    if (x.parentId !== undefined && !ids.has(x.parentId)) fail(`block ${x.id} has parent "${x.parentId}" that does not exist`);
    if (x.kind === "function" && (typeof x.signature !== "string" || typeof x.intent !== "string" || !Array.isArray(x.steps)))
      fail(`function ${x.id} needs signature, intent and steps`);
  }
  if (ids.size !== b.blocks.length) fail("duplicate block ids");
  return b;
}
