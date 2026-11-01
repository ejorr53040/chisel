// Run results, shared by the server and the UI (no Node imports here).

export interface GenError {
  blockId?: string;
  message: string;
}

export interface GenerateResult {
  ok: boolean;
  runDir: string;
  files: string[];
  errors: GenError[];
  cancelled?: boolean;
  branch?: string; // set when a repository was updated in place
}

// The server's one running generation, named by the id its `start` event sent.
export interface ActiveRun {
  id: string;
  controller: AbortController;
}

// @id e_cancel
// Aborts the current run only when runId names it, so a Cancel from one tab can't stop another tab's run.
export function cancelRun(current: ActiveRun | null, runId: unknown): boolean {
  if (!current || runId !== current.id) return false;
  current.controller.abort();
  return true;
}

export const failedResult = (message: string, runDir = "", files: string[] = []): GenerateResult => ({
  ok: false,
  runDir,
  files,
  errors: [{ message }],
});
