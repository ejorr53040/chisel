import type { Lang } from "./board";

interface LangSpec {
  label: string;
  layout: string;
  verify: string; // how the prompt tells the agent to verify
  checks: string[][]; // the commands the server re-runs itself afterwards
  tools: string[]; // Bash commands the agent may run, as allowedTools patterns
}

export const GENERATORS: Partial<Record<Lang, LangSpec>> = {
  python: {
    label: "Python",
    layout: [
      "- A pyproject.toml package. The package name is the board name in snake_case.",
      "- Each `module` becomes `<package>/<module>.py`; a module nested in a module becomes a subpackage.",
      "- The top-level `main` module becomes `<package>/main.py`.",
      "- class → class; field → typed attribute (a @dataclass when the class is mostly data); interface → typing.Protocol.",
      "- type struct → @dataclass; type enum → enum.Enum; const → module-level `Final`.",
      "- service → a small client class whose connection settings come from environment variables.",
      "- entry main → `<package>/__main__.py`; entry cli → an argparse command; entry http → a route in the board's HTTP library, else `http.server`.",
      "- Library blocks become `[project] dependencies`; pick the most common package for the capability unless an override names one.",
      "- Use type hints everywhere. Python 3.12+.",
    ].join("\n"),
    verify: "`python3 -m compileall -q .`, then `mypy --ignore-missing-imports .`",
    checks: [
      ["python3", "-m", "compileall", "-q", "."],
      ["mypy", "--ignore-missing-imports", "."],
    ],
    // Not bare python3: that would let a hostile board run arbitrary code through the agent.
    tools: ["Bash(python3 -m compileall:*)", "Bash(python3 -m py_compile:*)", "Bash(mypy:*)"],
  },
  rust: {
    label: "Rust",
    layout: [
      "- A Cargo package (edition 2021). The crate name is the board name in snake_case. Cargo.toml must contain an empty `[workspace]` table so an enclosing workspace is ignored.",
      "- A library crate: `src/lib.rs` declares one `pub mod` per top-level module; each `module` becomes `src/<module>.rs`, and a module nested in a module becomes `src/<parent>/<child>.rs`.",
      "- The top-level `main` module becomes `src/app.rs` (`pub mod app`), never `src/main.rs`.",
      "- If the board has an `entry main`, also write `src/main.rs` (the binary) that calls into the library.",
      "- class → `pub struct` + `impl`; field → struct field; interface → `pub trait`; implements → `impl Trait for Struct`.",
      "- inherits → Rust has no inheritance: embed the parent struct as a field and move shared behaviour into a trait both implement. Record this in MAPPING.md.",
      "- type struct → `#[derive(Debug, Clone, PartialEq)] pub struct`; type enum → `pub enum` with the same derives; const → `pub const`.",
      "- service → a client struct whose connection settings come from environment variables.",
      "- entry http → a handler in the board's HTTP library (default axum + tokio); entry cli → clap.",
      "- Library blocks become `[dependencies]` (pick the most common crate unless an override names one). Prefer `Result` over panics; no `unwrap()` outside tests and main.",
    ].join("\n"),
    verify: "`cargo check`",
    checks: [["cargo", "check", "--quiet", "--color", "never"]],
    // cargo check still runs build scripts and proc macros from dependencies; see the README's trust note.
    tools: ["Bash(cargo check:*)", "Bash(cargo add:*)", "Bash(cargo metadata:*)"],
  },
  cpp: {
    label: "C++",
    layout: [
      "- A CMake project (cmake_minimum_required 3.24, C++20). The project name is the board name in snake_case.",
      "- Each `module` becomes `include/<project>/<module>.hpp` (declarations) + `src/<module>.cpp` (definitions) in namespace `<project>::<module>`; a module nested in a module nests both the folders and the namespace.",
      "- The top-level `main` module becomes `include/<project>/app.hpp` + `src/app.cpp` in namespace `<project>::app`.",
      "- Build the modules as a library target `<project>_lib`. If the board has an `entry main`, add an executable whose `int main` lives in `src/app_main.cpp`.",
      "- class → class with its declaration in the header and member definitions in the .cpp; field → private member with accessors only where other blocks need them; interface → abstract class of pure virtual methods with a virtual destructor.",
      "- implements / inherits → public inheritance (override every pure virtual).",
      "- type struct → struct; type enum → `enum class`; const → `inline constexpr` in the header.",
      "- service → a client class whose connection settings come from environment variables (std::getenv).",
      "- Library blocks become `FetchContent_Declare` + `FetchContent_MakeAvailable` dependencies pinned to a release tag (pick a well-known library unless an override names one; for an HTTP server default to cpp-httplib). Nothing may require a system package.",
      "- entry http → a handler in the board's HTTP library; entry cli → argv parsing in main.",
      "- Prefer RAII and value types; no raw new/delete.",
    ].join("\n"),
    verify: "exactly `cmake -S . -B build` then `cmake --build build -j 8` (add `--fresh` to the first if the cache goes stale)",
    checks: [
      ["cmake", "-S", ".", "-B", "build", "--fresh"],
      ["cmake", "--build", "build", "-j", "8"],
    ],
    // Configuring runs the project's CMake code and fetched dependencies; see the README's trust note.
    tools: ["Bash(cmake -S:*)", "Bash(cmake --build:*)"],
  },
};

