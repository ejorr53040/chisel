import { useEffect, useMemo, useRef, useState } from "react";
import { Background, ConnectionMode, Controls, ReactFlow, useEdgesState, useNodesState, useReactFlow, type Connection } from "@xyflow/react";
import { canContain, duplicate, newBlock, newId, type Block, type Board, type Edge, type Kind, type Lang } from "../board";
import { serialize } from "../serialize";
import { failedResult, type GenerateResult } from "../run";
import { GENERATORS } from "../prompts";
import { BlockErrors, BlockWarnings, KIND_KEYS, KIND_LABELS, fromNodes, isContainer, nodeTypes, parentsFirst, toFlowEdge, toNode, toNodes, type BlockNode, type LinkEdge } from "./nodes";
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
  const [help, setHelp] = useState(false);
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

  // Containment: dropping blocks onto a container that may hold them nests them; bare canvas un-nests them.
  // A container grows to fit what is dropped into it.
  const onNodeDragStop = (_e: unknown, _node: BlockNode, dragged: BlockNode[]) => {
    const draggedIds = new Set(dragged.map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ancestorDragged = (n: BlockNode) => {
      for (let p = n.parentId; p; p = byId.get(p)?.parentId) if (draggedIds.has(p)) return true;
      return false;
    };
    const area = (n: BlockNode) => (n.measured?.width ?? 0) * (n.measured?.height ?? 0);
    const moves = new Map<string, { parentId?: string; position: { x: number; y: number } }>();
    const grow = new Map<string, { width: number; height: number }>();
    for (const node of dragged.filter((n) => !ancestorDragged(n))) {
      const descendants = new Set<string>();
      const walk = (id: string) => nodes.filter((n) => n.parentId === id).forEach((n) => (descendants.add(n.id), walk(n.id)));
      walk(node.id);
      const target = rf
        .getIntersectingNodes(node)
        .filter((n) => !draggedIds.has(n.id) && !descendants.has(n.id) && isContainer(n.type!) && canContain(n.type!, node.type!))
        .sort((a, b) => area(a) - area(b))[0];
      const abs = rf.getInternalNode(node.id)!.internals.positionAbsolute;
      const origin = target ? rf.getInternalNode(target.id)!.internals.positionAbsolute : { x: 0, y: 0 };
      const position = { x: abs.x - origin.x, y: abs.y - origin.y };
      moves.set(node.id, { parentId: target?.id, position });
      if (target) {
        const need = { width: position.x + (node.measured?.width ?? 0) + 24, height: position.y + (node.measured?.height ?? 0) + 24 };
        const prev = grow.get(target.id) ?? { width: target.measured?.width ?? 0, height: target.measured?.height ?? 0 };
        grow.set(target.id, { width: Math.max(prev.width, need.width), height: Math.max(prev.height, need.height) });
      }
    }
    setNodes((ns) =>
      parentsFirst(
        ns.map((n) => {
          const move = moves.get(n.id);
          const size = grow.get(n.id);
          const moved = move ? { ...n, parentId: move.parentId, expandParent: !!move.parentId, position: move.position } : n;
          return size && (size.width > (n.measured?.width ?? 0) || size.height > (n.measured?.height ?? 0))
            ? { ...moved, width: Math.round(size.width), height: Math.round(size.height) }
            : moved;
        }),
      ),
    );
  };

  // Replaces what's on the canvas with a board, selecting the given block ids.
  const show = (next: Board, select: string[] = []) => {
    setName(next.name);
    setNodes(toNodes(next).map((n) => ({ ...n, selected: select.includes(n.id) })));
    setFlowEdges(next.edges.map((e) => toFlowEdge(e)));
  };

  // Undo history: snapshots of the board, taken once edits pause so a drag is one step.
  const history = useRef({ past: [] as string[], future: [] as string[], current: "", restoring: true });
  const boardJson = useMemo(() => JSON.stringify(board), [board]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const h = history.current;
      if (h.restoring || !h.current) {
        h.restoring = false;
        h.current = boardJson;
        return;
      }
      if (boardJson === h.current) return;
      h.past = [...h.past, h.current].slice(-100);
      h.future = [];
      h.current = boardJson;
    }, 300);
    return () => clearTimeout(timer);
  }, [boardJson]);
  const travel = (from: "past" | "future") => {
    const h = history.current;
    const to = from === "past" ? "future" : "past";
    const snapshot = h[from].at(-1);
    if (!snapshot) return;
    h[from] = h[from].slice(0, -1);
    h[to] = [...h[to], h.current];
    h.current = snapshot;
    h.restoring = true;
    show(JSON.parse(snapshot));
  };
  const undo = () => travel("past");
  const redo = () => travel("future");

  const duplicateSelection = () => {
    const ids = nodes.filter((n) => n.selected).map((n) => n.id);
    if (!ids.length) return;
    const { board: next, copies } = duplicate(board, ids);
    show(next, copies);
  };

  const open = async () => {
    const res = await fetch(`/api/board?path=${encodeURIComponent(path)}`);
    const body = await res.json();
    if (!res.ok) return setStatus({ ok: false, msg: body.error });
    setRun(null); // the last run's errors belong to the previous board
    history.current = { past: [], future: [], current: "", restoring: true };
    show(body);
    setStatus({ ok: true, msg: `opened ${path}` });
    requestAnimationFrame(() => rf.fitView());
  };

  // A blank board; asks first when the canvas has blocks, since unsaved work would be lost.
  const newBoard = () => {
    if (nodes.length && !window.confirm("Start a new board? Unsaved changes on this one will be lost.")) return;
    setRun(null);
    setStatus(null);
    history.current = { past: [], future: [], current: "", restoring: true };
    show({ version: 1, name: "untitled", blocks: [], edges: [] });
    setPath(path.replace(/[^/]*\.scaffold\.json$/, "untitled.scaffold.json"));
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
  const cancelRun = () => {
    setRun((r) => r && { ...r, progress: [...r.progress, "cancelling…"] });
    fetch("/api/generate/cancel", { method: "POST" }).catch((e) => setStatus({ ok: false, msg: `cancel failed: ${e.message}` }));
  };
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

  // Shortcuts. Plain keys never fire while typing in a field; Ctrl/Cmd+S and +Enter work anywhere.
  useEffect(() => {
    const byKey = Object.fromEntries(Object.entries(KIND_KEYS).map(([kind, key]) => [key, kind as Kind]));
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]");
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const act = (fn: () => void) => (e.preventDefault(), fn());
      if (mod && key === "s") return act(save);
      if (mod && e.key === "Enter") return act(() => run?.running || runGenerate());
      if (typing) return;
      if (mod && key === "z") return act(e.shiftKey ? redo : undo);
      if (mod && key === "y") return act(redo);
      if (mod && key === "d") return act(duplicateSelection);
      if (e.key === "?") return act(() => setHelp((h) => !h));
      if (e.key === "Escape") return setHelp(false);
      if (!mod && !e.altKey && !e.shiftKey && byKey[key]) return act(() => add(byKey[key]));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="app">
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      <header className="topbar">
        <span className="logo">
          <svg aria-hidden="true">
            <use href="/blueprint.svg#mark" />
          </svg>
          scaffold
        </span>
        <input aria-label="Board name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Board file path" className="path" value={path} onChange={(e) => setPath(e.target.value)} />
        <button className="btn btn--sm" onClick={newBoard}>
          New
        </button>
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
        <button className="btn btn--sm btn--link" onClick={() => setHelp(true)} aria-keyshortcuts="?">
          Shortcuts
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
          <button key={kind} className="btn btn--sm palette-btn" onClick={() => add(kind)} aria-keyshortcuts={KIND_KEYS[kind]}>
            + {KIND_LABELS[kind]}
            <kbd aria-hidden="true">{KIND_KEYS[kind].toUpperCase()}</kbd>
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
          <span className={r.ok ? "chip chip--ok" : r.cancelled ? "chip" : "chip chip--err"}>{r.ok ? "verified" : r.cancelled ? "cancelled" : "failed"}</span>
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

const SHORTCUTS: [string, string][] = [
  ...(Object.keys(KIND_LABELS) as Kind[]).map((kind): [string, string] => [KIND_KEYS[kind].toUpperCase(), `Add ${KIND_LABELS[kind].toLowerCase()}`]),
  ["Delete / Backspace", "Delete the selection"],
  ["Ctrl+D", "Duplicate the selection"],
  ["Ctrl+Z", "Undo"],
  ["Ctrl+Shift+Z / Ctrl+Y", "Redo"],
  ["Shift+drag", "Select several blocks"],
  ["Ctrl+S", "Save"],
  ["Ctrl+Enter", "Generate"],
  ["?", "Show or hide this list"],
];

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-backdrop" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="glass help" onClick={(e) => e.stopPropagation()}>
        <div className="label">Keyboard shortcuts</div>
        <table>
          <tbody>
            {SHORTCUTS.map(([keys, what]) => (
              <tr key={keys}>
                <td>
                  <kbd>{keys}</kbd>
                </td>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn btn--sm" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
    </div>
  );
}
