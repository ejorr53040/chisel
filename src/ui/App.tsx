import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  NodeResizer,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { newId, type Block, type Board, type FunctionBlock } from "../board";
import { serialize } from "../serialize";

type BlockNode = Node<{ block: Block }, Block["kind"]>;

const MODULE_SIZE = { width: 360, height: 240 };

function toNode(block: Block): BlockNode {
  const size = block.kind === "module" ? (block.size ?? MODULE_SIZE) : undefined;
  return { id: block.id, type: block.kind, position: block.position, parentId: block.parentId, data: { block }, ...size };
}

// React Flow needs every parent before its children in the node array.
function parentsFirst<T extends { id: string; parentId?: string }>(items: T[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const depth = (i: T): number => (i.parentId && byId.has(i.parentId) ? 1 + depth(byId.get(i.parentId)!) : 0);
  return [...items].sort((a, b) => depth(a) - depth(b));
}

const toNodes = (board: Board) => parentsFirst(board.blocks).map(toNode);

function fromNodes(nodes: BlockNode[], name: string): Board {
  const ids = new Set(nodes.map((n) => n.id));
  const blocks = nodes.map((n): Block => {
    const block: Block = {
      ...n.data.block,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      parentId: n.parentId && ids.has(n.parentId) ? n.parentId : undefined,
    };
    if (block.kind === "module")
      block.size = {
        width: Math.round(n.width ?? n.measured?.width ?? MODULE_SIZE.width),
        height: Math.round(n.height ?? n.measured?.height ?? MODULE_SIZE.height),
      };
    return block;
  });
  return { version: 1, name, blocks, edges: [] };
}

function ModuleNode({ data, selected }: NodeProps<BlockNode>) {
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={200} minHeight={120} color="var(--fill)" />
      <div className={`block block--module${selected ? " is-selected" : ""}`}>
        <div className="block-title">
          <span className="kw">module</span> {data.block.name}
        </div>
      </div>
    </>
  );
}

function FunctionNode({ data, selected }: NodeProps<BlockNode>) {
  const b = data.block as FunctionBlock;
  return (
    <div className={`block block--fn${selected ? " is-selected" : ""}`}>
      <div className="block-title">
        <span className="kw">fn</span> {b.name}
        <span className="dim">{b.signature || "()"}</span>
      </div>
      {b.intent && <div className="block-intent">{b.intent}</div>}
    </div>
  );
}

const nodeTypes = { module: ModuleNode, function: FunctionNode };

export function App() {
  const rf = useReactFlow<BlockNode>();
  const [nodes, setNodes, onNodesChange] = useNodesState<BlockNode>([]);
  const [name, setName] = useState("untitled");
  const [path, setPath] = useState("~/scaffold-boards/untitled.scaffold.json");
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const board = useMemo(() => fromNodes(nodes, name), [nodes, name]);
  const arch = useMemo(() => serialize(board).arch, [board]);
  const selected = nodes.find((n) => n.selected);

  const add = (kind: Block["kind"]) => {
    const position = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const block: Block =
      kind === "module"
        ? { id: newId("m"), kind, name: "module", position }
        : { id: newId("f"), kind, name: "function", position, signature: "()", intent: "", steps: [] };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...toNode(block), selected: true }]);
  };

  const update = (id: string, patch: Partial<FunctionBlock>) =>
    setNodes((ns) =>
      ns.map((n) => (n.id === id ? { ...n, data: { block: { ...n.data.block, ...patch } as Block } } : n)),
    );

  // Containment: dropping a block onto a module nests it; dropping it on bare canvas un-nests it.
  const onNodeDragStop = (_e: unknown, node: BlockNode) => {
    const descendants = new Set<string>();
    const walk = (id: string) =>
      nodes.filter((n) => n.parentId === id).forEach((n) => (descendants.add(n.id), walk(n.id)));
    walk(node.id);
    const area = (n: BlockNode) => (n.measured?.width ?? 0) * (n.measured?.height ?? 0);
    const target = rf
      .getIntersectingNodes(node)
      .filter((n) => n.type === "module" && n.id !== node.id && !descendants.has(n.id))
      .sort((a, b) => area(a) - area(b))[0];
    const abs = rf.getInternalNode(node.id)!.internals.positionAbsolute;
    const origin = target ? rf.getInternalNode(target.id)!.internals.positionAbsolute : { x: 0, y: 0 };
    setNodes((ns) =>
      parentsFirst(
        ns.map((n) =>
          n.id === node.id
            ? { ...n, parentId: target?.id, position: { x: abs.x - origin.x, y: abs.y - origin.y } }
            : n,
        ),
      ),
    );
  };

  const open = async () => {
    const res = await fetch(`/api/board?path=${encodeURIComponent(path)}`);
    const body = await res.json();
    if (!res.ok) return setStatus({ ok: false, msg: body.error });
    setName(body.name);
    setNodes(toNodes(body));
    setStatus({ ok: true, msg: `opened ${path}` });
    requestAnimationFrame(() => rf.fitView());
  };

  const save = async () => {
    const res = await fetch(`/api/board?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(board),
    });
    const body = await res.json();
    setStatus(res.ok ? { ok: true, msg: `saved ${body.path} + .arch.md` } : { ok: false, msg: body.error });
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">
          <svg aria-hidden="true">
            <use href="/blueprint.svg#mark" />
          </svg>
          scaffold
        </span>
        <input aria-label="Board name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Board file path" className="path" value={path} onChange={(e) => setPath(e.target.value)} />
        <button className="btn btn--sm" onClick={open}>
          Open
        </button>
        <button className="btn btn--sm btn--primary" onClick={save}>
          Save
        </button>
        {status && (
          <span role="status" className={`chip ${status.ok ? "chip--ok" : "chip--err"}`}>
            {status.msg}
          </span>
        )}
      </header>

      <aside className="palette glass">
        <div className="label">Blocks</div>
        <button className="btn btn--sm" onClick={() => add("module")}>
          + Module
        </button>
        <button className="btn btn--sm" onClick={() => add("function")}>
          + Function
        </button>
      </aside>

      <main className="canvas">
        <ReactFlow
          nodes={nodes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls />
        </ReactFlow>
      </main>

      <aside className="side">
        <section className="glass inspector">
          <div className="label">Inspector</div>
          {selected ? (
            <Inspector block={selected.data.block} onChange={(p) => update(selected.id, p)} />
          ) : (
            <p className="meta">Select a block to edit it.</p>
          )}
        </section>
        <section className="glass preview">
          <div className="label">Architecture file</div>
          <pre aria-label="Architecture file preview">{arch}</pre>
        </section>
      </aside>
    </div>
  );
}

function Inspector({ block, onChange }: { block: Block; onChange: (p: Partial<FunctionBlock>) => void }) {
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="f-name">Name</label>
        <input id="f-name" value={block.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      {block.kind === "function" && (
        <>
          <div className="field">
            <label htmlFor="f-sig">Signature</label>
            <input id="f-sig" value={block.signature} onChange={(e) => onChange({ signature: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="f-intent">Intent</label>
            <textarea id="f-intent" rows={2} value={block.intent} onChange={(e) => onChange({ intent: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="f-steps">Steps, one per line</label>
            <textarea
              id="f-steps"
              rows={4}
              value={block.steps.join("\n")}
              onChange={(e) => onChange({ steps: e.target.value.split("\n") })}
            />
          </div>
        </>
      )}
      <p className="meta">@id {block.id}</p>
    </div>
  );
}
