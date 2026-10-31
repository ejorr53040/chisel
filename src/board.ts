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

export type Block = ModuleBlock | FunctionBlock;

export interface Edge {
  id: string;
  source: string;
  target: string;
  kind: string;
  label?: string;
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
