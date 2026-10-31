import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lang } from "./board";
import { allowedTools, buildPrompt } from "./prompts";

export interface GenError {
  blockId?: string;
  message: string;
}

export interface GenerateResult {
  ok: boolean;
  runDir: string;
  files: string[];
  errors: GenError[];
}

export type Runner = (job: {
  prompt: string;
  cwd: string;
  lang: Lang;
  onProgress: (line: string) => void;
}) => Promise<{ exitCode: number; output: string }>;

const KEEP_RUNS = 5;
const ARCH_FILE = "architecture.arch.md";
const RESULT_FILE = "scaffold-result.json";
const RUN_DIR = /^\d{4}-\d\d-\d\dT/;
// Build and cache output is noise in the file list.
const SKIP_DIRS = new Set(["__pycache__", ".mypy_cache", "target", "build", "node_modules", ".git"]);

export async function generate({
  arch,
  lang,
  outDir,
  runner,
  onProgress = () => {},
}: {
  arch: string;
  lang: Lang;
  outDir: string;
  runner: Runner;
  onProgress?: (line: string) => void;
}): Promise<GenerateResult> {
  const langDir = join(outDir, lang);
  mkdirSync(langDir, { recursive: true });
  const runDir = newRunDir(langDir);
  writeFileSync(join(runDir, ARCH_FILE), arch);
  prune(langDir);

  const { exitCode, output } = await runner({ prompt: buildPrompt(lang, ARCH_FILE, RESULT_FILE), cwd: runDir, lang, onProgress });
  const done = (ok: boolean, errors: GenError[]): GenerateResult => ({ ok, runDir, files: listFiles(runDir), errors });

  if (exitCode !== 0) return done(false, [{ message: `agent exited with code ${exitCode}:\n${output.slice(-2000)}` }]);
  const resultPath = join(runDir, RESULT_FILE);
  if (!existsSync(resultPath)) return done(false, [{ message: `agent finished without writing ${RESULT_FILE}` }]);
  try {
    const r = JSON.parse(readFileSync(resultPath, "utf8"));
    if (typeof r?.ok !== "boolean" || !Array.isArray(r.errors) || r.errors.some((e: GenError) => typeof e?.message !== "string"))
      throw new Error();
    const errors = r.errors.map((e: GenError) => (typeof e.blockId === "string" && e.blockId ? { blockId: e.blockId, message: e.message } : { message: e.message }));
    return done(r.ok, errors);
  } catch {
    return done(false, [{ message: `agent wrote a malformed ${RESULT_FILE}` }]);
  }
}

// ISO timestamps sort chronologically as strings; a suffix keeps same-millisecond runs apart.
function newRunDir(langDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; ; i++) {
    const dir = join(langDir, i ? `${stamp}-${i}` : stamp);
    try {
      mkdirSync(dir);
      return dir;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

function prune(langDir: string) {
  const runs = readdirSync(langDir).filter((d) => RUN_DIR.test(d)).sort();
  for (const old of runs.slice(0, -KEEP_RUNS)) rmSync(join(langDir, old), { recursive: true, force: true });
}

function listFiles(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((e) => {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : listFiles(root, rel);
      return [rel];
    })
    .sort();
}

// The real agent: Claude Code in print mode, limited to editing the run folder and running the verifier.
export const claudeRunner: Runner = ({ prompt, cwd, lang, onProgress }) =>
  new Promise((resolve) => {
    const child = spawn(
      "claude",
      ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", ...allowedTools(lang)],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let pending = "";
    const handle = (line: string) => {
      if (!line.trim()) return;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "assistant")
          for (const c of ev.message?.content ?? []) {
            if (c.type === "text" && c.text.trim()) onProgress(c.text.trim().split("\n")[0].slice(0, 200));
            if (c.type === "tool_use")
              onProgress(`${c.name} ${String(c.input?.file_path ?? c.input?.command ?? "").split("\n")[0]}`.trim().slice(0, 200));
          }
        if (ev.type === "result") output += `${ev.result ?? ""}\n`;
      } catch {
        output += line + "\n";
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      lines.forEach(handle);
    });
    child.stderr.on("data", (chunk: Buffer) => (output += chunk));
    child.on("error", (e) => resolve({ exitCode: 127, output: `could not start claude: ${e.message}` }));
    child.on("close", (code) => {
      handle(pending);
      resolve({ exitCode: code ?? 1, output });
    });
  });
