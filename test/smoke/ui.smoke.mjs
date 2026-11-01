// UI smoke check (not part of `npm test`): run `npm run dev -- --port 5317` first, then `npm run smoke:ui`.
import { chromium } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const url = process.env.CHISEL_URL ?? "http://localhost:5317/";
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

  const path = join(mkdtempSync(join(tmpdir(), "chisel-smoke-")), "smoke.chisel.json");
  await page.getByLabel("Board file path").fill(path);
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("status").filter({ hasText: "saved" }).waitFor();
  assert.ok(existsSync(path.replace(".chisel.json", ".arch.md")));
  assert.equal(readFileSync(path.replace(".chisel.json", ".arch.md"), "utf8").trim(), arch.trim());

  // Opening and re-saving a board keeps what the UI can't show yet (edges arrive in #4).
  const withEdges = join(mkdtempSync(join(tmpdir(), "chisel-smoke-")), "edges.chisel.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  original.edges = [{ id: "e_1", source: original.blocks[0].id, target: original.blocks[1].id, kind: "uses" }];
  writeFileSync(withEdges, JSON.stringify(original));
  await page.getByLabel("Board file path").fill(withEdges);
  await page.getByRole("button", { name: "Open", exact: true }).click();
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

  // #9: Cancel shows only while a run is going and stops it; "Open folder" asks the server for that run's folder.
  {
    let release;
    const cancelled = new Promise((resolve) => (release = resolve));
    await page.route("**/api/generate/cancel", (route) => (release(), route.fulfill({ json: { cancelled: true } })));
    await page.route("**/api/generate?**", async (route) => {
      await cancelled;
      const done = { ok: false, cancelled: true, runDir: "/tmp/run-9", files: [], errors: [{ message: "run cancelled" }] };
      route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify(done)}\n\n` });
    });
    let opened;
    await page.route("**/api/open", (route) => ((opened = route.request().postDataJSON()), route.fulfill({ json: { opened: "/tmp/run-9" } })));
    assert.equal(await page.getByRole("button", { name: "Cancel" }).count(), 0);
    await page.getByRole("button", { name: "Generate" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await runPanel.getByText("cancelled", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Cancel" }).count(), 0);
    await Promise.all([page.waitForRequest("**/api/open"), runPanel.getByRole("button", { name: "Open folder" }).click()]);
    assert.deepEqual(opened, { runDir: "/tmp/run-9" });
    await page.unrouteAll();
  }

  // Opt-in: Generate through the UI with the real agent (CHISEL_AGENT_SMOKE=1).
  if (process.env.CHISEL_AGENT_SMOKE) {
    await page.getByLabel("Board file path").fill(path);
    await page.getByRole("button", { name: "Open", exact: true }).click();
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

  // #10 on a fresh board: add by key, undo/redo, duplicate with fresh ids, the shortcut list.
  {
    const p3 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    p3.on("pageerror", (e) => errors.push(e.message));
    await p3.goto(url);
    const fns = async () => ((await p3.getByLabel("Architecture file preview").textContent()).match(/^ {2}fn function\(\) {2}@id (\w+)/gm) ?? []);
    const settle = () => p3.waitForTimeout(450); // history snapshots once edits pause for 300ms
    await p3.locator(".canvas").click({ position: { x: 5, y: 5 } });
    await settle();
    await p3.keyboard.press("f");
    await settle();
    assert.equal((await fns()).length, 1);
    await p3.keyboard.press("Control+z");
    await settle();
    assert.equal((await fns()).length, 0, "undo removes the added block");
    await p3.keyboard.press("Control+Shift+z");
    await settle();
    assert.equal((await fns()).length, 1, "redo brings it back");
    await p3.locator(".react-flow__node-function").click();
    await p3.keyboard.press("Control+d");
    await settle();
    const ids = await fns();
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    // Undo, then a new edit, then undo again lands on the state before that edit (not further back).
    await p3.keyboard.press("c");
    await settle();
    await p3.keyboard.press("Control+z");
    await settle();
    await p3.keyboard.press("m");
    await settle();
    await p3.keyboard.press("Control+z");
    await settle();
    const afterUndo = await p3.getByLabel("Architecture file preview").textContent();
    assert.equal((await fns()).length, 2, afterUndo);
    assert.doesNotMatch(afterUndo, /class Class|module module/, afterUndo);
    // Keys don't reach the board while the shortcut list is open.
    await p3.keyboard.press("?");
    await p3.keyboard.press("f");
    await p3.keyboard.press("Escape");
    await settle();
    assert.equal((await fns()).length, 2, "a key pressed behind the dialog added a block");
    p3.once("dialog", (d) => d.accept());
    await p3.getByRole("button", { name: "New" }).click();
    assert.equal((await fns()).length, 0, "New clears the board");
    await p3.keyboard.press("?");
    const dialog = p3.getByRole("dialog", { name: "Keyboard shortcuts" });
    await dialog.getByText("Duplicate the selection").waitFor();
    await p3.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    await p3.close();
  }

  // Dragging a block out of its container onto bare canvas un-nests it.
  {
    const p4 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    p4.on("pageerror", (e) => errors.push(e.message));
    await p4.goto(url);
    const dsl = () => p4.getByLabel("Architecture file preview").textContent();
    // #20: with nothing selected, the Board panel switches Generate to updating an existing repository.
    await p4.getByLabel("Generate into").selectOption("existing repository");
    await p4.getByLabel("Check commands, one per line").fill("npx tsc --noEmit\nnpx vitest run");
    assert.equal(await p4.getByLabel("Target language").count(), 0);
    await p4.getByRole("button", { name: "Update repo" }).waitFor();
    await p4.getByLabel("Generate into").selectOption("new project");
    await p4.getByRole("button", { name: "Generate", exact: true }).waitFor();
    await p4.getByRole("button", { name: "+ Module" }).click();
    await p4.getByRole("button", { name: "+ Function" }).click();
    const fn = await p4.locator(".react-flow__node-function").boundingBox();
    await p4.mouse.move(fn.x + 20, fn.y + 8);
    await p4.mouse.down();
    await p4.mouse.move(fn.x + 40, fn.y + 30, { steps: 6 });
    await p4.mouse.up();
    assert.match(await dsl(), /^module module {2}@id m_\w+\n {2}fn function/m, "nested first");
    const inside = await p4.locator(".react-flow__node-function").boundingBox();
    const canvas = await p4.locator(".canvas").boundingBox();
    await p4.mouse.move(inside.x + 20, inside.y + 8);
    await p4.mouse.down();
    await p4.mouse.move(canvas.x + 60, canvas.y + 60, { steps: 12 });
    await p4.mouse.up();
    assert.match(await dsl(), /^module main {2}@id _main\n {2}fn function/m, await dsl());
    await p4.close();
  }

  await page.screenshot({ path: process.env.SHOT ?? join(tmpdir(), "chisel-smoke.png") });
  assert.deepEqual(errors, []);
  console.log("ui smoke: ok");
} finally {
  await browser.close();
}
