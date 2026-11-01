# Scaffold

A visual architecture board: place blocks (modules, classes, functions, libraries) freely, link them with any edge, and an agent turns the resulting pseudocode architecture file into verified Rust, C++, or Python.

Spec: see issue #1.

## Develop

```sh
npm install
npm run dev        # app + local API on http://localhost:5173
npm test           # serializer + board-file tests
npm run smoke:ui   # browser smoke check; needs `npm run dev -- --port 5317` running and /usr/bin/chromium (or CHROMIUM=…)
SCAFFOLD_AGENT_SMOKE=1 npm test       # also runs the real agent per language (slow, uses your Claude account)
SCAFFOLD_AGENT_SMOKE=1 SCAFFOLD_AGENT_LANGS=rust npm test   # just one language
SCAFFOLD_AGENT_SMOKE=1 npm run smoke:ui  # also generates through the UI
```

Generate needs [Claude Code](https://claude.com/claude-code) (`claude`) on PATH, plus the target's toolchain: Python needs `python3` and `mypy` (`uv tool install mypy`); Rust needs `cargo` (and network access for crates); C++ needs `cmake` ≥ 3.24, a C++20 compiler and network access for FetchContent. Runs land in `out/<lang>/<timestamp>/` next to the board file; the five newest runs per language are kept.

Boards are saved as `<name>.scaffold.json` (source of truth) plus a derived `<name>.arch.md`. The architecture file grammar is in [docs/adr/0001](docs/adr/0001-architecture-file-grammar.md).

### Changing an existing codebase, including Scaffold itself

With nothing selected, the inspector's **Board** panel sets where Generate goes. Choose **existing repository**, give the repo folder (relative to the board file) and its check commands, and Generate becomes **Update repo**: the agent updates that repository in place on a new `scaffold/<timestamp>` branch, and the repo's own checks decide whether the run is verified. The repository must have no uncommitted changes other than the board and its `.arch.md`.

Scaffold describes itself in [`scaffold.scaffold.json`](scaffold.scaffold.json), which targets this repo with `npx tsc --noEmit` and `npx vitest run`. To change Scaffold through Scaffold:

```sh
npm start          # builds the UI and serves it without file watching, so the run survives its own edits
```

Open `scaffold.scaffold.json`, edit blocks, press **Update repo**, review the branch it made (`git diff main`), then restart `npm start` to run the new version.

### Trust

Generate runs Claude Code on your machine with the board's text as instructions. The agent can only edit files in the run folder and run the target's verifier commands, and the API refuses requests from any page but this app's own. But verifiers execute project code (build scripts, mypy plugins), so only generate boards you trust, as you would only run code you trust.
