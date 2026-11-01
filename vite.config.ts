import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { archPath, loadBoard, saveBoard, validate } from "./src/store";
import { serialize } from "./src/serialize";
import { generate, isRunDir, update } from "./src/generate";
import { spawn } from "node:child_process";
import { claudeRunner } from "./src/claude";
import { generatorFor } from "./src/prompts";
import { failedResult } from "./src/run";
import type { Lang } from "./src/board";

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

function boardPath(req: IncomingMessage): string {
  const raw = new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "";
  const path = resolve(raw.replace(/^~(?=\/)/, homedir()));
  if (!path.endsWith(".scaffold.json")) throw new Error("board files must end in .scaffold.json");
  return path;
}

// Vite's CORS default trusts every localhost origin, so any local page could otherwise write files and start
// agents here. Only this app's own pages may call the API.
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined ? req.headers["sec-fetch-site"] !== "cross-site" : origin === `http://${req.headers.host}`;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST" || req.headers["content-type"] !== "application/json")
    return Promise.reject(new Error("use POST with application/json"));
  return new Promise((ok, fail) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        ok(JSON.parse(body));
      } catch (e) {
        fail(e);
      }
    });
  });
}

// The local API: board files and generation runs for the UI. Mounted on the dev server and on the
// preview server (`npm start`), which doesn't watch files, so Scaffold can update its own code mid-run.
function api(): Plugin {
  return {
    name: "scaffold-api",
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}

function mount(middlewares: Connect.Server) {
  middlewares.use("/api", (req, res, next) => (sameOrigin(req) ? next() : send(res, 403, { error: "cross-origin request refused" })));

  middlewares.use("/api/board", async (req, res) => {
    try {
      const path = boardPath(req);
      if (req.method === "GET") return send(res, 200, loadBoard(path));
      saveBoard(path, validate(await readJson(req)));
      send(res, 200, { path });
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });

  // Saves the board, then streams the run as server-sent events: `progress` lines, then one `done` result.
  // One run at a time; Cancel or closing the page stops its agent.
  let current: AbortController | null = null;
  middlewares.use("/api/generate/cancel", (req, res) => {
    if (req.method !== "POST") return send(res, 405, { error: "use POST" });
    current?.abort();
    send(res, 200, { cancelled: current !== null });
  });

  // Opens a finished run's folder in the desktop's file manager.
  middlewares.use("/api/open", async (req, res) => {
    try {
      const { runDir } = (await readJson(req)) as { runDir: string };
      if (typeof runDir !== "string" || !isRunDir(resolve(runDir))) throw new Error("not a scaffold run folder");
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawn(opener, [resolve(runDir)], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
      send(res, 200, { opened: runDir });
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });

  middlewares.use("/api/generate", async (req, res) => {
    if (current) return send(res, 409, { error: "a generation is already running" });
    let path: string, board, lang: Lang;
    try {
      path = boardPath(req);
      const body = (await readJson(req)) as { board: unknown; lang: string };
      board = validate(body.board);
      if (!board.target) generatorFor(body.lang);
      lang = body.lang as Lang;
      saveBoard(path, board);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
    const controller = new AbortController();
    current = controller;
    res.on("close", () => controller.abort());
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const onProgress = (line: string) => emit("progress", line);
      const target = board.target;
      let result;
      if (target) {
        // Update the board's repository in place; the board and its .arch.md may be the only dirty files.
        const repo = resolve(dirname(path), target.repo);
        const boardFiles = [path, archPath(path)].map((f) => relative(repo, f));
        result = await update({ arch: serialize(board).arch, repo, checks: target.checks, runner: claudeRunner, boardFiles, onProgress, signal: controller.signal });
      } else {
        result = await generate({
          arch: serialize(board, lang).arch,
          lang,
          outDir: join(dirname(path), "out"),
          runner: claudeRunner,
          onProgress,
          signal: controller.signal,
        });
      }
      emit("done", result);
    } catch (e) {
      emit("done", failedResult((e as Error).message));
    } finally {
      current = null;
    }
    res.end();
  });
}

export default defineConfig({ plugins: [react(), api()] });
