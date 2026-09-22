# foundry-local-api

A FoundryVTT module that exposes a local REST API and an MCP server for
controlling a running Foundry world, plus optional integrations for
companion systems/modules (e.g. dnd5e).

## Why two processes

FoundryVTT module code executes inside the client's sandboxed
browser/Electron renderer. It has no Node.js access, so it cannot itself
host an HTTP server. This project is therefore split into two cooperating
processes that live side by side in this one repo:

- **`server/`** is a standalone Node.js process you run alongside Foundry
  (not loaded by it). It hosts the Express REST API, an MCP server that
  shares the same backend logic, and a WebSocket gateway.
- **`module/`** is the actual Foundry module — the client-side JavaScript
  Foundry loads per `module.json`. Its job is to open a WebSocket
  connection out to the local server, receive `{command, payload}`
  messages, execute the corresponding Foundry API call in-client
  (`game.*`, `canvas.*`, Document CRUD, etc.), and send the result back.

Every REST/MCP call therefore makes the same round trip: an external client
hits the server, the server sends a command over the WebSocket bridge to
the connected Foundry client, Foundry executes it, and the result flows
back through the same path to the HTTP/MCP response. A `shared/` package
holds the protocol types (message envelope, command names, endpoint
descriptors) referenced by both processes so they can't drift apart.

See [PLAN.md](./PLAN.md) for the full phase-by-phase build plan (36 phases
across two parts: the core API surface, then an optional integration
framework for companion systems/modules like dnd5e).

## Workspace layout

npm workspaces, ESM throughout:

```
.
├── server/   @foundry-local-api/server  — standalone Node.js process (Express + WS gateway + MCP)
├── module/   @foundry-local-api/module  — Foundry client-side esmodule (WS bridge client)
├── shared/   @foundry-local-api/shared  — protocol types shared by server and module
├── tsconfig.base.json                   — shared strict TS config, extended by each workspace
├── tsconfig.json                        — root project-references file (editor/whole-repo builds)
├── eslint.config.js                     — ESLint v9 flat config (typescript-eslint + Prettier)
└── .prettierrc                          — formatting rules
```

Each workspace currently only has a placeholder `src/index.ts`; real
functionality lands starting Phase 1.

## TypeScript setup

Every workspace has its own `tsconfig.json` extending the root
`tsconfig.base.json` (strict mode, ES2022, project references, Node-style
ESM resolution for `server`/`shared`; `module` overrides `module`/
`moduleResolution` to `ESNext`/`Bundler` and adds the `DOM` lib since it
runs in the browser, not Node). The root `tsconfig.json` is a references-only
file (`"files": []`) that wires the three workspace projects together for
editor tooling and `tsc -b`; the actual `build`/`typecheck` npm scripts run
per-workspace via `--workspaces --if-present`, which is sufficient on its
own and doesn't require the root file — it's kept for editor convenience
and future whole-repo builds.

## Getting started

```sh
npm install          # installs root + all three workspaces
npm run build         # tsc -b in each workspace with a build script
npm run typecheck      # tsc --noEmit in each workspace
npm run lint           # ESLint across the repo
npm run format          # Prettier --write across the repo
```

Requires Node.js >= 20.
