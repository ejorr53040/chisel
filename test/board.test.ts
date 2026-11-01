import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { duplicate, type Board } from "../src/board";
import { validate } from "../src/store";

const fixture = (name: string): Board =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.chisel.json`, import.meta.url), "utf8"));

describe("duplicate", () => {
  it("copies the chosen blocks with everything inside them, under fresh ids", () => {
    const board = fixture("all-kinds");
    const { board: after, copies } = duplicate(board, ["c_cart"]);

    // Cart and its three members are copied; nothing else.
    expect(copies).toHaveLength(4);
    expect(after.blocks).toHaveLength(board.blocks.length + 4);
    const oldIds = new Set(board.blocks.map((b) => b.id));
    for (const id of copies) expect(oldIds.has(id)).toBe(false);
    expect(new Set(after.blocks.map((b) => b.id)).size).toBe(after.blocks.length);

    const cart = after.blocks.find((b) => b.id === copies[0])!;
    expect(cart).toMatchObject({ kind: "class", name: "Cart", parentId: "m_shop" });
    expect(cart.position).toEqual({ x: 10 + 24, y: 40 + 24 });
    const members = after.blocks.filter((b) => b.parentId === cart.id).map((b) => b.name).sort();
    expect(members).toEqual(["items", "owner", "total"]);
    expect(() => validate(after)).not.toThrow();
  });

  it("copies edges between copied blocks, remapped to the copies, and leaves other edges alone", () => {
    const board = fixture("edges");
    const { board: after, copies } = duplicate(board, ["f_main", "f_login"]);
    const [main, login] = copies;
    const newEdges = after.edges.slice(board.edges.length);
    expect(newEdges).toEqual([expect.objectContaining({ source: main, target: login, kind: "calls" })]);
    expect(board.edges.map((e) => e.id)).not.toContain(newEdges[0].id);
    expect(after.edges.slice(0, board.edges.length)).toEqual(board.edges);
  });

  it("does not copy a chosen block twice when its container is also chosen", () => {
    const { copies } = duplicate(fixture("all-kinds"), ["c_cart", "x_items"]);
    expect(copies).toHaveLength(4);
  });
});
