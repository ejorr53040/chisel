import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "../src/board";
import { loadBoard, saveBoard } from "../src/store";

const fixture = (name: string): Board =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.scaffold.json`, import.meta.url), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "scaffold-"));

describe("board file store", () => {
  it("saves the board and its architecture file, and loads the board back", () => {
    const path = join(tmp(), "shop.scaffold.json");
    const board = fixture("nested-modules");

    saveBoard(path, board);

    expect(loadBoard(path)).toEqual(board);
    expect(readFileSync(join(path, "..", "shop.arch.md"), "utf8")).toBe(
      readFileSync(new URL("fixtures/nested-modules.arch.md", import.meta.url), "utf8"),
    );
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
  ])("rejects a malformed board file (%s) with a readable error", (_case, contents, message) => {
    const path = join(tmp(), "bad.scaffold.json");
    writeFileSync(path, contents);
    expect(() => loadBoard(path)).toThrow(message);
  });
});
