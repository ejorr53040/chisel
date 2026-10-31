import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadBoard, saveBoard, validate } from "./src/store";
import { serialize } from "./src/serialize";
import { claudeRunner, generate } from "./src/generate";
import { LANGS } from "./src/prompts";
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

// A JSON content type forces a CORS preflight, so other sites can't make the browser write files or start agents.
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

// The local server: board files and generation runs for the UI.
function api(): Plugin {
  return {
    name: "scaffold-api",
    configureServer(server) {
      server.middlewares.use("/api/board", async (req, res) => {
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
      server.middlewares.use("/api/generate", async (req, res) => {
        let path: string, board, lang: Lang;
        try {
          path = boardPath(req);
          const body = (await readJson(req)) as { board: unknown; lang: Lang };
          if (!(body.lang in LANGS)) throw new Error(`no generator for ${body.lang} yet`);
          lang = body.lang;
          board = validate(body.board);
          saveBoard(path, board);
        } catch (e) {
          return send(res, 400, { error: (e as Error).message });
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        try {
          const result = await generate({
            arch: serialize(board, lang).arch,
            lang,
            outDir: join(dirname(path), "out"),
            runner: claudeRunner,
            onProgress: (line) => emit("progress", line),
          });
          emit("done", result);
        } catch (e) {
          emit("done", { ok: false, runDir: "", files: [], errors: [{ message: (e as Error).message }] });
        }
        res.end();
      });
    },
  };
}

export default defineConfig({ plugins: [react(), api()] });
