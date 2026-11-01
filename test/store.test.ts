import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "../src/board";
import { loadBoard, saveBoard } from "../src/store";

const fixture = (name: string): Board =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.chisel.json`, import.meta.url), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "chisel-"));

describe("board file store", () => {
  it("saves the board and its architecture file, and loads the board back", () => {
    const path = join(tmp(), "shop.chisel.json");
    const board = fixture("nested-modules");

    saveBoard(path, board);

    expect(loadBoard(path)).toEqual(board);
    expect(readFileSync(join(path, "..", "shop.arch.md"), "utf8")).toBe(
      readFileSync(new URL("fixtures/nested-modules.arch.md", import.meta.url), "utf8"),
    );
  });

  it("round-trips a board with every block kind", () => {
    const path = join(tmp(), "shop.chisel.json");
    saveBoard(path, fixture("all-kinds"));
    expect(loadBoard(path)).toEqual(fixture("all-kinds"));
  });

  it("round-trips a board with every edge kind", () => {
    const path = join(tmp(), "accounts.chisel.json");
    saveBoard(path, fixture("edges"));
    expect(loadBoard(path)).toEqual(fixture("edges"));
  });

  it("round-trips a board that targets an existing repository", () => {
    const path = join(tmp(), "self.chisel.json");
    const board = { ...fixture("single-function"), target: { repo: ".", checks: [["npx", "tsc", "--noEmit"], ["npx", "vitest", "run"]] } };
    saveBoard(path, board);
    expect(loadBoard(path)).toEqual(board);
  });

    it("keeps Chisel's own board valid", () => {
    const board = loadBoard(new URL("../chisel.chisel.json", import.meta.url).pathname);
    expect(board.target).toEqual({ repo: ".", checks: [["npx", "tsc", "--noEmit"], ["npx", "vitest", "run"]] });
  });

  it("creates the board's folder when it does not exist yet", () => {
    const path = join(tmp(), "boards", "nested", "shop.chisel.json");
    saveBoard(path, fixture("nested-modules"));
    expect(loadBoard(path)).toEqual(fixture("nested-modules"));
  });

  it.each([
    ["not JSON", "{ nope", /not valid JSON/],
    ["wrong version", JSON.stringify({ version: 9, name: "x", blocks: [], edges: [] }), /version/],
    ["missing blocks", JSON.stringify({ version: 1, name: "x", edges: [] }), /blocks/],
    [
      "unknown block kind",
      JSON.stringify({ version: 1, name: "x", edges: [], blocks: [{ id: "a", kind: "spaceship", name: "a", position: { x: 0, y: 0 } }] }),
      /spaceship/,
    ],
    [
      "dangling parent",
      JSON.stringify({ version: 1, name: "x", edges: [], blocks: [{ id: "a", kind: "module", name: "a", parentId: "ghost", position: { x: 0, y: 0 } }] }),
      /ghost/,
    ],
    ["null block", JSON.stringify({ version: 1, name: "x", edges: [], blocks: [null] }), /block 0 is not an object/],
    [
      "parent cycle",
      JSON.stringify({
        version: 1, name: "x", edges: [],
        blocks: [
          { id: "a", kind: "module", name: "a", parentId: "b", position: { x: 0, y: 0 } },
          { id: "b", kind: "module", name: "b", parentId: "a", position: { x: 0, y: 0 } },
        ],
      }),
      /cycle/,
    ],
    [
      "function as parent",
      JSON.stringify({
        version: 1, name: "x", edges: [],
        blocks: [
          { id: "f", kind: "function", name: "f", position: { x: 0, y: 0 }, signature: "", intent: "", steps: [] },
          { id: "m", kind: "module", name: "m", parentId: "f", position: { x: 0, y: 0 } },
        ],
      }),
      /cannot contain/,
    ],
    [
      "field inside an interface",
      JSON.stringify({
        version: 1, name: "x", edges: [],
        blocks: [
          { id: "i", kind: "interface", name: "I", position: { x: 0, y: 0 } },
          { id: "x", kind: "field", name: "f", parentId: "i", position: { x: 0, y: 0 }, type: "" },
        ],
      }),
      /interface cannot contain a field/,
    ],
    [
      "type with an unknown shape",
      JSON.stringify({ version: 1, name: "x", edges: [], blocks: [{ id: "t", kind: "type", name: "T", position: { x: 0, y: 0 }, shape: "blob", members: [] }] }),
      /type t needs shape/,
    ],
    [
      "entry with an unknown trigger",
      JSON.stringify({ version: 1, name: "x", edges: [], blocks: [{ id: "e", kind: "entry", name: "e", position: { x: 0, y: 0 }, trigger: "cron", detail: "" }] }),
      /entry e needs trigger/,
    ],
    [
      "library override for an unknown language",
      JSON.stringify({ version: 1, name: "x", edges: [], blocks: [{ id: "l", kind: "library", name: "http", position: { x: 0, y: 0 }, overrides: { cobol: "x" } }] }),
      /library l needs overrides/,
    ],
    [
      "the reserved default-module id",
      JSON.stringify({ version: 1, name: "x", edges: [], blocks: [{ id: "_main", kind: "service", name: "s", position: { x: 0, y: 0 }, description: "" }] }),
      /_main is reserved/,
    ],
    [
      "edge to a missing block",
      JSON.stringify({ version: 1, name: "x", blocks: [{ id: "a", kind: "module", name: "a", position: { x: 0, y: 0 } }], edges: [{ id: "e", source: "a", target: "ghost", kind: "uses" }] }),
      /edge e points at "ghost"/,
    ],
    [
      "edge with an unknown kind",
      JSON.stringify({ version: 1, name: "x", blocks: [{ id: "a", kind: "module", name: "a", position: { x: 0, y: 0 } }], edges: [{ id: "e", source: "a", target: "a", kind: "loves" }] }),
      /edge e has unknown kind "loves"/,
    ],
    [
      "duplicate edge ids",
      JSON.stringify({
        version: 1, name: "x", blocks: [{ id: "a", kind: "module", name: "a", position: { x: 0, y: 0 } }],
        edges: [{ id: "e", source: "a", target: "a", kind: "uses" }, { id: "e", source: "a", target: "a", kind: "calls" }],
      }),
      /duplicate edge ids/,
    ],
    [
      "label on an edge that is not other",
      JSON.stringify({ version: 1, name: "x", blocks: [{ id: "a", kind: "module", name: "a", position: { x: 0, y: 0 } }], edges: [{ id: "e", source: "a", target: "a", kind: "uses", label: "hm" }] }),
      /only "other" edges have labels/,
    ],
    [
      "target without a repo",
      JSON.stringify({ version: 1, name: "x", blocks: [], edges: [], target: { checks: [] } }),
      /target needs a repo path/,
    ],
    [
      "target checks that are not command lists",
      JSON.stringify({ version: 1, name: "x", blocks: [], edges: [], target: { repo: ".", checks: ["npm test"] } }),
      /target checks must be commands/,
    ],
  ])("rejects a malformed board file (%s) with a readable error", (_case, contents, message) => {
    const path = join(tmp(), "bad.chisel.json");
    writeFileSync(path, contents);
    expect(() => loadBoard(path)).toThrow(message);
  });
});
