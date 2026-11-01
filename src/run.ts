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

export const failedResult = (message: string, runDir = "", files: string[] = []): GenerateResult => ({
  ok: false,
  runDir,
  files,
  errors: [{ message }],
});
