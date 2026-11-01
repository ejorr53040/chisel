import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Lang } from "./board";
import { allowedTools, buildPrompt, buildUpdatePrompt, generatorFor, updateTools } from "./prompts";
import { failedResult, type GenError, type GenerateResult } from "./run";
import { DEFAULT_MODULE } from "./serialize";

export type { GenError, GenerateResult };

export type Runner = (job: {
  prompt: string;
  cwd: string;
  tools: string[]; // allowedTools patterns
  onProgress: (line: string) => void;
  signal: AbortSignal;
}) => Promise<{ exitCode: number; output: string }>;

// Checks the finished project; returns no errors when it verifies.
export type Verifier = (runDir: string, lang: Lang, signal: AbortSignal) => Promise<GenError[]>;

const KEEP_RUNS = 5;
const ARCH_FILE = "architecture.arch.md";
const RESULT_FILE = "scaffold-result.json";
const STATUS_FILE = ".scaffold-run.json"; // our own verdict, read back when pruning
const RUN_DIR = /^\d{4}-\d\d-\d\dT/;
// Build and cache output is noise in the file list.
// Build output at a run's root, and the file that proves a build system made it (null: always build output).
// A Python package that happens to be named "build" is source, not output.
const BUILD_OUTPUT: Record<string, string | null> = { target: "Cargo.toml", build: "CMakeLists.txt", ".mypy_cache": null };
const isBuildOutput = (runDir: string, dir: string) =>
  Object.hasOwn(BUILD_OUTPUT, dir) && (BUILD_OUTPUT[dir] === null || existsSync(join(runDir, BUILD_OUTPUT[dir]!)));
// Caches that are noise at any depth.
const SKIP_DIRS = new Set(["__pycache__", ".mypy_cache", "node_modules", ".git"]);
const MAX_CHECK_OUTPUT = 200_000; // before splitting into errors
const MAX_ERROR = 4_000; // per error, after splitting

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
  const langDir = join(resolve(outDir), lang);
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
  const { exitCode, output } = await runner({ prompt, cwd: runDir, tools: allowedTools(lang), onProgress, signal });
  return judge(runDir, () => listFiles(runDir), RESULT_FILE, exitCode, output, () => verify(runDir, lang, signal), onProgress, signal);
}

// Turns a finished agent run into a result: its exit, its own claim, then our re-check of that claim.
async function judge(
  dir: string,
  files: () => string[],
  resultFile: string,
  exitCode: number,
  output: string,
  recheck: () => Promise<GenError[]>,
  onProgress: (line: string) => void,
  signal: AbortSignal,
): Promise<GenerateResult> {
  const failed = (message: string) => failedResult(message, dir, files());
  if (signal.aborted) return { ...failed("run cancelled"), cancelled: true };
  if (exitCode !== 0) return failed(`agent exited with code ${exitCode}:\n${output.slice(-2000)}`);
  const resultPath = join(dir, resultFile);
  if (!existsSync(resultPath)) return failed(`agent finished without writing ${resultFile}`);
  let claimed: { ok: boolean; errors: GenError[] };
  try {
    claimed = JSON.parse(readFileSync(resultPath, "utf8"));
    if (typeof claimed?.ok !== "boolean" || !Array.isArray(claimed.errors) || claimed.errors.some((e) => typeof e?.message !== "string"))
      throw new Error();
  } catch {
    return failed(`agent wrote a malformed ${resultFile}`);
  }
  const errors = claimed.errors.map((e) => (typeof e.blockId === "string" && e.blockId ? { blockId: e.blockId, message: e.message } : { message: e.message }));
  if (!claimed.ok) return { ok: false, runDir: dir, files: files(), errors };
  // The agent says it verified; check for ourselves before calling the run verified.
  onProgress("re-checking the project");
  const checkErrors = await recheck();
  if (signal.aborted) return { ...failed("run cancelled"), cancelled: true };
  return { ok: checkErrors.length === 0, runDir: dir, files: files(), errors: checkErrors };
}

const git = (repo: string, ...args: string[]) => exec("git", ["-C", repo, ...args]).then((r) => r.stdout.trim());
// Scratch files the agent reads and writes in the repository; hidden from git and removed afterwards.
const UPDATE_ARCH = ".scaffold-architecture.arch.md";
const UPDATE_RESULT = ".scaffold-result.json";

