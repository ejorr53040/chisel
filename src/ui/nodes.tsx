import { createContext, useContext } from "react";
import { Handle, MarkerType, Position, useStore, type Edge as FlowEdge, type Node, type NodeProps } from "@xyflow/react";
import { LANGS, isContainer, type Block, type Board, type Edge, type EdgeKind, type Kind } from "../board";
import { blockLine, edgeVerb } from "../serialize";

export type BlockNode = Node<{ block: Block }, Kind>;

export const KIND_LABELS: Record<Kind, string> = {
  module: "Module",
  class: "Class",
  interface: "Interface",
  function: "Function",
  field: "Field",
  constant: "Constant",
  type: "Type / Enum",
  library: "Library",
  service: "External service",
  entry: "Entry point",
};

// One-letter shortcuts for adding each kind.
export const KIND_KEYS: Record<Kind, string> = {
  module: "m",
  class: "c",
  interface: "i",
  function: "f",
  field: "d",
  constant: "k",
  type: "t",
  library: "l",
  service: "s",
  entry: "e",
};

export { isContainer };

// Sizes before the first layout; every container kind gets one.
const containerSize = (kind: Kind) =>
  ({ module: { width: 360, height: 240 }, class: { width: 300, height: 200 } })[kind as string] ?? { width: 280, height: 160 };

export function toNode(block: Block): BlockNode {
  const size = isContainer(block.kind) ? (block.size ?? containerSize(block.kind)) : undefined;
  return { id: block.id, type: block.kind, position: block.position, parentId: block.parentId, data: { block }, ...size };
}

// React Flow needs every parent before its children in the node array.
export function parentsFirst<T extends { id: string; parentId?: string }>(items: T[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const depth = (i: T): number => (i.parentId && byId.has(i.parentId) ? 1 + depth(byId.get(i.parentId)!) : 0);
  return [...items].sort((a, b) => depth(a) - depth(b));
}

export const toNodes = (board: Board) => parentsFirst(board.blocks).map(toNode);

export type LinkEdge = FlowEdge<{ edge: Edge }>;

// Each kind's colour is what it carries (provisional until the visual-semantics grill, #39); dash, width and
// glyph back that up for colour-blind reading. "other" is the free-form catch-all, drawn thin and dotted.
export const EDGE_STYLE: Record<EdgeKind, { color: string; dash?: string; width?: number; glyph: string }> = {
  inherits: { color: "var(--slate)", width: 2.5, glyph: "▲" },
  implements: { color: "var(--slate)", dash: "6 4", width: 2.5, glyph: "△" },
  imports: { color: "var(--external)", dash: "2 3", glyph: "⇣" },
  uses: { color: "var(--data)", dash: "6 4", glyph: "◇" },
  calls: { color: "var(--control)", glyph: "→" },
  returns: { color: "var(--data)", glyph: "↩" },
  emits: { color: "var(--event)", glyph: "↯" },
  handles: { color: "var(--event)", dash: "6 4", glyph: "⚑" },
  other: { color: "var(--slate)", dash: "1 5", width: 1, glyph: "…" },
};

export function toFlowEdge(edge: Edge, selected = false): LinkEdge {
  const style = EDGE_STYLE[edge.kind];
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    selected,
    data: { edge },
    label: `${style.glyph} ${edgeVerb(edge)}`,
    style: { stroke: style.color, strokeDasharray: style.dash, strokeWidth: style.width ?? 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: style.color },
    labelStyle: { fill: style.color, fontFamily: "var(--font-mono)", fontSize: 11 },
    labelBgStyle: { fill: "var(--bg)" },
  };
}

