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

Generate needs [Claude Code](https://claude.com/claude-code) (`claude`) on PATH, plus the target's toolchain: Python needs `python3` and `mypy` (`uv tool install mypy`); Rust needs `cargo` (and network access for crates). Runs land in `out/<lang>/<timestamp>/` next to the board file; the five newest runs per language are kept.

Boards are saved as `<name>.scaffold.json` (source of truth) plus a derived `<name>.arch.md`. The architecture file grammar is in [docs/adr/0001](docs/adr/0001-architecture-file-grammar.md).

### Trust

Generate runs Claude Code on your machine with the board's text as instructions. The agent can only edit files in the run folder and run the target's verifier commands, and the API refuses requests from any page but this app's own. But verifiers execute project code (build scripts, mypy plugins), so only generate boards you trust, as you would only run code you trust.
