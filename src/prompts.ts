import type { Lang } from "./board";

interface LangSpec {
  label: string;
  layout: string;
  verify: string;
  tools: string[]; // Bash commands the agent may run, as allowedTools patterns
}

export const LANGS: Record<"python", LangSpec> = {
  python: {
    label: "Python",
    layout: [
      "- A pyproject.toml package. The package name is the board name in snake_case.",
      "- Each `module` becomes `<package>/<module>.py`; a module nested in a module becomes a subpackage.",
      "- Blocks outside any module go in `<package>/main.py`.",
      "- Library blocks become `[project] dependencies`; pick the most common package for the capability unless an override names one.",
      "- Use type hints everywhere. Python 3.12+.",
    ].join("\n"),
    verify: "`python3 -m py_compile` on every .py file, then `mypy --ignore-missing-imports <package>`",
    tools: ["Bash(python3:*)", "Bash(mypy:*)"],
  },
};

export function buildPrompt(lang: Lang, archFile: string, resultFile: string): string {
  const spec = LANGS[lang as keyof typeof LANGS];
  if (!spec) throw new Error(`no generator for ${lang} yet`);
  return `You are generating a ${spec.label} project from an architecture file.

Read ./${archFile}. It is indentation-based pseudocode: indentation is containment, every block line ends with \`@id <id>\`, functions carry a loose signature, an \`intent:\` and optional \`steps:\`.

Write the project into the current directory and nowhere else.

Layout:
${spec.layout}

Rules:
- Implement every function body as real, working code that fulfils its intent and steps. No stubs, no TODOs, no NotImplementedError.
- Use the block names as identifiers, adjusted only to the language's naming conventions.
- Put a comment \`# @id <id>\` (or the language's comment syntax) on the line above each definition that comes from a block.
- Write MAPPING.md: one line per block (id → file and symbol), then a section listing every place the ${spec.label} output had to deviate from the board (lossy translations) and anything you could not implement.

Verify: run ${spec.verify}. If it fails, fix the code and verify again. Stop after 3 fix attempts.

Finally write ./${resultFile} as JSON: {"ok": <true if verification passed>, "errors": [{"blockId": "<the @id the error is about, if any>", "message": "<one-line error>"}]}. "errors" is empty when ok is true.`;
}

export const allowedTools = (lang: Lang) => ["Read", "Write", "Edit", "Glob", "Grep", "Bash(ls:*)", ...(LANGS[lang as keyof typeof LANGS]?.tools ?? [])];
