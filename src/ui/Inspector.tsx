import { useState } from "react";
import { EDGE_KINDS, LANGS, TRIGGERS, type Block, type Edge, type Lang, type Param, type Target } from "../board";

type Patch = Partial<Block>;

// code: the value is code (a name, signature, type or package) and is set in the mono face; prose stays in Geist.
function Text({ id, label, value, onChange, rows, code }: { id: string; label: string; value: string; onChange: (v: string) => void; rows?: number; code?: boolean }) {
  const className = code ? "mono" : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {rows ? (
        <textarea id={id} className={className} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} className={className} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function Choice<T extends string>({ id, label, value, options, onChange }: { id: string; label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

const LANG_LABELS: Record<Lang, string> = { python: "Python", rust: "Rust", cpp: "C++", typescript: "TypeScript" };

// A function's inputs as name / type rows that can be added, removed and reordered.
function Inputs({ inputs, onChange }: { inputs: Param[]; onChange: (inputs: Param[]) => void }) {
  const set = (i: number, patch: Partial<Param>) => onChange(inputs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const move = (i: number, by: number) => {
    const next = [...inputs];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <fieldset className="field inputs">
      <legend>Inputs</legend>
      {inputs.map((p, i) => (
        <div key={i} className="input-row">
          <input className="mono" aria-label={`Input ${i + 1} name`} placeholder="name" value={p.name} onChange={(e) => set(i, { name: e.target.value })} />
          <input className="mono" aria-label={`Input ${i + 1} type`} placeholder="type" value={p.type} onChange={(e) => set(i, { type: e.target.value })} />
          <button className="btn btn--sm btn--link" aria-label={`Move input ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
            ↑
          </button>
          <button className="btn btn--sm btn--link" aria-label={`Move input ${i + 1} down`} disabled={i === inputs.length - 1} onClick={() => move(i, 1)}>
            ↓
          </button>
          <button className="btn btn--sm btn--link" aria-label={`Remove input ${i + 1}`} onClick={() => onChange(inputs.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn btn--sm" onClick={() => onChange([...inputs, { name: "", type: "" }])}>
        + Input
      </button>
    </fieldset>
  );
}

export function Inspector({ block, onChange }: { block: Block; onChange: (patch: Patch) => void }) {
  const lines = (v: string) => v.split("\n");
  return (
    <div className="stack">
      <Text id="f-name" label="Name" code value={block.name} onChange={(name) => onChange({ name })} />
      {block.kind === "function" && (
        <>
          <Inputs inputs={block.inputs} onChange={(inputs) => onChange({ inputs })} />
          <Text id="f-returns" label="Returns" code value={block.returns} onChange={(returns) => onChange({ returns })} />
          <Text id="f-errors" label="Errors, one type per line" code rows={2} value={block.errors.join("\n")} onChange={(v) => onChange({ errors: lines(v) })} />
          <Text id="f-intent" label="Intent" rows={2} value={block.intent} onChange={(intent) => onChange({ intent })} />
          <Text id="f-steps" label="Steps, one per line" rows={4} value={block.steps.join("\n")} onChange={(v) => onChange({ steps: lines(v) })} />
        </>
      )}
      {(block.kind === "field" || block.kind === "constant") && (
        <Text id="f-type" label="Type" code value={block.type} onChange={(type) => onChange({ type })} />
      )}
      {block.kind === "constant" && <Text id="f-value" label="Value" code value={block.value} onChange={(value) => onChange({ value })} />}
      {block.kind === "type" && (
        <>
          <Choice id="f-shape" label="Shape" value={block.shape} options={["struct", "enum"] as const} onChange={(shape) => onChange({ shape })} />
          <Text
            id="f-members"
            code
            label={block.shape === "enum" ? "Variants, one per line" : "Fields (name: type), one per line"}
            rows={4}
            value={block.members.join("\n")}
            onChange={(v) => onChange({ members: lines(v) })}
          />
        </>
      )}
      {block.kind === "library" &&
        LANGS.map((lang) => (
          <Text
            key={lang}
            id={`f-pkg-${lang}`}
            code
            label={`${LANG_LABELS[lang]} package (optional)`}
            value={block.overrides[lang] ?? ""}
            onChange={(pkg) => onChange({ overrides: { ...block.overrides, [lang]: pkg.trim() ? pkg : undefined } })}
          />
        ))}
      {block.kind === "service" && (
        <Text id="f-desc" label="Description" rows={2} value={block.description} onChange={(description) => onChange({ description })} />
      )}
      {block.kind === "entry" && (
        <>
          <Choice id="f-trigger" label="Trigger" value={block.trigger} options={TRIGGERS} onChange={(trigger) => onChange({ trigger })} />
          <Text id="f-detail" label={block.trigger === "http" ? "Route, e.g. POST /checkout" : "Detail"} value={block.detail} onChange={(detail) => onChange({ detail })} />
        </>
      )}
      <Text id="f-notes" label="Notes for the agent" rows={2} value={block.notes ?? ""} onChange={(notes) => onChange({ notes: notes || undefined })} />
      <p className="meta">@id {block.id}</p>
    </div>
  );
}

export function EdgeInspector({
  edge,
  from,
  to,
  onChange,
  onDelete,
}: {
  edge: Edge;
  from: string;
  to: string;
  onChange: (patch: Partial<Edge>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="stack">
      <p className="meta">
        {from} → {to}
      </p>
      <Choice id="e-kind" label="Relationship" value={edge.kind} options={EDGE_KINDS} onChange={(kind) => onChange({ kind, label: kind === "other" ? edge.label : undefined })} />
      {edge.kind === "other" && <Text id="e-label" label="Label" value={edge.label ?? ""} onChange={(label) => onChange({ label })} />}
      <button className="btn btn--sm btn--danger" onClick={onDelete}>
        Delete edge
      </button>
      <p className="meta">@edge {edge.id}</p>
    </div>
  );
}

// Shown when nothing is selected: where Generate sends this board.
export function BoardInspector({ target, onChange }: { target?: Target; onChange: (t?: Target) => void }) {
  // Raw text while typing; the parsed commands go to the board.
  const [commands, setCommands] = useState((target?.checks ?? []).map((c) => c.join(" ")).join("\n"));
  return (
    <div className="stack">
      <p className="meta">Select a block or edge to edit it. Drag from a block's side handle to another block to connect them.</p>
      <div className="label">Board</div>
      <Choice
        id="b-target"
        label="Generate into"
        value={target ? "existing repository" : "new project"}
        options={["new project", "existing repository"] as const}
        onChange={(v) => onChange(v === "new project" ? undefined : { repo: ".", checks: [] })}
      />
      {target && (
        <>
          <Text id="b-repo" label="Repository folder (relative to the board file)" value={target.repo} onChange={(repo) => onChange({ ...target, repo })} />
          <Text
            id="b-checks"
            label="Check commands, one per line"
            rows={3}
            value={commands}
            onChange={(v) => {
              setCommands(v);
              onChange({ ...target, checks: v.split("\n").map((l) => l.trim().split(/\s+/).filter(Boolean)).filter((c) => c.length) });
            }}
          />
          <p className="meta">Update repo works on a new chisel/… branch and needs the repository to have no uncommitted changes besides this board.</p>
        </>
      )}
    </div>
  );
}
