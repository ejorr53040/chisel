// Board model shared by the UI and the server. The board file is the source of truth.

export type Lang = "python" | "rust" | "cpp" | "typescript";

interface BlockBase {
  id: string;
  name: string;
  parentId?: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  notes?: string;
  source?: Source; // only on imported blocks
  importWarnings?: ImportWarning[];
  pinned?: boolean; // the user placed it; live layout (#41) keeps it where it is
}

// Where an imported block's code lives: tesselate's qualified id, its file, and its line (0 for a folder).
export interface Source {
  id: string;
  path: string;
  line: number;
}

// Something import or migration could not be sure of, shown as an amber badge until the next import replaces it.
export const IMPORT_WARNING_KINDS = ["no-intent", "loose-signature"] as const;
export interface ImportWarning {
  kind: (typeof IMPORT_WARNING_KINDS)[number];
  message: string;
}

export interface ModuleBlock extends BlockBase {
  kind: "module";
}

// A function input; the type is free text in any language's style, empty when unknown.
export interface Param {
  name: string;
  type: string;
}

export interface FunctionBlock extends BlockBase {
  kind: "function";
  inputs: Param[];
  returns: string; // empty for none
  errors: string[]; // error types it can fail with
  intent: string;
  steps: string[];
}

// Brackets that nest in a signature. The ">" of "->" and "=>" never closes one, and nothing inside a
// double-quoted or backtick string counts (single quotes are left alone: Rust lifetimes use them).
const OPEN = "([{<";
const CLOSE = ")]}>";
const QUOTES = '"`';

// The bracket depth outside each character (-1 inside a string), and whether every bracket and string closes.
function depths(text: string): { at: number[]; balanced: boolean } {
  const at: number[] = [];
  let depth = 0;
  let quote = "";
  let balanced = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      at.push(-1);
      if (ch === quote && text[i - 1] !== "\\") quote = "";
    } else if (QUOTES.includes(ch)) {
      at.push(-1);
      quote = ch;
    } else if (text.startsWith("->", i) || text.startsWith("=>", i)) {
      at.push(depth, depth);
      i++;
    } else if (OPEN.includes(ch)) at.push(depth++);
    else if (CLOSE.includes(ch)) {
      if (depth === 0) balanced = false;
      depth = Math.max(0, depth - 1);
      at.push(depth);
    } else at.push(depth);
  }
  return { at, balanced: balanced && depth === 0 && !quote };
}

// Splits text on sep where no bracket or string is open.
function splitTop(text: string, sep: string): string[] {
  const { at } = depths(text);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (at[i] !== 0 || !text.startsWith(sep, i)) continue;
    parts.push(text.slice(start, i));
    start = i + sep.length;
    i += sep.length - 1;
  }
  return [...parts, text.slice(start)];
}

// A parameter name, with the prefixes languages put on one: ...rest, *args, &self, &mut self, mut x, optional?.
const PARAM_NAME = /^(\.\.\.|\*{1,2}|&(mut\s+)?)?(mut\s+)?[A-Za-z_$][\w$]*\??$/;

// A loose signature ("(a: A, b) -> R", "a, b -> R", TypeScript's "(a: A): R" and "(a: A) => R") as structured
// inputs and a return. A parameter list that doesn't split cleanly into name or name: type, or doesn't close,
// is kept whole as one input, and loose is set.
export function parseSignature(text: string): { inputs: Param[]; returns: string; loose: boolean } {
  const sig = text.trim();
  let params: string;
  let rest: string;
  if (sig.startsWith("(")) {
    const end = depths(sig).at.findIndex((d, i) => i > 0 && d === 0 && sig[i] === ")");
    if (end < 0) return { inputs: [{ name: sig.slice(1).trim(), type: "" }], returns: "", loose: true };
    params = sig.slice(1, end);
    rest = sig.slice(end + 1).trim().replace(/^(->|=>|:)/, "");
  } else {
    const [head, ...tail] = splitTop(sig, "->");
    params = head;
    rest = tail.join("->");
  }
  const returns = rest.trim();
  if (!params.trim()) return { inputs: [], returns, loose: false };
  const inputs = splitTop(params, ",").map((p) => {
    const [name, ...type] = splitTop(p.trim(), ":");
    return { name: name.trim(), type: type.join(":").trim() };
  });
  if (depths(params).balanced && inputs.every((p) => PARAM_NAME.test(p.name))) return { inputs, returns, loose: false };
  return { inputs: [{ name: params.trim(), type: "" }], returns, loose: true };
}

export const LOOSE_SIGNATURE_WARNING = {
  kind: "loose-signature",
  message: "The parameter list didn't split into names and types: check the inputs.",
} as const satisfies ImportWarning;

export interface ClassBlock extends BlockBase {
  kind: "class";
}

export interface InterfaceBlock extends BlockBase {
  kind: "interface";
}

export interface FieldBlock extends BlockBase {
  kind: "field";
  type: string;
}

export interface ConstantBlock extends BlockBase {
  kind: "constant";
  type: string;
  value: string;
}

export interface TypeBlock extends BlockBase {
  kind: "type";
  shape: "struct" | "enum";
  members: string[]; // "name: type" for a struct, variant names for an enum
}