// hasOwn, not `in`: a language like "__proto__" must not resolve to Object.prototype.
export function generatorFor(lang: string): LangSpec {
  if (!Object.hasOwn(GENERATORS, lang)) throw new Error(`no generator for ${lang} yet`);
  return GENERATORS[lang as Lang]!;
}

export function buildPrompt(lang: Lang, archFile: string, resultFile: string): string {
  const spec = generatorFor(lang);
  return `You are generating a ${spec.label} project from an architecture file.

Read ./${archFile}. It is indentation-based pseudocode:
- Indentation is containment. Every block line ends with \`@id <id>\`.
- Block keywords: module, class, interface, fn (loose signature), field (name: type), const (name: type = value), type <name> struct|enum (with \`members:\`), library <capability> (with optional per-language package lines like \`python: requests\`), service (with \`description:\`), entry main|http|cli <name> (with \`detail:\`, e.g. a route).
- \`intent:\` and \`steps:\` say what a function must do; \`notes:\` on any block is guidance for you.
- \`-> <kind> <target> (@id <id>)\` lines are relationships from the enclosing block to the target. Honour them: inherits/implements → subclassing or implementing the interface; imports → an import; uses → the block depends on the target; calls → the function calls the target; returns → its return type; emits/handles → producing or handling the target as an event. A quoted phrase in place of the kind is a free-form relationship.

Write the project into the current directory and nowhere else.

Layout:
${spec.layout}

Rules:
- Implement every function body as real, working code that fulfils its intent and steps. No stubs, no TODOs, no NotImplementedError.
- Use the block names as identifiers, adjusted only to the language's naming conventions. If a derived package, crate or project name would be empty, start with a digit or clash with a reserved/standard name, prefix it with \`app_\`.
- Put a comment \`@id <id>\` in the language's comment syntax (\`# @id x\`, \`// @id x\`) on the line above each definition that comes from a block.
- Write MAPPING.md: one line per block (id → file and symbol), then a section listing every place the ${spec.label} output had to deviate from the board (lossy translations) and anything you could not implement.

Verify: run ${spec.verify}. If it fails, fix the code and verify again. Stop after 3 fix attempts.

Finally write ./${resultFile} as JSON: {"ok": <true if verification passed>, "errors": [{"blockId": "<the @id the error is about, if any>", "message": "<one-line error>"}]}. "errors" is empty when ok is true.`;
}

export const allowedTools = (lang: Lang) => ["Read", "Write", "Edit", "Glob", "Grep", "Bash(ls:*)", ...generatorFor(lang).tools];
