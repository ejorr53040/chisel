import { BLOCK_KINDS, EDGE_KINDS, LANGS, type Block, type Board, type Edge, type FunctionBlock, type Lang } from "./board";

export interface Warning {
  blockId?: string;
  edgeId?: string;
  message: string;
}

// Code-point order, not localeCompare: the same board must sort the same on every machine.
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The file is line-oriented, so user text never gets to start a new line.
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();

// "(a: A, b) -> R": each input as name or name: type, then the return when there is one.
export function signatureText(fn: FunctionBlock): string {
  const params = fn.inputs.filter((p) => p.name.trim()).map((p) => oneLine(p.name) + (p.type.trim() ? `: ${oneLine(p.type)}` : ""));
  return `(${params.join(", ")})` + (fn.returns.trim() ? ` -> ${oneLine(fn.returns)}` : "");
}

// What an edge says it is: its kind, or for a labelled "other" edge the label (double quotes become single,
// since the file quotes it).
export const edgeVerb = (e: Edge) => (e.kind === "other" && e.label?.trim() ? oneLine(e.label).replaceAll('"', "'") : e.kind);

// Blocks outside any module are written into this one; a top-level module of the same name absorbs them.
export const DEFAULT_MODULE = { id: "_main", name: "main" };

// The block line, without indent or @id.
export function blockLine(b: Block): string {
  const name = oneLine(b.name);
  switch (b.kind) {
    case "function":
      return `fn ${name}${signatureText(b)}`;
    case "field":
      return `field ${name}${b.type.trim() ? `: ${oneLine(b.type)}` : ""}`;
    case "constant":
      return `const ${name}${b.type.trim() ? `: ${oneLine(b.type)}` : ""}${b.value.trim() ? ` = ${oneLine(b.value)}` : ""}`;
    case "type":
      return `type ${name} ${b.shape}`;
    case "entry":
      return `entry ${b.trigger} ${name}`;
    default:
      return `${b.kind} ${name}`;
  }
}

// Property lines under the block line, as [key, value] or [key, list].
function props(b: Block): [string, string | string[]][] {
  const out: [string, string | string[]][] = [];
  const add = (key: string, value: string | undefined) => value?.trim() && out.push([key, oneLine(value)]);
  const list = (key: string, items: string[]) => {
    const kept = items.map(oneLine).filter(Boolean);
    if (kept.length) out.push([key, kept]);
  };
  add("notes", b.notes);
  if (b.kind === "function") add("intent", b.intent), list("steps", b.steps), list("errors", b.errors);
  if (b.kind === "type") list("members", b.members);
  if (b.kind === "library") for (const lang of LANGS) add(lang, b.overrides[lang]);
  if (b.kind === "service") add("description", b.description);
  if (b.kind === "entry") add("detail", b.detail);
  return out;
}

function edgeLine(e: Edge, byId: Map<string, Block>): string {
  const target = byId.get(e.target)!;
  const verb = edgeVerb(e) === e.kind ? e.kind : `"${edgeVerb(e)}"`;
  return `-> ${verb} ${oneLine(target.name)} (@id ${target.id})  @edge ${e.id}`;
}

// Board features a target language can only approximate, warned about before generating.
const LOSSY: Partial<Record<Lang, (board: Board, byId: Map<string, Block>) => Warning[]>> = {
  rust: (board, byId) =>
    board.edges
      .filter((e) => e.kind === "inherits" && byId.has(e.source) && byId.has(e.target))
      .map((e) => ({
        edgeId: e.id,
        blockId: e.source,
        message: `Rust has no inheritance: ${oneLine(byId.get(e.source)!.name)} will embed ${oneLine(byId.get(e.target)!.name)} and share behaviour through a trait.`,
      })),
  // Single inheritance: the parent the architecture file lists first stays `extends`; each further one is warned about.
  typescript: (board, byId) => {
    const firstParent = new Map<string, string>();
    const name = (id: string) => oneLine(byId.get(id)!.name);
    return board.edges
      .filter((e) => e.kind === "inherits" && byId.has(e.source) && byId.has(e.target))
      .sort((a, b) => byCodePoint(edgeLine(a, byId), edgeLine(b, byId)))
      .flatMap((e) => {
        const first = firstParent.get(e.source);
        if (!first) return firstParent.set(e.source, e.target), [];
        return [{ edgeId: e.id, blockId: e.source, message: `TypeScript classes extend one parent: ${name(e.source)} will extend ${name(first)} and take ${name(e.target)} as an interface or a field.` }];
      });
  },
};

export function serialize(board: Board, lang?: Lang): { arch: string; warnings: Warning[] } {
  const children = new Map<string | undefined, Block[]>();
  // Smallest id wins, so array order never decides which "main" absorbs the orphans.
  const topModule = board.blocks
    .filter((b) => !b.parentId && b.kind === "module" && oneLine(b.name) === DEFAULT_MODULE.name)
    .sort((a, b) => byCodePoint(a.id, b.id))[0];
  const defaultId = topModule?.id ?? DEFAULT_MODULE.id;
  for (const b of board.blocks) {
    const parent = b.parentId ?? (b.kind === "module" ? undefined : defaultId);
    children.set(parent, [...(children.get(parent) ?? []), b]);
  }
  if (!topModule && children.has(DEFAULT_MODULE.id))
    children.set(undefined, [...(children.get(undefined) ?? []), { ...DEFAULT_MODULE, kind: "module", position: { x: 0, y: 0 } }]);

  const sorted = (parent?: string) =>
    (children.get(parent) ?? []).sort(
      (a, b) =>
        BLOCK_KINDS.indexOf(a.kind) - BLOCK_KINDS.indexOf(b.kind) ||
        byCodePoint(oneLine(a.name), oneLine(b.name)) ||
        byCodePoint(a.id, b.id),
    );

  const byId = new Map(board.blocks.map((b) => [b.id, b]));
  const outgoing = new Map<string, Edge[]>();
  for (const e of board.edges) {
    if (!byId.has(e.target)) continue;
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source)!.push(e);
  }
  // Within a kind, the rendered line decides the order, so the file always reads sorted.
  const edgesOf = (id: string) =>
    (outgoing.get(id) ?? [])
      .map((e) => ({ e, line: edgeLine(e, byId) }))
      .sort((a, b) => EDGE_KINDS.indexOf(a.e.kind) - EDGE_KINDS.indexOf(b.e.kind) || byCodePoint(a.line, b.line))
      .map(({ line }) => line);

  const render = (b: Block, indent: string): string[] => {
    const out = [`${indent}${blockLine(b)}  @id ${b.id}`];
    for (const [key, value] of props(b))
      if (typeof value === "string") out.push(`${indent}  ${key}: ${value}`);
      else out.push(`${indent}  ${key}:`, ...value.map((v) => `${indent}    - ${v}`));
    for (const line of edgesOf(b.id)) out.push(`${indent}  ${line}`);
    for (const c of sorted(b.id)) out.push(...render(c, indent + "  "));
    return out;
  };

  const lines = [`# architecture: ${oneLine(board.name)}`, "# generated by chisel; edit the board, not this file"];
  const top = sorted(undefined).map((b) => render(b, "").join("\n"));
  if (top.length) lines.push("", top.join("\n\n"));
  const warnings = (lang && LOSSY[lang]?.(board, byId)) || [];
  warnings.sort((a, b) => byCodePoint(a.edgeId ?? a.blockId ?? "", b.edgeId ?? b.blockId ?? ""));
  return { arch: lines.join("\n") + "\n", warnings };
}
