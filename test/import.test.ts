import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importBoard, type Facts } from "../src/importer";
import { loadBoard, saveBoard } from "../src/store";

const json = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/import/${name}`, import.meta.url), "utf8"));
const shop = (): Facts => ({ name: "shop", outline: json("shop.outline.json") });
const def = (id: string, kind: string, parent?: string) => ({ id, kind, name: id, parent, path: "a.ts", line: 1, end_line: 1 });

describe("importBoard", () => {
  it("turns folders, files and functions into nested module and function blocks on a grid", () => {
    expect(importBoard(shop())).toEqual(json("shop.chisel.json"));
  });

  it("gives the same board whatever order tesselate lists definitions in", () => {
    const facts = shop();
    facts.outline.definitions.reverse();
    expect(importBoard(facts)).toEqual(json("shop.chisel.json"));
  });

  it("refuses an outline version it does not know", () => {
    const facts = shop();
    facts.outline.version = 2;
    expect(() => importBoard(facts)).toThrow(/outline version 2/);
  });

  it("makes ids the architecture file can carry, and keeps them unique", () => {
    const facts: Facts = { name: "x", outline: { version: 1, unindexed: [], definitions: [def("a", "module"), def("a::b", "function", "a"), def("a.c", "function", "a")] } };
    expect(importBoard(facts).blocks.map((b) => b.id)).toEqual(["m_a", "f_a.c", "f_a__b"]);
    const clash: Facts = { name: "x", outline: { version: 1, unindexed: [], definitions: [def("a", "module"), def("a:b", "function", "a"), def("a_b", "function", "a")] } };
    expect(importBoard(clash).blocks.map((b) => b.id)).toEqual(["m_a", "f_a_b", "f_a_b_2"]);
  });

  it("saves and loads an imported board with its sources, import warnings and unindexed files", () => {
    const path = join(mkdtempSync(join(tmpdir(), "chisel-import-")), "shop.chisel.json");
    saveBoard(path, importBoard(shop()));
    expect(loadBoard(path)).toEqual(json("shop.chisel.json"));
  });
});
