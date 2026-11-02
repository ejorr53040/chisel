import { createContext, useContext } from "react";
import { Handle, MarkerType, Position, type Edge as FlowEdge, type Node, type NodeProps } from "@xyflow/react";
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

// The architecture-file line, split into its keyword and the rest, plus the block's error badge.
function Title({ block }: { block: Block }) {
  const [keyword, ...rest] = blockLine(block).split(" ");
  const errors = useContext(BlockErrors).get(block.id);
  // Lossy-mapping and import warnings share the amber badge; red stays for generation errors.
  const warnings = [...(useContext(BlockWarnings).get(block.id) ?? []), ...(block.importWarnings ?? []).map((w) => w.message)];
  return (
    <div className="block-title">
      <span className="kw">{keyword}</span> {rest.join(" ")}
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
    </div>
  );
}

function detail(b: Block): string | undefined {
  switch (b.kind) {
    case "function":
      return b.intent;
    case "service":
      return b.description;
    case "entry":
      return b.detail;
    case "type":
      return b.members.filter(Boolean).join(", ");
    case "library":
      return LANGS.filter((lang) => b.overrides[lang]?.trim())
        .map((lang) => `${lang}: ${b.overrides[lang]}`)
        .join(" · ");
    default:
      return b.notes;
  }
}

// Connection mode is loose, so an edge can start or end at either handle of any block.
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </>
  );
}

function ContainerNode({ data, selected }: NodeProps<BlockNode>) {
  return (
    <>
      <Handles />
      <div className={`block block--container block--${data.block.kind}${selected ? " is-selected" : ""}`}>
        <Title block={data.block} />
      </div>
    </>
  );
}

function LeafNode({ data, selected }: NodeProps<BlockNode>) {
  const text = detail(data.block);
  return (
    <div className={`block block--leaf block--${data.block.kind}${selected ? " is-selected" : ""}`}>
      <Handles />
      <Title block={data.block} />
      {text && <div className="block-intent">{text}</div>}
    </div>
  );
}

export const nodeTypes = Object.fromEntries(
  (Object.keys(KIND_LABELS) as Kind[]).map((kind) => [kind, isContainer(kind) ? ContainerNode : LeafNode]),
);
