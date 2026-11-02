import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Block, Board } from "../src/board";
import ELK from "elkjs/lib/elk.bundled.js";
import { layoutBoard as layoutWith, type Box, type Size } from "../src/layout";
import { importBoard } from "../src/importer";
import { loadBoard } from "../src/store";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = (name: string): Board => JSON.parse(readFileSync(new URL(`fixtures/${name}.chisel.json`, import.meta.url), "utf8"));
const outline = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/import/${name}`, import.meta.url), "utf8"));

const elk = new ELK();
const layoutBoard = (b: Board, sizes: Record<string, Size>) => layoutWith(b, sizes, elk);

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// The contract, checked on any board: siblings never overlap (two pins may, the user put them there),
// children sit inside their parent, and pinned blocks keep their stored position exactly.
function expectContract(board: Board, boxes: Record<string, Box>) {
  for (const b of board.blocks) expect(boxes[b.id], `box for ${b.id}`).toBeDefined();
  const byParent = new Map<string, Block[]>();
  for (const b of board.blocks) byParent.set(b.parentId ?? "", [...(byParent.get(b.parentId ?? "") ?? []), b]);
  for (const siblings of byParent.values())
    for (const [i, a] of siblings.entries())
      for (const b of siblings.slice(i + 1))
        if (!(a.pinned && b.pinned)) expect(overlaps(boxes[a.id], boxes[b.id]), `${a.id} overlaps ${b.id}`).toBe(false);
  for (const b of board.blocks) {
    if (b.pinned) expect({ x: boxes[b.id].x, y: boxes[b.id].y }, `${b.id} stays pinned`).toEqual(b.position);
    if (!b.parentId) continue;
    const box = boxes[b.id];
    const parent = boxes[b.parentId];
    expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= parent.width && box.y + box.height <= parent.height, `${b.id} inside ${b.parentId}`).toBe(true);
  }
}

const fn = (id: string, parentId?: string, extra: Partial<Block> = {}): Block =>
  ({ id, kind: "function", name: id, parentId, position: { x: 0, y: 0 }, inputs: [], returns: "", errors: [], intent: "", steps: [], ...extra }) as Block;
const mod = (id: string, parentId?: string, extra: Partial<Block> = {}): Block => ({ id, kind: "module", name: id, parentId, position: { x: 0, y: 0 }, ...extra }) as Block;
const board = (blocks: Block[], edges: Board["edges"] = []): Board => ({ version: 2, name: "t", blocks, edges });

describe("layoutBoard", () => {
  it("lays out blocks that all start at the origin without overlap, children inside parents", async () => {
    for (const name of ["nested-modules", "all-kinds", "edges", "module-with-functions"]) {
      const b = fixture(name);
      expectContract(b, await layoutBoard(b, {}));
    }
  });

  it("uses each block's measured size", async () => {
    const b = board([fn("a"), fn("b")]);
    const boxes = await layoutBoard(b, { a: { width: 300, height: 120 } });
    expect(boxes.a).toMatchObject({ width: 300, height: 120 });
    expectContract(b, boxes);
  });

  it("keeps pinned blocks exactly where they are and moves the others clear of them", async () => {
    const b = board(
      [
        mod("m", undefined, { pinned: true, position: { x: 400, y: 300 } }),
        fn("pinned", "m", { pinned: true, position: { x: 20, y: 40 } }),
        fn("free1", "m"),
        fn("free2", "m"),
        fn("top", undefined, { pinned: true, position: { x: 0, y: 0 } }),
        fn("loose1"),
        fn("loose2"),
      ],
      [{ id: "e", source: "free1", target: "free2", kind: "calls" }],
    );
    expectContract(b, await layoutBoard(b, {}));
  });

  it("grows a container to hold its children", async () => {
    const b = board([mod("m"), ...Array.from({ length: 6 }, (_, i) => fn(`f${i}`, "m"))]);
    expectContract(b, await layoutBoard(b, { f0: { width: 500, height: 200 } }));
  });

  it("lays out an imported repository", async () => {
    const b = importBoard({ name: "shop", outline: outline("shop.outline.json") });
    expectContract(b, await layoutBoard(b, {}));
  });

  it("opens a version 1 board with every block exactly where it was", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "chisel-layout-")), "old.chisel.json");
    const at = { m: { x: 40, y: 30 }, f: { x: 20, y: 50 }, g: { x: 300, y: 50 }, s: { x: 700, y: 400 } };
    writeFileSync(path, JSON.stringify({
      version: 1, name: "old", edges: [{ id: "e", source: "f", target: "s", kind: "calls" }],
      blocks: [
        { id: "m", kind: "module", name: "m", position: at.m },
        { id: "f", kind: "function", name: "f", parentId: "m", position: at.f, signature: "(a) -> B", intent: "", steps: [] },
        { id: "g", kind: "function", name: "g", parentId: "m", position: at.g, signature: "", intent: "", steps: [] },
        { id: "s", kind: "service", name: "s", position: at.s, description: "" },
      ],
    }));
    const b = loadBoard(path);
    const boxes = await layoutBoard(b, {});
    for (const [id, pos] of Object.entries(at)) expect({ x: boxes[id].x, y: boxes[id].y }, id).toEqual(pos);
    expectContract(b, boxes);
  });

  it("lays out a 200-block board within a second", async () => {
    const blocks: Block[] = [];
    const edges: Board["edges"] = [];
    for (let m = 0; m < 10; m++) {
      blocks.push(mod(`m${m}`));
      for (let f = 0; f < 19; f++) blocks.push(fn(`f${m}_${f}`, `m${m}`));
    }
    for (let i = 0; i < 150; i++) edges.push({ id: `e${i}`, source: `f${i % 10}_${i % 19}`, target: `f${(i * 7) % 10}_${(i * 3) % 19}`, kind: "calls" });
    const b = board(blocks, edges.filter((e) => e.source !== e.target));
    const start = performance.now();
    const boxes = await layoutBoard(b, {});
    expect(performance.now() - start).toBeLessThan(1000);
    expectContract(b, boxes);
  });
});
