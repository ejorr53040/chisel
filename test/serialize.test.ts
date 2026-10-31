import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Board } from "../src/board";
import { serialize } from "../src/serialize";

const fixture = (name: string): Board =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.scaffold.json`, import.meta.url), "utf8"));
const golden = (name: string) =>
  readFileSync(new URL(`fixtures/${name}.arch.md`, import.meta.url), "utf8");

describe("serialize", () => {
  it.each(["single-function", "module-with-functions", "nested-modules"])("renders %s to its golden architecture file", (name) => {
    expect(serialize(fixture(name)).arch).toBe(golden(name));
  });
});

describe("serialize is deterministic", () => {
  it("ignores block array order and positions", () => {
    const board = fixture("nested-modules");
    const reshuffled: Board = {
      ...board,
      blocks: [...board.blocks].reverse().map((b, i) => ({ ...b, position: { x: i * 37, y: -i * 11 } })),
    };
    expect(serialize(reshuffled).arch).toBe(serialize(board).arch);
  });
});

describe("serialize skips blank steps", () => {
  it("drops empty and whitespace-only steps, and the steps line when none remain", () => {
    const board = fixture("single-function");
    const fn = board.blocks[0] as Extract<Board["blocks"][number], { kind: "function" }>;
    fn.steps = ["look up the user by email", "", "   "];
    expect(serialize(board).arch).toContain("  steps:\n    - look up the user by email\n");
    expect(serialize(board).arch).not.toContain("    - \n");
    fn.steps = ["", " "];
    expect(serialize(board).arch).not.toContain("steps:");
  });
});
