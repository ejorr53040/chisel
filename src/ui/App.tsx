import { useMemo, useRef, useState } from "react";
import { Background, ConnectionMode, Controls, ReactFlow, useEdgesState, useNodesState, useReactFlow, type Connection } from "@xyflow/react";
import { canContain, newBlock, newId, type Block, type Edge, type Kind, type Lang } from "../board";
import { serialize } from "../serialize";
import { failedResult, type GenerateResult } from "../run";
import { GENERATORS } from "../prompts";
import { BlockErrors, BlockWarnings, KIND_LABELS, fromNodes, isContainer, nodeTypes, parentsFirst, toFlowEdge, toNode, toNodes, type BlockNode, type LinkEdge } from "./nodes";
import { EdgeInspector, Inspector } from "./Inspector";

type Run = { running: boolean; progress: string[]; result?: GenerateResult };

export function App() {
  const rf = useReactFlow<BlockNode>();
  const [nodes, setNodes, onNodesChange] = useNodesState<BlockNode>([]);
  const [name, setName] = useState("untitled");
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<LinkEdge>([]);
  // React Flow owns the ends; data.edge carries kind and label.
  const edges = useMemo(() => flowEdges.map((e) => ({ ...e.data!.edge, source: e.source, target: e.target })), [flowEdges]);
  // With loose handles React Flow reports the drag's start as the target when it began on a left handle;
  // an edge always points from the block the drag started on.
  const connectFrom = useRef<string | null>(null);
  const [path, setPath] = useState("~/scaffold-boards/untitled.scaffold.json");
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [lang, setLang] = useState<Lang>("python");
  const [run, setRun] = useState<Run | null>(null);
  const board = useMemo(() => fromNodes(nodes, name, edges), [nodes, name, edges]);
  const { arch, warnings } = useMemo(() => serialize(board, lang), [board, lang]);
  const blockWarnings = useMemo(() => {
    const byBlock = new Map<string, string[]>();
    for (const w of warnings) if (w.blockId) byBlock.set(w.blockId, [...(byBlock.get(w.blockId) ?? []), w.message]);
    return byBlock;
  }, [warnings]);
  // Edges carrying a warning get a ⚠ in their label for as long as the language warns about them.
  const shownEdges = useMemo(() => {
    const warned = new Set(warnings.map((w) => w.edgeId));
    return flowEdges.map((e) => (warned.has(e.id) ? { ...e, label: `⚠ ${e.label}`, className: "edge--warned" } : e));
  }, [flowEdges, warnings]);
  const selected = nodes.find((n) => n.selected);
  const blockErrors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of run?.result?.errors ?? []) if (e.blockId) counts.set(e.blockId, (counts.get(e.blockId) ?? 0) + 1);
    return counts;
  }, [run]);
  const focusBlock = (id: string) => {
    if (!nodes.some((n) => n.id === id)) return;
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setFlowEdges((es) => es.map((e) => ({ ...e, selected: false })));
    rf.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.5, padding: 0.6 });
  };
  const selectedEdge = selected ? undefined : flowEdges.find((e) => e.selected)?.data!.edge;
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.data.block.name ?? id;

  // Any block may connect to any block; new edges start as "uses" and open in the inspector to retype.
  const onConnect = (c: Connection) => {
    const source = connectFrom.current ?? c.source;
    const target = source === c.source ? c.target : c.source;
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
    setFlowEdges((es) => [
      ...es.map((e) => ({ ...e, selected: false })),
      toFlowEdge({ id: newId("e"), source, target, kind: "uses" }, true),
    ]);
  };
  const updateEdge = (id: string, patch: Partial<Edge>) =>
    setFlowEdges((es) => es.map((e) => (e.id === id ? toFlowEdge({ ...e.data!.edge, ...patch }, e.selected) : e)));
  const deleteEdge = (id: string) => setFlowEdges((es) => es.filter((e) => e.id !== id));

  // New blocks land in the middle of the canvas, nudged so repeated adds don't stack exactly.
  const add = (kind: Kind) => {
    const box = document.querySelector(".canvas")!.getBoundingClientRect();
    const center = rf.screenToFlowPosition({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const nudge = (nodes.length % 6) * 16;
    const block = newBlock(kind, { x: Math.round(center.x + nudge), y: Math.round(center.y + nudge) });
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...toNode(block), selected: true }]);
  };

  const update = (id: string, patch: Partial<Block>) =>
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
    setRun(null); // the last run's errors belong to the previous board
    setFlowEdges(body.edges.map((e: Edge) => toFlowEdge(e)));
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
  const cancelRun = () => fetch("/api/generate/cancel", { method: "POST" });
  const openRunDir = async (runDir: string) => {
    const res = await fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runDir }) });
    if (!res.ok) setStatus({ ok: false, msg: (await res.json()).error });
  };

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
        {run?.running && (
          <button className="btn btn--sm btn--danger" onClick={cancelRun}>
            Cancel
          </button>
        )}
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
        <BlockErrors.Provider value={blockErrors}>
        <BlockWarnings.Provider value={blockWarnings}>
        <ReactFlow
          nodes={nodes}
          edges={shownEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={(_e, { nodeId }) => (connectFrom.current = nodeId)}
          isValidConnection={(c) => c.source !== c.target}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={["Backspace", "Delete"]}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls />
        </ReactFlow>
        </BlockWarnings.Provider>
        </BlockErrors.Provider>
      </main>

      <aside className="side">
        <section className="glass inspector">
          <div className="label">Inspector</div>
          {selected ? (
            <Inspector block={selected.data.block} onChange={(p) => update(selected.id, p)} />
          ) : selectedEdge ? (
            <EdgeInspector
              edge={selectedEdge}
              from={nameOf(selectedEdge.source)}
              to={nameOf(selectedEdge.target)}
              onChange={(p) => updateEdge(selectedEdge.id, p)}
              onDelete={() => deleteEdge(selectedEdge.id)}
            />
          ) : (
            <p className="meta">Select a block or edge to edit it. Drag from a block's side handle to another block to connect them.</p>
          )}
        </section>
        <section className="glass preview">
          <div className="label">Architecture file</div>
          {warnings.length > 0 && (
            <ul className="warnings" aria-label={`Warnings for ${GENERATORS[lang]?.label ?? lang}`}>
              {warnings.map((w, i) => (
                <li key={w.edgeId ?? w.blockId ?? i}>⚠ {w.message}</li>
              ))}
            </ul>
          )}
          <pre aria-label="Architecture file preview">{arch}</pre>
        </section>
        {run && <RunPanel run={run} onFocus={focusBlock} nameOf={nameOf} onOpen={openRunDir} />}
      </aside>
    </div>
  );
}

