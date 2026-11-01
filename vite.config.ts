import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadBoard, saveBoard, validate } from "./src/store";

// The local server: board file load/save for the UI.
function api(): Plugin {
  return {
    name: "scaffold-api",
    configureServer(server) {
      server.middlewares.use("/api/board", (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        const raw = new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "";
        const path = resolve(raw.replace(/^~(?=\/)/, homedir()));
        if (!path.endsWith(".scaffold.json")) return send(400, { error: "board files must end in .scaffold.json" });
        try {
          if (req.method === "GET") return send(200, loadBoard(path));
          // A JSON content type forces a CORS preflight, so other sites can't make the browser write files.
          if (req.method === "POST" && req.headers["content-type"] === "application/json") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
              try {
                saveBoard(path, validate(JSON.parse(body)));
                send(200, { path });
              } catch (e) {
                send(400, { error: (e as Error).message });
              }
            });
            return;
          }
          send(405, { error: "use GET or POST with application/json" });
        } catch (e) {
          send(400, { error: (e as Error).message });
        }
      });
    },
  };
}

export default defineConfig({ plugins: [react(), api()] });
