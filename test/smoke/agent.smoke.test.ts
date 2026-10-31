// Real-agent smoke test: runs `claude -p` for real. Opt in with SCAFFOLD_AGENT_SMOKE=1 (slow, uses your Claude account).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "../../src/board";
import { serialize } from "../../src/serialize";
import { generate } from "../../src/generate";
import { claudeRunner } from "../../src/claude";

const board: Board = {
  version: 1,
  name: "greeter",
  edges: [],
  blocks: [
    { id: "m_greet", kind: "module", name: "greet", position: { x: 0, y: 0 } },
    {
      id: "f_greeting", kind: "function", name: "greeting", parentId: "m_greet", position: { x: 0, y: 0 },
      signature: "(name: str) -> str", intent: "Returns 'Hello, <name>!'.", steps: [],
    },
    { id: "c_counter", kind: "class", name: "Counter", parentId: "m_greet", position: { x: 0, y: 0 } },
    { id: "x_count", kind: "field", name: "count", parentId: "c_counter", position: { x: 0, y: 0 }, type: "int" },
    {
      id: "f_bump", kind: "function", name: "bump", parentId: "c_counter", position: { x: 0, y: 0 },
      signature: "-> int", intent: "Adds one to count and returns it.", steps: [],
    },
    { id: "t_mood", kind: "type", name: "Mood", parentId: "m_greet", position: { x: 0, y: 0 }, shape: "enum", members: ["happy", "sad"] },
    { id: "k_max", kind: "constant", name: "MAX_NAME", parentId: "m_greet", position: { x: 0, y: 0 }, type: "int", value: "40" },
    { id: "e_main", kind: "entry", name: "main", position: { x: 0, y: 0 }, trigger: "main", detail: "prints greeting('world')" },
  ],
};

describe.skipIf(!process.env.SCAFFOLD_AGENT_SMOKE)("real agent", () => {
  it("generates a Python project that passes py_compile and mypy", { timeout: 600_000 }, async () => {
    const progress: string[] = [];
    const result = await generate({
      arch: serialize(board, "python").arch,
      lang: "python",
      outDir: mkdtempSync(join(tmpdir(), "scaffold-agent-")),
      runner: claudeRunner,
      onProgress: (l) => progress.push(l),
    });
    console.log(result.runDir, "\n" + progress.join("\n"));

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.files).toContain("MAPPING.md");
    const py = result.files.filter((f) => f.endsWith(".py"));
    expect(py.length).toBeGreaterThan(0);
    // Check the agent's claim ourselves.
    execFileSync("python3", ["-m", "py_compile", ...py], { cwd: result.runDir });
    execFileSync("mypy", ["--ignore-missing-imports", "."], { cwd: result.runDir });
    expect(readFileSync(join(result.runDir, py.find((f) => f.endsWith("greet.py"))!), "utf8")).toMatch(/def greeting/);
  });
});
