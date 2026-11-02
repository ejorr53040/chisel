// Live layout: where every block goes and how big each container is, computed from the board.
// ELK's layered algorithm places everything; it cannot hold exact positions (ADR 0002), so pinned blocks are then
// put back where the user left them and their unpinned siblings are moved clear of them.
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { isContainer as holds, type Block, type Board } from "./board";

export interface Box {
  x: number; // relative to the parent block, like a block's stored position
  y: number;
  width: number;
  height: number;
}
export type Size = { width: number; height: number };

const LEAF: Size = { width: 240, height: 72 }; // until the canvas has measured a block
export const PAD = { top: 40, side: 16 }; // room for a container's title above its children
const GAP = 24;

const isContainer = (b: Block) => holds(b.kind);

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": String(GAP),
  "elk.layered.spacing.nodeNodeBetweenLayers": String(GAP * 2),
};
const CONTAINER_OPTIONS = {
  "elk.padding": `[top=${PAD.top},left=${PAD.side},bottom=${PAD.side},right=${PAD.side}]`,
  "elk.nodeSize.constraints": "MINIMUM_SIZE",
  "elk.nodeSize.minimum": "(280, 160)",
};

// Boxes overlap, or sit closer than the gap.
const crowds = (a: Box, b: Box) =>
  a.x < b.x + b.width + GAP && b.x < a.x + a.width + GAP && a.y < b.y + b.height + GAP && b.y < a.y + a.height + GAP;

// elk is passed in: the canvas runs it in a web worker, tests use the bundled build.
export async function layoutBoard(board: Board, sizes: Record<string, Size>, elk: { layout(g: ElkNode): Promise<ElkNode> }): Promise<Record<string, Box>> {
  const kids = new Map<string, Block[]>();
  for (const b of board.blocks) kids.set(b.parentId ?? "", [...(kids.get(b.parentId ?? "") ?? []), b]);
  const byId = new Map(board.blocks.map((b) => [b.id, b]));
  const ancestorOf = (a: string, b: string) => {
    for (let at = byId.get(b)?.parentId; at; at = byId.get(at)?.parentId) if (at === a) return true;
    return false;
  };

  const node = (b: Block): ElkNode =>
    isContainer(b) ? { id: b.id, layoutOptions: CONTAINER_OPTIONS, children: (kids.get(b.id) ?? []).map(node) } : { id: b.id, ...(sizes[b.id] ?? LEAF) };
  // An edge between a block and its own container is ownership already drawn by nesting; ELK can't route it.
  const edges = board.edges.filter((e) => e.source !== e.target && !ancestorOf(e.source, e.target) && !ancestorOf(e.target, e.source));
  const laid = await elk.layout({
    id: "__root",
    layoutOptions: ROOT_OPTIONS,
    children: (kids.get("") ?? []).map(node),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });

  const boxes: Record<string, Box> = {};
  const collect = (n: ElkNode) =>
    n.children?.forEach((c) => {
      boxes[c.id] = { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? LEAF.width, height: c.height ?? LEAF.height };
      collect(c);
    });
  collect(laid);

  // Innermost first, so a container's final size is known before its siblings are settled around it.
  const settle = (parentId: string) => {
    const group = kids.get(parentId) ?? [];
    for (const b of group) if (isContainer(b)) settle(b.id);
    const placed: Box[] = [];
    for (const b of group.filter((b) => b.pinned)) placed.push(Object.assign(boxes[b.id], b.position));
    const free = group.filter((b) => !b.pinned).map((b) => boxes[b.id]);
    for (const box of free.sort((p, q) => p.y - q.y || p.x - q.x)) {
      for (let hit = placed.find((p) => crowds(box, p)); hit; hit = placed.find((p) => crowds(box, p))) box.y = hit.y + hit.height + GAP;
      placed.push(box);
    }
    const parent = boxes[parentId];
    if (!parent) return;
    for (const c of placed) {
      parent.width = Math.max(parent.width, c.x + c.width + PAD.side);
      parent.height = Math.max(parent.height, c.y + c.height + PAD.side);
    }
  };
  settle("");
  return boxes;
}
