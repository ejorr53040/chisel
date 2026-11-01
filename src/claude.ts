import { spawn } from "node:child_process";
import type { Runner } from "./generate";
import { allowedTools } from "./prompts";

// The real agent: Claude Code in print mode, auto-accepting edits in the run folder and allowed only the
// language's verifier commands. That limits but does not sandbox it: the verifier itself runs project code.
export const claudeRunner: Runner = ({ prompt, cwd, lang, onProgress, signal }) =>
  new Promise((resolve) => {
    // The prompt goes on stdin; a big board would overflow the argv size limit.
    const child = spawn(
      "claude",
      ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", ...allowedTools(lang)],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    child.stdin.end(prompt);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let output = "";
    let pending = "";
    const handle = (line: string) => {
      if (!line.trim()) return;
      try {
        report(JSON.parse(line));
      } catch {
        output += line + "\n";
      }
    };
    const report = (event: { type?: string; result?: string; message?: { content?: ContentItem[] } }) => {
      if (event.type === "result") output += `${event.result ?? ""}\n`;
      if (event.type !== "assistant") return;
      for (const item of event.message?.content ?? []) {
        if (item.type === "text" && item.text?.trim()) onProgress(firstLine(item.text));
        if (item.type === "tool_use") onProgress(firstLine(`${item.name} ${toolTarget(item.input)}`));
      }
    };

    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      lines.forEach(handle);
    });
    child.stderr.on("data", (chunk: string) => (output += chunk));
    child.on("error", (e) => resolve({ exitCode: 127, output: `could not start claude: ${e.message}` }));
    child.on("close", (code) => {
      signal.removeEventListener("abort", stop);
      handle(pending);
      resolve({ exitCode: code ?? 1, output });
    });
  });

interface ContentItem {
  type: string;
  text?: string;
  name?: string;
  input?: { file_path?: string; command?: string };
}

const toolTarget = (input: ContentItem["input"]) => input?.file_path ?? input?.command ?? "";
const firstLine = (text: string) => text.trim().split("\n")[0].slice(0, 200);
