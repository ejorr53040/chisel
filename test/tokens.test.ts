import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WCAG 2 contrast over the brand tokens: text pairs need 4.5:1, lines and fills 3:1, in both themes.
const css = readFileSync(new URL("../src/ui/brand/tokens.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]));
}

const dark = block(":root");
const light = { ...dark, ...block(':root[data-theme="light"]') };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const TEXT: [string, string][] = [
  ["--text", "--bg"], ["--text", "--surface"], ["--text", "--inset"],
  ["--dim", "--bg"], ["--dim", "--surface"],
  ["--accent-text", "--bg"], ["--accent-text", "--surface"],
  ["--fault", "--surface"], ["--warn", "--surface"], ["--ok", "--surface"],
  ["--on-fault", "--fault"],
];
const LINES: [string, string][] = [
  ["--accent", "--bg"], ["--border-control", "--surface"], ["--slate", "--bg"],
  ["--data", "--bg"], ["--control", "--bg"], ["--event", "--bg"], ["--external", "--bg"], ["--fault", "--bg"],
];

describe.each([["dark", dark], ["light", light]] as const)("%s theme", (_, t) => {
  it.each(TEXT)("text %s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(LINES)("line %s on %s is at least 3:1", (fg, bg) => {
    expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });
});

it("the system-light block and the explicit light block define the same values", () => {
  expect(block(':root:not([data-theme="dark"])')).toEqual(block(':root[data-theme="light"]'));
});
