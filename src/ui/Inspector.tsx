import { LANGS, TRIGGERS, type Block } from "../board";

type Patch = Record<string, unknown>;

function Text({ id, label, value, onChange, rows }: { id: string; label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {rows ? (
        <textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
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

const LANG_LABELS = { python: "Python", rust: "Rust", cpp: "C++" } as const;

export function Inspector({ block, onChange }: { block: Block; onChange: (patch: Patch) => void }) {
  const lines = (v: string) => v.split("\n");
  return (
    <div className="stack">
      <Text id="f-name" label="Name" value={block.name} onChange={(name) => onChange({ name })} />
      {block.kind === "function" && (
        <>
          <Text id="f-sig" label="Signature" value={block.signature} onChange={(signature) => onChange({ signature })} />
          <Text id="f-intent" label="Intent" rows={2} value={block.intent} onChange={(intent) => onChange({ intent })} />
          <Text id="f-steps" label="Steps, one per line" rows={4} value={block.steps.join("\n")} onChange={(v) => onChange({ steps: lines(v) })} />
        </>
      )}
      {(block.kind === "field" || block.kind === "constant") && (
        <Text id="f-type" label="Type" value={block.type} onChange={(type) => onChange({ type })} />
      )}
      {block.kind === "constant" && <Text id="f-value" label="Value" value={block.value} onChange={(value) => onChange({ value })} />}
      {block.kind === "type" && (
        <>
          <Choice id="f-shape" label="Shape" value={block.shape} options={["struct", "enum"] as const} onChange={(shape) => onChange({ shape })} />
          <Text
            id="f-members"
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
            label={`${LANG_LABELS[lang]} package (optional)`}
            value={block.overrides[lang] ?? ""}
            onChange={(pkg) => onChange({ overrides: { ...block.overrides, [lang]: pkg || undefined } })}
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