function RunPanel({
  run,
  onFocus,
  nameOf,
  onOpen,
}: {
  run: Run;
  onFocus: (id: string) => void;
  nameOf: (id: string) => string;
  onOpen: (runDir: string) => void;
}) {
  const r = run.result;
  return (
    <section className="glass run" aria-label="Generation run">
      <div className="run-head">
        <span className="label">Run</span>
        {run.running && <span className="chip chip--accent">running</span>}
        {r && (
          <span className={`chip ${r.ok ? "chip--ok" : r.cancelled ? "" : "chip--err"}`}>{r.ok ? "verified" : r.cancelled ? "cancelled" : "failed"}</span>
        )}
      </div>
      {r?.runDir && (
        <p className="meta run-dir">
          {r.runDir}{" "}
          <button className="btn btn--sm btn--link" onClick={() => onOpen(r.runDir)}>
            Open folder
          </button>
        </p>
      )}
      {r && r.errors.length > 0 && (
        <ul className="run-errors" aria-label="Errors">
          {r.errors.map((e, i) => (
            <li key={i}>
              {e.blockId && (
                <button className="btn btn--sm btn--link error-link" onClick={() => onFocus(e.blockId!)} title={`Show @id ${e.blockId} on the board`}>
                  {nameOf(e.blockId)}
                </button>
              )}{" "}
              {e.message}
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