// Edges whose blocks are gone are dropped here, so deleting a block never leaves a dangling edge in the file.
export function fromNodes(nodes: BlockNode[], name: string, edges: Edge[]): Board {
  const ids = new Set(nodes.map((n) => n.id));
  const blocks = nodes.map((n): Block => {
    const block: Block = {
      ...n.data.block,
      // Layout owns unpinned positions and container sizes, so only a pin's position is the user's to save.
      position: n.data.block.pinned ? { x: Math.round(n.position.x), y: Math.round(n.position.y) } : n.data.block.position,
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : undefined,
    };
    return block;
  });
  return { version: 2, name, blocks, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

// How many errors the last run tied to each block id.
export const BlockErrors = createContext<ReadonlyMap<string, number>>(new Map());
// Lossy-mapping warnings for the selected language, by block id.
export const BlockWarnings = createContext<ReadonlyMap<string, string[]>>(new Map());

// Type names on the board, so a type written in a signature can link to its Type block.
export interface TypeIndex {
  byName: ReadonlyMap<string, string>; // Type block name → id
  usage: ReadonlyMap<string, number>; // Type block id → how many other blocks mention it
  select: (id: string) => void;
}
export const Types = createContext<TypeIndex>({ byName: new Map(), usage: new Map(), select: () => {} });

const IDENT = /[A-Za-z_$][\w$]*/g;

// Every type text a block mentions: a function's input types, return and errors; a field's or constant's type;
// a struct's member types.
export function typeTexts(b: Block): string[] {
  if (b.kind === "function") return [...b.inputs.map((p) => p.type), b.returns, ...b.errors];
  if (b.kind === "field" || b.kind === "constant") return [b.type];
  if (b.kind === "type" && b.shape === "struct") return b.members.map((m) => member(m).type);
  return [];
}
const mentions = (b: Block) => new Set(typeTexts(b).flatMap((t) => t.match(IDENT) ?? []));
// A struct member is "name: type"; an enum variant (or an untyped member) is just a name.
const member = (m: string) => {
  const [name, ...type] = m.split(":");
  return { name: name.trim(), type: type.join(":").trim() };
};
const filled = (items: string[]) => items.filter((s) => s.trim());

export function typeIndex(blocks: Block[], select: (id: string) => void): TypeIndex {
  const byName = new Map(blocks.filter((b) => b.kind === "type").map((b) => [b.name.trim(), b.id]));
  const usage = new Map<string, number>();
  for (const b of blocks)
    for (const name of mentions(b)) {
      const id = byName.get(name);
      if (id && id !== b.id) usage.set(id, (usage.get(id) ?? 0) + 1);
    }
  return { byName, usage, select };
}

// A type as written, with every name that is a Type block on the board as a link to it.
function TypeText({ text }: { text: string }) {
  const { byName, select } = useContext(Types);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(IDENT)) {
    const id = byName.get(m[0]);
    if (!id) continue;
    parts.push(text.slice(at, m.index));
    parts.push(
      <button key={m.index} className="type-link nodrag" onClick={(e) => (e.stopPropagation(), select(id))}>
        {m[0]}
      </button>,
    );
    at = m.index + m[0].length;
  }
  return (
    <span className="ty">
      {parts}
      {text.slice(at)}
    </span>
  );
}

// How much a block shows at the current zoom: far = header only, mid = adds inputs/outputs/members,
// near = adds types, type chips, intent and notes. Each level sets its own text size (app.css) so text stays
// readable across the level's zoom range: the board drops detail as it zooms out instead of shrinking it.
type Level = "far" | "mid" | "near";
const levelOf = (zoom: number): Level => (zoom < 0.5 ? "far" : zoom < 0.9 ? "mid" : "near");
const useLevel = () => useStore((s) => levelOf(s.transform[2]));

// Pin, warning and error badges.
function Badges({ block }: { block: Block }) {
  const errors = useContext(BlockErrors).get(block.id);
  // Lossy-mapping and import warnings share the amber badge; fault stays for generation errors.
  const warnings = [...(useContext(BlockWarnings).get(block.id) ?? []), ...(block.importWarnings ?? []).map((w) => w.message)];
  return (
    <>
      {block.pinned && (
        <span className="pin-badge" role="img" aria-label="Pinned: layout keeps it where you put it" title="Pinned: layout keeps it where you put it">
          ⌖
        </span>
      )}
      {warnings.length > 0 && (
        <span className="warn-badge" role="img" aria-label={`Warning: ${warnings.join(" ")}`} title={warnings.join("\n")}>
          ⚠
        </span>
      )}
      {errors && (
        <span className="error-badge" role="img" aria-label={`${errors} error${errors > 1 ? "s" : ""} in the last run`}>
          ✕ {errors}
        </span>
      )}
    </>
  );
}

// The architecture file's keyword for the block, shown as its kind tag.
const keyword = (b: Block) => blockLine(b).split(" ")[0];

function Header({ block, extra }: { block: Block; extra?: string }) {
  return (
    <div className="blk-head">
      <span className="blk-kind">{keyword(block)}</span>
      <span className="blk-name">{block.name}</span>
      {extra && <span className="blk-extra">{extra}</span>}
      <Badges block={block} />
    </div>
  );
}

// rail: what the section carries, which colours its left rail (data, control or structure).
function Section({ label, rail, children }: { label: string; rail: "data" | "control" | "slate"; children: React.ReactNode }) {
  return (
    <div className={`blk-sec rail-${rail}`} aria-label={label} role="group">
      <div className="blk-sec-label">{label}</div>
      {children}
    </div>
  );
}

function Detail({ block, level, method }: { block: Block; level: Level; method: boolean }) {
  const types = useContext(Types);
  if (level === "far") return null;
  const near = level === "near";
  switch (block.kind) {
    case "function": {
      const chips = near ? [...mentions(block)] : [];
      return (
        <>
          {block.inputs.length > 0 && (
            <Section label="Inputs" rail="data">
              {block.inputs.map((p, i) => (
                <div key={i} className="blk-row">
                  <span>{p.name}</span>
                  {near && p.type && <TypeText text={p.type} />}
                </div>
              ))}
            </Section>
          )}
          {(block.returns.trim() || filled(block.errors).length > 0) && (
            <Section label="Outputs" rail={method ? "control" : "data"}>
              {block.returns.trim() && (
                <div className="blk-row">
                  <span>→</span>
                  <TypeText text={block.returns} />
                </div>
              )}
              {filled(block.errors).map((e, i) => (
                <div key={i} className="blk-row blk-err">
                  <span>!</span>
                  <TypeText text={e} />
                </div>
              ))}
            </Section>
          )}
          {near && block.intent.trim() && <div className="blk-intent">{block.intent}</div>}
          {near && <Notes block={block} />}
          {chips.length > 0 && (
            <div className="blk-chips" aria-label="Types used">
              {chips.map((n) => (
                <TypeText key={n} text={n} />
              ))}
            </div>
          )}
        </>
      );
    }
    case "field":
    case "constant":
      return (
        <>
          {(block.type.trim() || (block.kind === "constant" && block.value.trim())) && (
            <Section label={block.kind === "field" ? "Type" : "Type and value"} rail="slate">
              <div className="blk-row">
                <TypeText text={block.type} />
                {block.kind === "constant" && block.value.trim() && <span>= {block.value}</span>}
              </div>
            </Section>
          )}
          {near && <Notes block={block} />}
        </>
      );
    case "type": {
      const used = types.usage.get(block.id) ?? 0;
      return (
        <>
          {filled(block.members).length > 0 && (
            <Section label={block.shape === "enum" ? "Variants" : "Fields"} rail="slate">
              {filled(block.members).map((m, i) => {
                const { name, type } = member(m);
                return (
                  <div key={i} className="blk-row">
                    <span>{name}</span>
                    {near && type && <TypeText text={type} />}
                  </div>
                );
              })}
            </Section>
          )}
          <div className="blk-meta">used by {used}</div>
          {near && <Notes block={block} />}
        </>
      );
    }
    case "service":
      return near ? <Prose text={block.description} block={block} /> : null;
    case "entry":
      return near ? <Prose text={block.detail} block={block} /> : null;
    case "library":
      return near ? <Prose text={LANGS.filter((l) => block.overrides[l]?.trim()).map((l) => `${l}: ${block.overrides[l]}`).join(" · ")} block={block} /> : null;
    default:
      return near ? <Notes block={block} /> : null;
  }
}

const Notes = ({ block }: { block: Block }) => (block.notes?.trim() ? <div className="blk-notes">{block.notes}</div> : null);
const Prose = ({ text, block }: { text: string; block: Block }) => (
  <>
    {text.trim() && <div className="blk-intent">{text}</div>}
    <Notes block={block} />
  </>
);

// Connection mode is loose, so an edge can start or end at either handle of any block.
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </>
  );
}