// The block's name is the capability ("HTTP server"); overrides pin a package per language.
export interface LibraryBlock extends BlockBase {
  kind: "library";
  overrides: Partial<Record<Lang, string>>;
}

export interface ServiceBlock extends BlockBase {
  kind: "service";
  description: string;
}

export interface EntryBlock extends BlockBase {
  kind: "entry";
  trigger: "main" | "http" | "cli";
  detail: string; // route or command, e.g. "POST /checkout"
}

export type Block =
  | ModuleBlock
  | FunctionBlock
  | ClassBlock
  | InterfaceBlock
  | FieldBlock
  | ConstantBlock
  | TypeBlock
  | LibraryBlock
  | ServiceBlock
  | EntryBlock;
export type Kind = Block["kind"];

// The one list of block kinds; its order is the sibling order in the architecture file.
export const BLOCK_KINDS = [
  "entry",
  "library",
  "service",
  "constant",
  "type",
  "interface",
  "class",
  "field",
  "function",
  "module",
] as const satisfies readonly Kind[];

// What each container may hold; kinds missing here hold nothing.
export const CONTAINS: Partial<Record<Kind, readonly Kind[]>> = {
  module: BLOCK_KINDS,
  class: ["constant", "type", "field", "function"],
  interface: ["function"],
};
export const canContain = (parent: Kind, child: Kind) => CONTAINS[parent]?.includes(child) ?? false;
export const isContainer = (kind: Kind) => kind in CONTAINS;

export const LANGS: readonly Lang[] = ["python", "rust", "cpp", "typescript"];
export const TRIGGERS = ["main", "http", "cli"] as const;

export function newBlock(kind: Kind, position: { x: number; y: number }): Block {
  const base = { id: newId(kind[0]), name: kind === "module" ? "module" : `new ${kind}`, position };
  switch (kind) {
    case "function":
      return { ...base, kind, name: "function", inputs: [], returns: "", errors: [], intent: "", steps: [] };
    case "field":
      return { ...base, kind, name: "field", type: "" };
    case "constant":
      return { ...base, kind, name: "CONSTANT", type: "", value: "" };
    case "type":
      return { ...base, kind, name: "Type", shape: "struct", members: [] };
    case "library":
      return { ...base, kind, name: "capability", overrides: {} };
    case "service":
      return { ...base, kind, name: "service", description: "" };
    case "entry":
      return { ...base, kind, name: "main", trigger: "main", detail: "" };
    case "class":
      return { ...base, kind, name: "Class" };
    case "interface":
      return { ...base, kind, name: "Interface" };
    case "module":
      return { ...base, kind };
  }
}

// Structural relationships first, then behaviour; the order edges are listed in under their source block.
export const EDGE_KINDS = ["inherits", "implements", "imports", "uses", "calls", "returns", "emits", "handles", "other"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Edge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string; // only for "other"
}

// Where Generate goes: without a target, a fresh project per run in out/<lang>/; with one, the existing
// repository is updated in place and checked with its own commands.
export interface Target {
  repo: string; // relative to the board file
  checks: string[][]; // commands, e.g. [["npm", "test"]]
}

export interface Board {
  version: 2;
  name: string;
  blocks: Block[];
  edges: Edge[];
  target?: Target;
  unindexed?: string[]; // files tesselate skipped on the last import
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

// Copies the chosen blocks and everything inside them under fresh ids, plus the edges that run between
// copied blocks (edges to blocks outside the copy are not duplicated: the copy starts unconnected). Top-level copies are nudged so they don't sit exactly on their originals.
export function duplicate(board: Board, ids: string[]): { board: Board; copies: string[] } {
  const byId = new Map(board.blocks.map((b) => [b.id, b]));
  const chosen = new Set(ids);
  const insideChosen = (b: Block) => {
    for (let p = b.parentId; p; p = byId.get(p)?.parentId) if (chosen.has(p)) return true;
    return false;
  };
  const roots = ids.filter((id) => byId.has(id) && !insideChosen(byId.get(id)!));
  const copied: Block[] = [];
  const collect = (id: string) => {
    copied.push(byId.get(id)!);
    for (const child of board.blocks) if (child.parentId === id) collect(child.id);
  };
  roots.forEach(collect);

  const taken = new Set([...board.blocks.map((b) => b.id), ...board.edges.map((e) => e.id)]);
  const fresh = (prefix: string) => {
    let id: string;
    do id = newId(prefix);
    while (taken.has(id));
    taken.add(id);
    return id;
  };
  const idMap = new Map(copied.map((b) => [b.id, fresh(b.id.split("_")[0] || b.kind[0])]));
  const blocks = copied.map(
    (b): Block => ({
      ...structuredClone(b),
      id: idMap.get(b.id)!,
      parentId: b.parentId && idMap.has(b.parentId) ? idMap.get(b.parentId) : b.parentId,
      position: roots.includes(b.id) ? { x: b.position.x + 24, y: b.position.y + 24 } : { ...b.position },
    }),
  );
  const edges = board.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({ ...e, id: fresh("e"), source: idMap.get(e.source)!, target: idMap.get(e.target)! }));
  return { board: { ...board, blocks: [...board.blocks, ...blocks], edges: [...board.edges, ...edges] }, copies: blocks.map((b) => b.id) };
}
