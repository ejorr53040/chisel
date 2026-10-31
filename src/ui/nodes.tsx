import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { CONTAINS, type Block, type Board, type Edge, type Kind } from "../board";
import { blockLine } from "../serialize";

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
  service: "Service",
  entry: "Entry point",
};

export const isContainer = (kind: Kind) => kind in CONTAINS;

const CONTAINER_SIZE: Partial<Record<Kind, { width: number; height: number }>> = {
  module: { width: 360, height: 240 },
  class: { width: 300, height: 200 },
  interface: { width: 280, height: 160 },
};

export function toNode(block: Block): BlockNode {
  const size = isContainer(block.kind) ? (block.size ?? CONTAINER_SIZE[block.kind]) : undefined;
  return { id: block.id, type: block.kind, position: block.position, parentId: block.parentId, data: { block }, ...size };
}

// React Flow needs every parent before its children in the node array.
export function parentsFirst<T extends { id: string; parentId?: string }>(items: T[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const depth = (i: T): number => (i.parentId && byId.has(i.parentId) ? 1 + depth(byId.get(i.parentId)!) : 0);
  return [...items].sort((a, b) => depth(a) - depth(b));
}

export const toNodes = (board: Board) => parentsFirst(board.blocks).map(toNode);

export function fromNodes(nodes: BlockNode[], name: string, edges: Edge[]): Board {
  const ids = new Set(nodes.map((n) => n.id));
  const blocks = nodes.map((n): Block => {
    const block: Block = {
      ...n.data.block,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : undefined,
    };
    const fallback = CONTAINER_SIZE[block.kind];
    if (fallback)
      block.size = {
        width: Math.round(n.width ?? n.measured?.width ?? fallback.width),
        height: Math.round(n.height ?? n.measured?.height ?? fallback.height),
      };
    return block;
  });
  return { version: 1, name, blocks, edges };
}

// The architecture-file line, split into its keyword and the rest.
function Title({ block }: { block: Block }) {
  const [keyword, ...rest] = blockLine(block).split(" ");
  return (
    <div className="block-title">
      <span className="kw">{keyword}</span> {rest.join(" ")}
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
      return Object.entries(b.overrides)
        .filter(([, pkg]) => pkg)
        .map(([lang, pkg]) => `${lang}: ${pkg}`)
        .join(" · ");
    default:
      return b.notes;
  }
}

function ContainerNode({ data, selected }: NodeProps<BlockNode>) {
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={200} minHeight={120} color="var(--fill)" />
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
      <Title block={data.block} />
      {text && <div className="block-intent">{text}</div>}
    </div>
  );
}

export const nodeTypes = Object.fromEntries(
  (Object.keys(KIND_LABELS) as Kind[]).map((kind) => [kind, isContainer(kind) ? ContainerNode : LeafNode]),
);
