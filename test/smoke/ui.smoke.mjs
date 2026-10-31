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
  assert.deepEqual(await page.getByLabel("Target language").locator("option").allTextContents(), ["Python", "Rust", "C++"]);

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

  // #6: a failed run's errors badge their blocks, and clicking an error selects its block. The run is replayed.
  const libraryId = /library HTTP client {2}@id (\w+)/.exec(await preview.textContent())[1];
  const done = { ok: false, runDir: "/tmp/run", files: [], errors: [{ blockId: libraryId, message: "lib.py:3: error: bad import" }, { message: "pyproject.toml is invalid" }] };
  await page.route("**/api/generate**", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: progress\ndata: "checking"\n\nevent: done\ndata: ${JSON.stringify(done)}\n\n` }),
  );
  await page.getByRole("button", { name: "Generate" }).click();
  const runPanel = page.getByRole("region", { name: "Generation run" });
  await runPanel.getByText("failed").waitFor();
  await page.locator(".react-flow__node-library").getByRole("img", { name: "1 error in the last run" }).waitFor();
  assert.equal(await page.locator(".error-badge").count(), 1);
  await runPanel.getByRole("button", { name: "HTTP client" }).click();
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "HTTP client");
  await page.unroute("**/api/generate**");
  // The next successful run clears the badges.
  await page.route("**/api/generate**", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify({ ok: true, runDir: "/tmp/run", files: [], errors: [] })}\n\n` }),
  );
  await page.getByRole("button", { name: "Generate" }).click();
  await runPanel.getByText("verified").waitFor();
  assert.equal(await page.locator(".error-badge").count(), 0);
  await page.unroute("**/api/generate**");

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

  // #4 on a fresh board: drag between handles to connect, retype the edge, delete a block and its edges go.
  {
    const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    p2.on("pageerror", (e) => errors.push(e.message));
    await p2.goto(url);
    const dsl = () => p2.getByLabel("Architecture file preview").textContent();
    await p2.getByRole("button", { name: "+ Class" }).click();
    await p2.getByRole("button", { name: "+ Library" }).click();
    await p2.getByLabel("Name", { exact: true }).fill("HTTP client");
    const lib = await p2.locator(".react-flow__node-library").boundingBox();
    await p2.mouse.move(lib.x + 30, lib.y + 10);
    await p2.mouse.down();
    await p2.mouse.move(lib.x + 30, lib.y + 300, { steps: 8 });
    await p2.mouse.up();
    // Start on the class's left handle: the edge must still point from the block the drag began on.
    const from = await p2.locator(".react-flow__node-class .react-flow__handle-left").boundingBox();
    const to = await p2.locator(".react-flow__node-library .react-flow__handle-left").boundingBox();
    await p2.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await p2.mouse.down();
    await p2.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await p2.mouse.up();
    assert.match(await dsl(), /^ {4}-> uses HTTP client \(@id l_\w+\) {2}@edge e_\w+$/m, await dsl());
    // #7: an inherits edge is flagged for Rust only, and the flag follows the language picker.
    await p2.getByLabel("Relationship").selectOption("inherits");
    await p2.getByLabel("Target language").selectOption("rust");
    await p2.getByRole("list", { name: "Warnings for Rust" }).getByText(/Rust has no inheritance/).waitFor();
    assert.equal(await p2.locator(".react-flow__node-class .warn-badge").count(), 1);
    assert.match(await p2.locator(".react-flow__edge-text").first().textContent(), /^⚠/);
    await p2.getByLabel("Target language").selectOption("python");
    assert.equal(await p2.locator(".warn-badge").count(), 0);
    await p2.getByLabel("Relationship").selectOption("other");
    await p2.getByLabel("Label", { exact: true }).fill("serves pages for");
    assert.match(await dsl(), /-> "serves pages for" HTTP client \(@id l_\w+\)/);
    await p2.locator(".react-flow__node-library").click();
    await p2.keyboard.press("Delete");
    assert.doesNotMatch(await dsl(), /->|HTTP client/);
    await p2.close();
  }

  await page.screenshot({ path: process.env.SHOT ?? join(tmpdir(), "scaffold-smoke.png") });
  assert.deepEqual(errors, []);
  console.log("ui smoke: ok");
} finally {
  await browser.close();
}
