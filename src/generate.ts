import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Lang } from "./board";
import { buildPrompt, generatorFor } from "./prompts";
import { failedResult, type GenError, type GenerateResult } from "./run";

export type { GenError, GenerateResult };

export type Runner = (job: {
  prompt: string;
  cwd: string;
  lang: Lang;
  onProgress: (line: string) => void;
  signal: AbortSignal;
}) => Promise<{ exitCode: number; output: string }>;

// Checks the finished project; returns no errors when it verifies.
export type Verifier = (runDir: string, lang: Lang) => Promise<GenError[]>;

const KEEP_RUNS = 5;
const ARCH_FILE = "architecture.arch.md";
const RESULT_FILE = "scaffold-result.json";
const STATUS_FILE = ".scaffold-run.json"; // our own verdict, read back when pruning
const RUN_DIR = /^\d{4}-\d\d-\d\dT/;
// Build and cache output is noise in the file list.
const SKIP_DIRS = new Set(["__pycache__", ".mypy_cache", "target", "build", "node_modules", ".git"]);

export async function generate({
  arch,
  lang,
  outDir,
  runner,
  verify = runChecks,
  onProgress = () => {},
  signal = new AbortController().signal,
}: {
  arch: string;
  lang: Lang;
  outDir: string;
  runner: Runner;
  verify?: Verifier;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const prompt = buildPrompt(lang, ARCH_FILE, RESULT_FILE);
  const langDir = join(outDir, lang);
  mkdirSync(langDir, { recursive: true });
  const runDir = newRunDir(langDir);
  writeFileSync(join(runDir, ARCH_FILE), arch);

  const result = await runAgent(runDir, lang, prompt, runner, verify, onProgress, signal);
  result.errors = attribute(runDir, arch, result.errors);
  writeFileSync(join(runDir, STATUS_FILE), JSON.stringify({ ok: result.ok }));
  prune(langDir);
  return result;
}

async function runAgent(
  runDir: string,
  lang: Lang,
  prompt: string,
  runner: Runner,
  verify: Verifier,
  onProgress: (line: string) => void,
  signal: AbortSignal,
): Promise<GenerateResult> {
  const { exitCode, output } = await runner({ prompt, cwd: runDir, lang, onProgress, signal });
  const failed = (message: string) => failedResult(message, runDir, listFiles(runDir));

  if (signal.aborted) return failed("run cancelled");
  if (exitCode !== 0) return failed(`agent exited with code ${exitCode}:\n${output.slice(-2000)}`);
  const resultPath = join(runDir, RESULT_FILE);
  if (!existsSync(resultPath)) return failed(`agent finished without writing ${RESULT_FILE}`);
  let claimed: { ok: boolean; errors: GenError[] };
  try {
    claimed = JSON.parse(readFileSync(resultPath, "utf8"));
    if (typeof claimed?.ok !== "boolean" || !Array.isArray(claimed.errors) || claimed.errors.some((e) => typeof e?.message !== "string"))
      throw new Error();
  } catch {
    return failed(`agent wrote a malformed ${RESULT_FILE}`);
  }
  const errors = claimed.errors.map((e) => (typeof e.blockId === "string" && e.blockId ? { blockId: e.blockId, message: e.message } : { message: e.message }));
  if (!claimed.ok) return { ok: false, runDir, files: listFiles(runDir), errors };
  // The agent says it verified; check for ourselves before calling the run verified.
  onProgress("re-checking the project");
  const checkErrors = await verify(runDir, lang);
  return { ok: checkErrors.length === 0, runDir, files: listFiles(runDir), errors: checkErrors };
}

const ID = /@id\s+(\w+)/;
// A source location like src/lib.rs:6:5, anywhere in a line.
const LOCATION = /([\w./-]+\.\w+):(\d+)(?::\d+)?/;
// A line that starts one diagnostic: "path:line[:col]:" (mypy, gcc) or "error[E0308]:" (rustc).
const HEADER = /^(?:[\w./-]+\.\w+:\d+(?::\d+)?:|(?:error|warning)(?:\[\w+\])?:)/;

// Splits checker output into one message per error that has a source location; warnings and
// "could not compile" summaries are dropped. Undefined when the output holds no located error.
function diagnostics(text: string): string[] | undefined {
  const chunks: string[][] = [];
  for (const line of text.split("\n")) {
    if (HEADER.test(line)) chunks.push([line]);
    else chunks.at(-1)?.push(line);
  }
  const located = chunks
    .filter(([head]) => !/^warning|: warning:|^error: (could not compile|aborting)/.test(head))
    .map((chunk) => ({ head: chunk[0], where: LOCATION.exec(chunk.join("\n"))?.[0] }))
    .filter((c) => c.where);
  if (!located.length) return;
  // rustc puts the location on a later "-->" line; carry it into the one-line message.
  return located.map(({ head, where }) => (head.includes(where!) ? head : `${head} (${where})`));
}

// Ties each error to the board block it is about: the agent's blockId, an "@id x" in the message, or for a
// file:line diagnostic the nearest "@id" comment above that line in the generated code. Checker output is split
// into one error per diagnostic. Ids that are not on the board are dropped.
function attribute(runDir: string, arch: string, errors: GenError[]): GenError[] {
  const known = new Set([...arch.matchAll(new RegExp(ID, "g"))].map((m) => m[1]));
  return errors
    .flatMap((e) => {
      const split = e.blockId ? undefined : diagnostics(e.message);
      return split ? split.map((message): GenError => ({ message })) : [e];
    })
    .map((e) => {
      const id = e.blockId ?? ID.exec(e.message)?.[1] ?? idAbove(runDir, e.message);
      return id && known.has(id) ? { blockId: id, message: e.message } : { message: e.message };
    });
}

// ponytail: the nearest @id above a line can be a sibling when the error is in module-level code between
// definitions; good enough to point at the right area of the board.
function idAbove(runDir: string, message: string): string | undefined {
  const [, path, line] = LOCATION.exec(message) ?? [];
  if (!path) return;
  const file = resolve(runDir, path);
  if (!file.startsWith(runDir + sep) || !existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = Math.min(Number(line), lines.length) - 1; i >= 0; i--) {
    const id = ID.exec(lines[i])?.[1];
    if (id) return id;
  }
}

const exec = promisify(execFile);

export const runChecks: Verifier = async (runDir, lang) => {
  for (const command of generatorFor(lang).checks) {
    try {
      await exec(command[0], command.slice(1), { cwd: runDir, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
      const { stdout = "", stderr = "", message } = e as { stdout?: string; stderr?: string; message: string };
      return [{ message: `${command.join(" ")} failed:\n${(stdout + stderr).trim() || message}`.slice(0, 4000) }];
    }
  }
  return [];
};

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

// Keeps the newest runs, and always the newest verified one, so a string of bad runs never destroys a good one.
function prune(langDir: string) {
  const runs = readdirSync(langDir).filter((d) => RUN_DIR.test(d)).sort();
  const verified = (run: string) => {
    try {
      return JSON.parse(readFileSync(join(langDir, run, STATUS_FILE), "utf8")).ok === true;
    } catch {
      return false;
    }
  };
  const keep = runs.findLast(verified);
  for (const old of runs.slice(0, -KEEP_RUNS)) if (old !== keep) rmSync(join(langDir, old), { recursive: true, force: true });
}

function listFiles(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((e) => {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : listFiles(root, rel);
      return e.name === STATUS_FILE ? [] : [rel];
    })
    .sort();
}
