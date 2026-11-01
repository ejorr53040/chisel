// Real-agent smoke test: runs `claude -p` for real. Opt in with SCAFFOLD_AGENT_SMOKE=1 (slow, uses your Claude account).
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board, Lang } from "../../src/board";
import { GENERATORS } from "../../src/prompts";
import { serialize } from "../../src/serialize";
import { generate, runChecks } from "../../src/generate";
import { claudeRunner } from "../../src/claude";

const board: Board = {
  version: 1,
  name: "greeter",
  edges: [{ id: "e_calls", source: "f_bump", target: "f_greeting", kind: "calls" }],
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
      signature: "-> int", intent: "Adds one to count, prints greeting(str(count)), and returns count.", steps: [],
    },
    { id: "t_mood", kind: "type", name: "Mood", parentId: "m_greet", position: { x: 0, y: 0 }, shape: "enum", members: ["happy", "sad"] },
    { id: "k_max", kind: "constant", name: "MAX_NAME", parentId: "m_greet", position: { x: 0, y: 0 }, type: "int", value: "40" },
    { id: "e_main", kind: "entry", name: "main", position: { x: 0, y: 0 }, trigger: "main", detail: "prints greeting('world')" },
  ],
};

const langs = (process.env.SCAFFOLD_AGENT_LANGS?.split(",") ?? Object.keys(GENERATORS)) as Lang[];

describe.skipIf(!process.env.SCAFFOLD_AGENT_SMOKE).each(langs)("real agent: %s", (lang) => {
  it("generates a project that passes the language's own checks", { timeout: 900_000 }, async () => {
    const progress: string[] = [];
    const result = await generate({
      arch: serialize(board, lang).arch,
      lang,
      outDir: mkdtempSync(join(tmpdir(), `scaffold-agent-${lang}-`)),
      runner: claudeRunner,
      onProgress: (l) => progress.push(l),
    });
    console.log(result.runDir, "\n" + progress.join("\n"));

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.files).toContain("MAPPING.md");
    // Check the agent's claim ourselves, with the same commands the server uses.
    expect(await runChecks(result.runDir, lang)).toEqual([]);
    const sources = result.files.filter((f) => /\.(py|rs|cpp|hpp|h|cc)$/.test(f));
    expect(sources.some((f) => readFileSync(join(result.runDir, f), "utf8").includes("greeting"))).toBe(true);
  });
});
