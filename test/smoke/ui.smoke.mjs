// UI smoke check (not part of `npm test`): run `npm run dev -- --port 5317` first, then `npm run smoke:ui`.
import { chromium } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const url = process.env.SCAFFOLD_URL ?? "http://localhost:5317/";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(url);
  const preview = page.getByLabel("Architecture file preview");

  await page.getByRole("button", { name: "+ Module" }).click();
  await page.getByLabel("Name", { exact: true }).fill("auth");
  await page.getByRole("button", { name: "+ Function" }).click();
  await page.getByLabel("Name", { exact: true }).fill("login");
  await page.getByLabel("Intent").fill("Checks the password.");

  // Nudge the function so drag-stop runs; it lands inside the module and gets nested.
  const fn = await page.locator(".react-flow__node-function").first().boundingBox();
  await page.mouse.move(fn.x + 20, fn.y + 10);
  await page.mouse.down();
  await page.mouse.move(fn.x + 60, fn.y + 60, { steps: 8 });
  await page.mouse.up();

  // A module dropped onto another module nests too.
  await page.getByRole("button", { name: "+ Module" }).click();
  await page.getByLabel("Name", { exact: true }).fill("tokens");
  const sub = await page.locator(".react-flow__node-module").last().boundingBox();
  await page.mouse.move(sub.x + 40, sub.y + 12);
  await page.mouse.down();
  await page.mouse.move(sub.x - 60, sub.y + 40, { steps: 8 });
  await page.mouse.up();

  const arch = await preview.textContent();
  assert.match(arch, /^module auth {2}@id m_\w+\n {2}fn login\(\) {2}@id f_\w+\n {4}intent: Checks the password\.\n {2}module tokens {2}@id m_\w+$/m, arch);

  const path = join(mkdtempSync(join(tmpdir(), "scaffold-smoke-")), "smoke.scaffold.json");
  await page.getByLabel("Board file path").fill(path);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("status").filter({ hasText: "saved" }).waitFor();
  assert.ok(existsSync(path.replace(".scaffold.json", ".arch.md")));
  assert.equal(readFileSync(path.replace(".scaffold.json", ".arch.md"), "utf8").trim(), arch.trim());

  // Opening and re-saving a board keeps what the UI can't show yet (edges arrive in #4).
  const withEdges = join(mkdtempSync(join(tmpdir(), "scaffold-smoke-")), "edges.scaffold.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  original.edges = [{ id: "e_1", source: original.blocks[0].id, target: original.blocks[1].id, kind: "uses" }];
  writeFileSync(withEdges, JSON.stringify(original));
  await page.getByLabel("Board file path").fill(withEdges);
  await page.getByRole("button", { name: "Open" }).click();
  await page.getByRole("status").filter({ hasText: "opened" }).waitFor();
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("status").filter({ hasText: "saved" }).waitFor();
  assert.deepEqual(JSON.parse(readFileSync(withEdges, "utf8")).edges, original.edges);

  // #3: every kind is in the palette; a field dropped on a class becomes a member; library overrides reach the DSL.
  for (const label of ["Module", "Class", "Interface", "Function", "Field", "Constant", "Type / Enum", "Library", "External service", "Entry point"])
    assert.equal(await page.getByRole("button", { name: `+ ${label}` }).count(), 1, label);
  await page.getByRole("button", { name: "+ Class" }).click();
  await page.getByRole("button", { name: "+ Field" }).click();
  const field = await page.locator(".react-flow__node-field").boundingBox();
  await page.mouse.move(field.x + 10, field.y + 8);
  await page.mouse.down();
  await page.mouse.move(field.x + 30, field.y + 20, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "+ Library" }).click();
  await page.getByLabel("Name", { exact: true }).fill("HTTP client");
  await page.getByLabel("Python package (optional)").fill("requests");
  const catalog = await preview.textContent();
  assert.match(catalog, /^( *)class Class {2}@id c_\w+\n\1 {2}field field {2}@id f_\w+$/m, catalog);
  assert.match(catalog, /^ {2}library HTTP client {2}@id l_\w+\n {4}python: requests$/m, catalog);

  // Opt-in: Generate through the UI with the real agent (SCAFFOLD_AGENT_SMOKE=1).
  if (process.env.SCAFFOLD_AGENT_SMOKE) {
    await page.getByLabel("Board file path").fill(path);
    await page.getByRole("button", { name: "Open" }).click();
    await page.getByRole("status").filter({ hasText: "opened" }).waitFor();
    await page.getByRole("button", { name: "Generate" }).click();
    const run = page.getByRole("region", { name: "Generation run" });
    await run.getByText("running").waitFor();
    await run.locator(".chip--ok, .chip--err").filter({ hasText: /verified|failed/ }).waitFor({ timeout: 600_000 });
    assert.equal(await run.locator(".chip--ok").count(), 1, await run.textContent());
    assert.ok((await run.getByLabel("Progress").textContent()).length > 0, "no progress was streamed");
  }

  await page.screenshot({ path: process.env.SHOT ?? join(tmpdir(), "scaffold-smoke.png") });
  assert.deepEqual(errors, []);
  console.log("ui smoke: ok");
} finally {
  await browser.close();
}
