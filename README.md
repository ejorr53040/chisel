# Scaffold

A visual architecture board: place blocks (modules, classes, functions, libraries) freely, link them with any edge, and an agent turns the resulting pseudocode architecture file into verified Rust, C++, or Python.

Spec: see issue #1.

## Develop

```sh
npm install
npm run dev        # app + local API on http://localhost:5173
npm test           # serializer + board-file tests
npm run smoke:ui   # browser smoke check; needs `npm run dev -- --port 5317` running and /usr/bin/chromium (or CHROMIUM=…)
```

Boards are saved as `<name>.scaffold.json` (source of truth) plus a derived `<name>.arch.md`. The architecture file grammar is in [docs/adr/0001](docs/adr/0001-architecture-file-grammar.md).