// Functions inside a class or interface are its methods: their rail is the control colour.
const METHOD_PARENTS = new Set<Kind>(["class", "interface"]);

function ContainerNode({ data, selected }: NodeProps<BlockNode>) {
  const level = useLevel();
  return (
    <>
      <Handles />
      <div className={`block block--container block--${data.block.kind} lvl-${level}${selected ? " is-selected" : ""}`}>
        <Header block={data.block} />
      </div>
    </>
  );
}

function LeafNode({ data, selected, parentId }: NodeProps<BlockNode>) {
  const level = useLevel();
  const parentKind = useStore((s) => (parentId ? s.nodeLookup.get(parentId)?.type : undefined));
  const method = data.block.kind === "function" && METHOD_PARENTS.has(parentKind as Kind);
  const extra = data.block.kind === "type" ? data.block.shape : data.block.kind === "entry" ? data.block.trigger : undefined;
  return (
    <>
      <Handles />
      <div className={`block block--leaf block--${data.block.kind}${method ? " block--method" : ""} lvl-${level}${selected ? " is-selected" : ""}`}>
        <Header block={data.block} extra={extra} />
        <Detail block={data.block} level={level} method={method} />
      </div>
    </>
  );
}

export const nodeTypes = Object.fromEntries(
  (Object.keys(KIND_LABELS) as Kind[]).map((kind) => [kind, isContainer(kind) ? ContainerNode : LeafNode]),
);