// Updates an existing repository in place so it matches the architecture file. The repository must have no
// uncommitted changes (the board's own files excepted) and the agent works on a new branch, so every change
// is reviewable and can be thrown away with git.
export async function update({
  arch,
  repo,
  checks,
  runner,
  verify = (dir, _lang, signal) => runCommands(dir, checks, signal),
  boardFiles = [],
  onProgress = () => {},
  signal = new AbortController().signal,
}: {
  arch: string;
  repo: string;
  checks: string[][];
  runner: Runner;
  verify?: Verifier;
  boardFiles?: string[]; // repo-relative paths that may be dirty: the board and its architecture file
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const root = await git(repo, "rev-parse", "--show-toplevel").catch(() => "");
  if (!root || realpathSync(root) !== realpathSync(repo)) throw new Error(`${repo} is not the root of a git repository`);
  const dirty = (await statusPaths(repo)).filter((path) => !boardFiles.includes(path));
  if (dirty.length) throw new Error(`${repo} has uncommitted changes: ${dirty.join(", ")}. Commit or stash them first.`);

  const branch = `scaffold/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await git(repo, "switch", "-q", "-c", branch);
  onProgress(`working on branch ${branch}`);
  const exclude = join(root, ".git", "info", "exclude");
  mkdirSync(join(exclude, ".."), { recursive: true });
  const excluded = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!excluded.includes(UPDATE_ARCH)) writeFileSync(exclude, `${excluded.trimEnd()}\n${UPDATE_ARCH}\n${UPDATE_RESULT}\n`.trimStart());
  writeFileSync(join(repo, UPDATE_ARCH), arch);

  let changed: string[] = [];
  const files = () => changed;
  try {
    const prompt = buildUpdatePrompt(UPDATE_ARCH, UPDATE_RESULT, checks);
    const { exitCode, output } = await runner({ prompt, cwd: repo, tools: updateTools(checks), onProgress, signal });
    changed = await changedFiles(repo, boardFiles);
    const result = await judge(repo, files, UPDATE_RESULT, exitCode, output, () => verify(repo, "python", signal), onProgress, signal);
    changed = await changedFiles(repo, boardFiles);
    return { ...result, files: changed, branch, errors: attribute(repo, arch, result.errors) };
  } finally {
    rmSync(join(repo, UPDATE_ARCH), { force: true });
    rmSync(join(repo, UPDATE_RESULT), { force: true });
  }
}

// Paths with uncommitted changes. Not trimmed: each porcelain line starts with a two-column status.
const statusPaths = async (repo: string) =>
  (await exec("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"])).stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));

const changedFiles = async (repo: string, boardFiles: string[]) =>
  (await statusPaths(repo)).filter((path) => !boardFiles.includes(path) && path !== UPDATE_ARCH && path !== UPDATE_RESULT).sort();

// Ids are any non-space run ending in a word character, so "@id f_x." or "@id f_x:" drop the punctuation.
const ID = /@id\s+([^\s:,;()"']*\w)/;
// A source location like src/lib.rs:6:5, anywhere in a line.
const LOCATION = /([\w./-]+\.\w+):(\d+)(?::\d+)?/;
// A line that starts one diagnostic: "path:line[:col]: error" (mypy, gcc, clang), "error[E0308]:" (rustc),
// GNU ld's "file.cpp:(.text+0x5): undefined reference" or lld's "ld.lld: error:". gcc's "required from
// here" backtrace lines are not headers.
const HEADER =
  /^(?:[\w./-]+\.\w+:\d+(?::\d+)?(?:: (?:fatal )?error| - error)|(?:error|warning|note)(?:\[\w+\])?:|\S+:\(\.[\w.$]+\+0x[0-9a-f]+\): undefined reference|\S*ld(?:\.lld)?: error:)/;

// Splits checker output into one message per error; warnings, notes and "could not compile" summaries
// are dropped. Undefined when the output holds no located error, so it stays one message.
function diagnostics(text: string): string[] | undefined {
  const chunks: string[][] = [];
  for (const line of text.split("\n")) {
    if (HEADER.test(line)) chunks.push([line]);
    else chunks.at(-1)?.push(line);
  }
  const errors = chunks
    .filter(([head]) => !/^(warning|note)(\[\w+\])?:|: (warning|note):|^error: (could not compile|aborting)/.test(head))
    .map((chunk) => ({ head: chunk[0], where: LOCATION.exec(chunk.join("\n"))?.[0] }));
  if (!errors.some((e) => e.where)) return;
  // rustc puts the location on a later "-->" line; carry it into the one-line message.
  return errors.map(({ head, where }) => (!where || head.includes(where) ? head : `${head} (${where})`));
}

// Ties each error to the board block it is about: the agent's blockId, an "@id x" in the message, or for a
// file:line diagnostic the nearest "@id" comment above that line in the generated code. Checker output is split
// into one error per diagnostic. Ids that are not on the board are dropped.
function attribute(runDir: string, arch: string, errors: GenError[]): GenError[] {
  // The board's ids, minus the synthetic default module, which has no block to point at.
  const known = new Set([...arch.matchAll(new RegExp(ID, "g"))].map((m) => m[1]).filter((id) => id !== DEFAULT_MODULE.id));
  const onBoard = (id: string | undefined) => (id && known.has(id) ? id : undefined);
  return errors
    .flatMap((e) => {
      const split = e.blockId ? undefined : diagnostics(e.message);
      return split ? split.map((message): GenError => ({ message })) : [e];
    })
    .map((e) => {
      const id = onBoard(e.blockId) ?? onBoard(ID.exec(e.message)?.[1]) ?? onBoard(idAbove(runDir, e.message));
      const message = e.message.slice(0, MAX_ERROR);
      return id ? { blockId: id, message } : { message };
    });
}

// ponytail: the nearest @id above a line can be a sibling when the error is in module-level code between
// definitions; good enough to point at the right area of the board.
function idAbove(runDir: string, message: string): string | undefined {
  const [, path, line] = LOCATION.exec(message) ?? [];
  if (!path) return;
  let file: string;
  try {
    // realpath, so a symlink the agent made can't point the read outside the run folder.
    file = realpathSync(resolve(runDir, path));
    if (!file.startsWith(realpathSync(runDir) + sep) || !statSync(file).isFile() || statSync(file).size > 2_000_000) return;
  } catch {
    return;
  }
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = Math.min(Number(line), lines.length) - 1; i >= 0; i--) {
    const id = ID.exec(lines[i])?.[1];
    if (id) return id;
  }
}

const exec = promisify(execFile);

export const runChecks: Verifier = (runDir, lang, signal = new AbortController().signal) => runCommands(runDir, generatorFor(lang).checks, signal);

async function runCommands(runDir: string, commands: string[][], signal: AbortSignal): Promise<GenError[]> {
  for (const command of commands) {
    if (signal.aborted) return [{ message: "run cancelled" }];
    try {
      await exec(command[0], command.slice(1), { cwd: runDir, timeout: 300_000, maxBuffer: 10 * 1024 * 1024, signal });
    } catch (e) {
      const { stdout = "", stderr = "", message } = e as { stdout?: string; stderr?: string; message: string };
      // Generous cap: it is split per diagnostic later, and rustc puts each location lines below its header.
      return [{ message: `${command.join(" ")} failed:\n${(stdout + stderr).trim() || message}`.slice(0, MAX_CHECK_OUTPUT) }];
    }
  }
  return [];
};

// True only for a folder generate() made, so the API never opens arbitrary paths.
export function isRunDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && existsSync(join(path, STATUS_FILE));
  } catch {
    return false;
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
  // Older runs keep their source but not their build output (a Rust target/ can be hundreds of MB).
  for (const old of runs.slice(0, -1))
    for (const dir of Object.keys(BUILD_OUTPUT))
      if (isBuildOutput(join(langDir, old), dir)) rmSync(join(langDir, old, dir), { recursive: true, force: true });
}

function listFiles(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((e) => {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) return SKIP_DIRS.has(e.name) || (!prefix && isBuildOutput(root, e.name)) ? [] : listFiles(root, rel);
      return e.name === STATUS_FILE ? [] : [rel];
    })
    .sort();
}
