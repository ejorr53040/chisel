import { useMemo, useState } from "react";
import { Background, Controls, ReactFlow, useNodesState, useReactFlow } from "@xyflow/react";
import { canContain, newBlock, type Block, type Edge, type Kind, type Lang } from "../board";
import { serialize } from "../serialize";
import { failedResult, type GenerateResult } from "../run";
import { GENERATORS } from "../prompts";
import { KIND_LABELS, fromNodes, isContainer, nodeTypes, parentsFirst, toNode, toNodes, type BlockNode } from "./nodes";
import { Inspector } from "./Inspector";

type Run = { running: boolean; progress: string[]; result?: GenerateResult };

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

  // New blocks land in the middle of the canvas, nudged so repeated adds don't stack exactly.
  const add = (kind: Kind) => {
    const box = document.querySelector(".canvas")!.getBoundingClientRect();
    const center = rf.screenToFlowPosition({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const nudge = (nodes.length % 6) * 16;
    const block = newBlock(kind, { x: Math.round(center.x + nudge), y: Math.round(center.y + nudge) });
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...toNode(block), selected: true }]);
  };

  const update = (id: string, patch: Record<string, unknown>) =>
    setNodes((ns) =>
      ns.map((n) => (n.id === id ? { ...n, data: { block: { ...n.data.block, ...patch } as Block } } : n)),
    );

  // Containment: dropping a block onto a container that may hold it nests it; bare canvas un-nests it.
  const onNodeDragStop = (_e: unknown, node: BlockNode) => {
    const descendants = new Set<string>();
    const walk = (id: string) =>
      nodes.filter((n) => n.parentId === id).forEach((n) => (descendants.add(n.id), walk(n.id)));
    walk(node.id);
    const area = (n: BlockNode) => (n.measured?.width ?? 0) * (n.measured?.height ?? 0);
    const target = rf
      .getIntersectingNodes(node)
      .filter((n) => n.id !== node.id && !descendants.has(n.id) && isContainer(n.type!) && canContain(n.type!, node.type!))
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
        {(Object.keys(KIND_LABELS) as Kind[]).map((kind) => (
          <button key={kind} className="btn btn--sm" onClick={() => add(kind)}>
            + {KIND_LABELS[kind]}
          </button>
        ))}
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
