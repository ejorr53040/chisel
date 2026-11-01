// Board model shared by the UI and the server. The board file is the source of truth.

export type Lang = "python" | "rust" | "cpp";

interface BlockBase {
  id: string;
  name: string;
  parentId?: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  notes?: string;
}

export interface ModuleBlock extends BlockBase {
  kind: "module";
}

export interface FunctionBlock extends BlockBase {
  kind: "function";
  signature: string; // loose, e.g. "(email, password) -> User"
  intent: string;
  steps: string[];
}

export interface ClassBlock extends BlockBase {
  kind: "class";
}

export interface InterfaceBlock extends BlockBase {
  kind: "interface";
}

export interface FieldBlock extends BlockBase {
  kind: "field";
  type: string;
}

export interface ConstantBlock extends BlockBase {
  kind: "constant";
  type: string;
  value: string;
}

export interface TypeBlock extends BlockBase {
  kind: "type";
  shape: "struct" | "enum";
  members: string[]; // "name: type" for a struct, variant names for an enum
}

// The block's name is the capability ("HTTP server"); overrides pin a package per language.
export interface LibraryBlock extends BlockBase {
  kind: "library";
  overrides: Partial<Record<Lang, string>>;
}

export interface ServiceBlock extends BlockBase {
  kind: "service";
  description: string;
}

export interface EntryBlock extends BlockBase {
  kind: "entry";
  trigger: "main" | "http" | "cli";
  detail: string; // route or command, e.g. "POST /checkout"
}

export type Block =
  | ModuleBlock
  | FunctionBlock
  | ClassBlock
  | InterfaceBlock
  | FieldBlock
  | ConstantBlock
  | TypeBlock
  | LibraryBlock
  | ServiceBlock
  | EntryBlock;
export type Kind = Block["kind"];

// The one list of block kinds; its order is the sibling order in the architecture file.
export const BLOCK_KINDS = [
  "entry",
  "library",
  "service",
  "constant",
  "type",
  "interface",
  "class",
  "field",
  "function",
  "module",
] as const satisfies readonly Kind[];

// What each container may hold; kinds missing here hold nothing.
export const CONTAINS: Partial<Record<Kind, readonly Kind[]>> = {
  module: BLOCK_KINDS,
  class: ["constant", "type", "field", "function"],
  interface: ["function"],
};
export const canContain = (parent: Kind, child: Kind) => CONTAINS[parent]?.includes(child) ?? false;

export const LANGS: readonly Lang[] = ["python", "rust", "cpp"];
export const TRIGGERS = ["main", "http", "cli"] as const;

export function newBlock(kind: Kind, position: { x: number; y: number }): Block {
  const base = { id: newId(kind[0]), name: kind === "module" ? "module" : `new ${kind}`, position };
  switch (kind) {
    case "function":
      return { ...base, kind, name: "function", signature: "()", intent: "", steps: [] };
    case "field":
      return { ...base, kind, name: "field", type: "" };
    case "constant":
      return { ...base, kind, name: "CONSTANT", type: "", value: "" };
    case "type":
      return { ...base, kind, name: "Type", shape: "struct", members: [] };
    case "library":
      return { ...base, kind, name: "capability", overrides: {} };
    case "service":
      return { ...base, kind, name: "service", description: "" };
    case "entry":
      return { ...base, kind, name: "main", trigger: "main", detail: "" };
    case "class":
      return { ...base, kind, name: "Class" };
    case "interface":
      return { ...base, kind, name: "Interface" };
    case "module":
      return { ...base, kind };
  }
}

// Structural relationships first, then behaviour; the order edges are listed in under their source block.
export const EDGE_KINDS = ["inherits", "implements", "imports", "uses", "calls", "returns", "emits", "handles", "other"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Edge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string; // only for "other"
}

export interface Board {
  version: 1;
  name: string;
  blocks: Block[];
  edges: Edge[];
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}
