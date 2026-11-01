import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { update, type Runner, type Verifier } from "../src/generate";

const ARCH = "module app  @id m_app\n  fn greet()  @id f_greet\n    intent: Says hello.\n";
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

function repo(files: Record<string, string> = { "src/app.ts": "// @id f_greet\nexport const greet = () => 'hi';\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "chisel-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

// Stands in for the agent: edits files in the repo and writes the result file the prompt names.
const editingAgent =
  (edits: Record<string, string>, result: object = { ok: true, errors: [] }): Runner =>
  async ({ cwd, prompt }) => {
    for (const [f, text] of Object.entries(edits)) writeFileSync(join(cwd, f), text);
    const resultFile = /write \.\/(\S+) as JSON/.exec(prompt)![1];
    writeFileSync(join(cwd, resultFile), JSON.stringify(result));
    return { exitCode: 0, output: "" };
  };
const passes: Verifier = async () => [];

describe("update (an existing repository, in place)", () => {
  it("works on a new branch, reports the files it changed and cleans up its scratch files", async () => {
    const dir = repo();
    let prompt = "";
    const runner: Runner = async (job) => {
      prompt = job.prompt;
      expect(job.cwd).toBe(dir);
      expect(readFileSync(join(dir, /Read \.\/(\S+)\./.exec(job.prompt)![1]), "utf8")).toBe(ARCH);
      return editingAgent({ "src/app.ts": "// @id f_greet\nexport const greet = () => 'hello';\n" })(job);
    };

    const result = await update({ arch: ARCH, repo: dir, checks: [["npm", "test"]], runner, verify: passes });

    expect(result.ok).toBe(true);
    expect(result.branch).toMatch(/^chisel\/\d{4}-/);
    expect(git(dir, "branch", "--show-current")).toBe(result.branch);
    expect(result.files).toEqual(["src/app.ts"]);
    expect(prompt).toContain("npm test");
    expect(git(dir, "status", "--porcelain")).toBe("M src/app.ts");
  });

  it("refuses a repository with uncommitted changes, apart from the board's own files", async () => {
    const dir = repo();
    writeFileSync(join(dir, "me.chisel.json"), "{}");
    writeFileSync(join(dir, "me.arch.md"), "x");
    const allowed = { arch: ARCH, repo: dir, checks: [], runner: editingAgent({}), verify: passes, boardFiles: ["me.chisel.json", "me.arch.md"] };
    await expect(update(allowed)).resolves.toMatchObject({ ok: true });

    const dirty = repo();
    writeFileSync(join(dirty, "src/app.ts"), "changed");
    await expect(update({ ...allowed, repo: dirty, boardFiles: [] })).rejects.toThrow(/uncommitted changes: src\/app.ts/);
    expect(git(dirty, "branch", "--show-current")).toBe("main");
  });

  it("runs the repository's checks and ties failures to blocks", async () => {
    const dir = repo();
    let checked = "";
    const result = await update({
      arch: ARCH,
      repo: dir,
      checks: [["npm", "test"]],
      runner: editingAgent({ "src/app.ts": "// @id f_greet\nexport const greet = (): number => 'x';\n" }),
      verify: async (d) => ((checked = d), [{ message: "src/app.ts:2:32 - error TS2322: Type 'string' is not assignable to type 'number'." }]),
    });
    expect(checked).toBe(dir);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ blockId: "f_greet", message: "src/app.ts:2:32 - error TS2322: Type 'string' is not assignable to type 'number'." }]);
  });

  it("refuses a folder that is not the root of a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chisel-norepo-"));
    await expect(update({ arch: ARCH, repo: dir, checks: [], runner: editingAgent({}), verify: passes })).rejects.toThrow(/not the root of a git repository/);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });
});
