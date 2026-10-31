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
import { newId, type Block, type Board, type Edge, type FunctionBlock, type Lang } from "../board";
import { serialize, signatureText } from "../serialize";
import { failedResult, type GenerateResult } from "../run";
import { GENERATORS } from "../prompts";

type Run = { running: boolean; progress: string[]; result?: GenerateResult };

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

function fromNodes(nodes: BlockNode[], name: string, edges: Edge[]): Board {
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
  return { version: 1, name, blocks, edges };
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
        <span className="dim">{signatureText(b.signature)}</span>
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
  // Edges have no UI until #4, but an opened board's edges must survive a save.
  const [edges, setEdges] = useState<Edge[]>([]);
  const [path, setPath] = useState("~/scaffold-boards/untitled.scaffold.json");
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [lang, setLang] = useState<Lang>("python");
  const [run, setRun] = useState<Run | null>(null);
  const board = useMemo(() => fromNodes(nodes, name, edges), [nodes, name, edges]);
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
    setEdges(body.edges);
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

  // Saves the board, then reads the server-sent events of the run as they arrive.
  const runGenerate = async () => {
    setRun({ running: true, progress: [] });
    const failed = (message: string) => setRun((r) => ({ running: false, progress: r?.progress ?? [], result: failedResult(message) }));
    try {
      const res = await fetch(`/api/generate?path=${encodeURIComponent(path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ board, lang }),
      });
      if (!res.ok) return failed((await res.json().catch(() => ({ error: `server answered ${res.status}` }))).error);
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const events = buffer.split("\n\n");
        buffer = events.pop()!;
        for (const ev of events) {
          const kind = /^event: (\w+)/m.exec(ev)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(ev)?.[1] ?? "null");
          if (kind === "progress") setRun((r) => ({ running: true, progress: [...(r?.progress ?? []), data].slice(-200) }));
          if (kind === "done") setRun((r) => ({ running: false, progress: r?.progress ?? [], result: data }));
        }
      }
    } catch (e) {
      failed((e as Error).message);
    }
    setRun((r) => (r?.running ? { ...r, running: false, result: r.result ?? failedResult("the run ended without a result") } : r));
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
        <select aria-label="Target language" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
          {Object.entries(GENERATORS).map(([value, spec]) => (
            <option key={value} value={value}>
              {spec.label}
            </option>
          ))}
        </select>
        <button className="btn btn--sm btn--primary" onClick={runGenerate} disabled={run?.running}>
          {run?.running ? "Generating…" : "Generate"}
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
        {run && <RunPanel run={run} />}
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

function RunPanel({ run }: { run: Run }) {
  const r = run.result;
  return (
    <section className="glass run" aria-label="Generation run">
      <div className="run-head">
        <span className="label">Run</span>
        {run.running && <span className="chip chip--accent">running</span>}
        {r && <span className={`chip ${r.ok ? "chip--ok" : "chip--err"}`}>{r.ok ? "verified" : "failed"}</span>}
      </div>
      {r?.runDir && <p className="meta run-dir">{r.runDir}</p>}
      {r && r.errors.length > 0 && (
        <ul className="run-errors" aria-label="Errors">
          {r.errors.map((e, i) => (
            <li key={i}>
              {e.blockId && <span className="chip chip--err">@id {e.blockId}</span>} {e.message}
            </li>
          ))}
        </ul>
      )}
      {r && r.files.length > 0 && (
        <details>
          <summary className="meta">{r.files.length} files</summary>
          <pre>{r.files.join("\n")}</pre>
        </details>
      )}
      <pre className="run-log" aria-label="Progress">{run.progress.join("\n")}</pre>
    </section>
  );
}
