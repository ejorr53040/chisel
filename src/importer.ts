// Builds a board from a repository's code, as read by tesselate (`tesselate call outline`; see tesselate#76).
// Pure: the adapter that runs tesselate hands over the facts, so everything here is tested with recorded JSON.
import type { Block, Board, Kind } from "./board";

export interface OutlineDef {
  id: string; // tesselate's qualified id, stable across runs
  kind: string;
  name: string;
  parent?: string;
  path: string;
  line: number;
  end_line: number;
  signature?: string;
  doc?: string; // first line of the doc comment
}

export interface Facts {
  name: string; // the board name, usually the repo folder's
  outline: { version: number; definitions: OutlineDef[]; unindexed: string[] };
}

const OUTLINE_VERSION = 1;
// The grid: leaves are assumed this size; containers pad their children and leave room for their title.
const LEAF = { width: 280, height: 140 };
const PAD = 24;
const GAP = 24;
const HEADER = 48;
const COLUMNS = 3;

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Node {
  kind: Kind;
  name: string;
  source: { id: string; path: string; line: number };
  def?: OutlineDef;
  children: Node[];
}

export function importBoard(facts: Facts): Board {
  const { version, definitions, unindexed } = facts.outline;
  if (version !== OUTLINE_VERSION)
    throw new Error(`tesselate outline version ${version} is not supported (Chisel reads version ${OUTLINE_VERSION}); update the older of the two`);

  const roots: Node[] = [];
  const folders = new Map<string, Node>();
  const folder = (path: string): Node[] => {
    if (!path) return roots;
    let node = folders.get(path);
    if (!node) {
      const cut = path.lastIndexOf("/");
      node = { kind: "module", name: path.slice(cut + 1), source: { id: `${path}/`, path, line: 0 }, children: [] };
      folders.set(path, node);
      folder(path.slice(0, Math.max(cut, 0))).push(node);
    }
    return node.children;
  };

  // Files first, so every definition's parent exists when it is placed.
  const nodes = new Map<string, Node>();
  for (const d of definitions.filter((d) => d.kind === "module")) {
    const node: Node = { kind: "module", name: d.path.replace(/^.*\//, "").replace(/\.[^.]*$/, ""), source: at(d), def: d, children: [] };
    nodes.set(d.id, node);
    folder(d.path.slice(0, Math.max(d.path.lastIndexOf("/"), 0))).push(node);
  }
  // ponytail: only functions so far; the other kinds arrive with #26. A definition whose parent is unknown is skipped.
  for (const d of definitions.filter((d) => d.kind === "function")) {
    const parent = d.parent === undefined ? undefined : nodes.get(d.parent);
    if (parent) parent.children.push({ kind: "function", name: d.name, source: at(d), def: d, children: [] });
  }

  const blocks: Block[] = [];
  const used = new Set<string>();
  const emit = (node: Node, parentId: string | undefined, position: { x: number; y: number }): string => {
    const base = `${node.kind[0]}_${node.source.id.replace(/[^\w.]/g, "_")}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    const common = { id, name: node.name, parentId, position, source: node.source };
    if (node.kind === "function") {
      const doc = node.def?.doc?.trim();
      blocks.push({
        ...common,
        kind: "function",
        signature: looseSignature(node.def?.signature),
        intent: doc ?? "",
        steps: [],
        ...(doc ? {} : { importWarnings: [{ kind: "no-intent", message: "No doc comment: write an intent." }] }),
      });
    } else blocks.push({ ...common, kind: "module" });
    return id;
  };

  // Places nodes in rows from (x0, y0), parents before children, and returns how far the placed nodes reach.
  const pack = (items: Node[], parentId: string | undefined, x0: number, y0: number) => {
    let x = x0, y = y0, rowHeight = 0, right = x0, bottom = y0;
    sorted(items).forEach((node, i) => {
      if (i > 0 && i % COLUMNS === 0) (x = x0), (y += rowHeight + GAP), (rowHeight = 0);
      const index = blocks.length;
      const id = emit(node, parentId, { x, y });
      let size = LEAF;
      if (node.kind === "module") {
        const reach = pack(node.children, id, PAD, HEADER);
        size = { width: Math.max(reach.right, PAD + LEAF.width) + PAD, height: reach.bottom + PAD };
        blocks[index].size = size;
      }
      (x += size.width + GAP), (rowHeight = Math.max(rowHeight, size.height));
      (right = Math.max(right, x - GAP)), (bottom = Math.max(bottom, y + size.height));
    });
    return { right, bottom };
  };
  pack(roots, undefined, 0, 0);

  return { version: 1, name: facts.name, blocks, edges: [], ...(unindexed.length ? { unindexed: [...unindexed].sort(byCodePoint) } : {}) };
}

const at = (d: OutlineDef) => ({ id: d.id, path: d.path, line: d.line });

// Path, then line, then id: the same order whatever order tesselate listed them in.
const sorted = (items: Node[]) =>
  [...items].sort((a, b) => byCodePoint(a.source.path, b.source.path) || a.source.line - b.source.line || byCodePoint(a.source.id, b.source.id));

// "export function f(a: A): B {" → "(a: A): B", the loose signature the board shows after the name.
function looseSignature(declared: string | undefined): string {
  const open = declared?.indexOf("(") ?? -1;
  return open < 0 ? "()" : declared!.slice(open).replace(/\s*(\{|=>)\s*$/, "").trim();
}
