# CLAUDE.md

## Project Overview

OpenCode is an open-source, AI-powered development agent/IDE. It provides a CLI tool, web UI, desktop apps (Tauri and Electron), and a VSCode extension. The project is provider-agnostic and supports Claude, OpenAI, Google, Bedrock, and many other LLM providers via the Vercel AI SDK.

- **Repository**: github.com/anomalyco/opencode
- **License**: MIT
- **Language**: TypeScript (ESM modules)
- **Runtime**: Bun 1.3.11+ (primary), Node.js supported
- **Package Manager**: Bun (monorepo with workspaces)
- **Monorepo Tool**: Turborepo 2.8.13

## Quick Reference

```bash
# Install dependencies
bun install

# Run CLI in dev mode
bun dev

# Run web UI dev server
bun dev:web

# Run desktop app (Tauri)
bun dev:desktop

# Run console app
bun dev:console

# Run Storybook
bun dev:storybook

# Type checking (across all packages)
bun typecheck

# Run unit tests (from the opencode package, NOT root)
cd packages/opencode && bun test

# Run unit tests with JUnit output
cd packages/opencode && bun test:ci

# Run e2e tests (app package)
cd packages/app && bun test

# Database migrations (opencode package)
cd packages/opencode && bun db
```

**Important**: Do NOT run `bun test` from the root - it will error. Run tests from individual package directories.

## Repository Structure

```
opencode/
├── packages/
│   ├── opencode/          # Core CLI tool (main package)
│   ├── app/               # Web UI (Vite + Solid.js)
│   ├── ui/                # Shared UI component library (Solid.js + Kobalte)
│   ├── sdk/               # TypeScript SDK for developers
│   ├── plugin/            # Plugin system (Effect.js + Zod)
│   ├── util/              # Shared utility functions
│   ├── script/            # Build/script utilities
│   ├── desktop/           # Tauri desktop app
│   ├── desktop-electron/  # Electron desktop app
│   ├── console/           # Hosted console (app, core, mail, resource)
│   ├── web/               # Marketing website (Astro)
│   ├── docs/              # Documentation site
│   ├── enterprise/        # Enterprise features
│   ├── extensions/        # IDE extensions
│   ├── function/          # Serverless functions (Hono)
│   ├── slack/             # Slack integration
│   ├── storybook/         # Component library stories
│   ├── containers/        # Container orchestration
│   └── identity/          # Identity/auth service
├── sdks/                  # External SDKs (VSCode extension)
├── .opencode/             # OpenCode config (agents, commands, plugins, themes, tools)
├── .github/               # CI/CD workflows and actions
├── nix/                   # NixOS flakes and derivations
├── infra/                 # Infrastructure (SST)
├── specs/                 # API specifications
└── patches/               # Patched dependencies
```

## Core Package Architecture (`packages/opencode/src/`)

| Module | Purpose |
|---|---|
| `agent/` | AI agent orchestration, agent definitions and prompts |
| `session/` | Session lifecycle, message handling, LLM streaming, compaction |
| `provider/` | LLM provider abstraction (multi-provider via Vercel AI SDK) |
| `tool/` | Built-in tools (bash, edit, read, write, glob, grep, websearch, etc.) |
| `server/` | HTTP/WebSocket server (Hono-based), REST API |
| `cli/` | CLI commands (yargs) and TUI (OpenTUI + Solid.js) |
| `config/` | Configuration loading, JSONC parsing, markdown config |
| `mcp/` | Model Context Protocol client implementation |
| `lsp/` | Language Server Protocol integration |
| `plugin/` | Plugin loading and lifecycle (Codex, Copilot, GitLab, Cloudflare, etc.) |
| `storage/` | Database layer (SQLite via Drizzle ORM) |
| `permission/` | Permission/capability system for tool execution |
| `file/` | File watching, ignore patterns, protected files |
| `git/` | Git operations and integration |
| `bus/` | Event bus for internal messaging |
| `project/` | Project detection and management |
| `skill/` | Skills/commands available to the agent |
| `command/` | User-defined command execution |
| `worktree/` | Git worktree management |
| `control-plane/` | Multi-instance/workspace control |
| `acp/` | Agent Control Protocol implementation |
| `auth/` | Authentication and authorization |
| `share/` | Session sharing functionality |
| `sync/` | Data synchronization |
| `snapshot/` | Snapshot/checkpoint management |
| `v2/` | Protocol v2 implementation |
| `effect/` | Effect.js service layers and runtime |

### Key Patterns

- **Barrel self-exports**: Modules use `export * as X from "."` at the bottom of their index.ts to create namespace-like exports. Import via barrel path (e.g., `import { Config } from "@/config"`) not direct file path.
- **Effect.js**: The project uses the Effect library for service composition, dependency injection, and error handling via `Context`, `Layer`, `Effect`
- **Zod schemas**: Used extensively for validation and type definitions
- **Conditional imports**: Platform-specific code via `#db`, `#pty`, `#hono` import maps (Bun vs Node.js)
- **Path aliases**: `@/*` maps to `./src/*`, `@tui/*` maps to `./src/cli/cmd/tui/*`

## Database

- **Engine**: SQLite (via Drizzle ORM)
- **Schema files**: `packages/opencode/src/**/*.sql.ts`
- **Migrations**: `packages/opencode/migration/` (auto-generated, **do not edit manually**)
- **Config**: `packages/opencode/drizzle.config.ts`

## Code Style

- **Formatter**: Prettier (no semicolons, 120 char line width)
- **Indentation**: 2 spaces
- **Line endings**: LF
- **Charset**: UTF-8
- **Type checker**: `tsgo --noEmit` (TypeScript native preview)
- **Git hooks**: Husky for pre-commit formatting

## CI/CD

Tests run on GitHub Actions (`.github/workflows/test.yml`):
- **Unit tests**: Linux (ubuntu-2404) and Windows (windows-2025) via `bun turbo test:ci`
- **E2E tests**: Playwright against the web app
- **Type checking**: `bun typecheck` via Turborepo
- Turbo caching is enabled for incremental builds

## LLM Providers

The project integrates with many providers via `@ai-sdk/*` packages:
Anthropic, OpenAI, Google (Gemini + Vertex), Amazon Bedrock, Azure, Groq, Mistral, Cohere, xAI, Perplexity, Cerebras, DeepInfra, TogetherAI, OpenRouter, and more.

Model metadata is fetched from `models.dev` and cached locally.

## Configuration

- **Project config**: `.opencode/opencode.jsonc` (JSONC format)
- **Global config**: `~/.config/opencode/` (XDG base directories)
- **Managed config** (enterprise): `/etc/opencode` (Linux), `/Library/Application Support/opencode` (macOS)
- **Key settings**: provider selection, permission rules, MCP servers, tool toggles, plugin specs

## LLM Profiling

Profiling logs every LLM API call when enabled via environment variable:

```bash
OPENCODE_PROFILING=true bun dev
```

**Log location**: `~/.local/share/opencode/profiling/`

Two files are generated per session:

| File | Content |
|------|---------|
| `profile-<timestamp>.jsonl` | Compact summary: tokens (input/output), message roles, available/called tools, duration, model/provider info |
| `profile-raw-<timestamp>.jsonl` | Full text: system prompts, user query, all input messages, output text/reasoning/tool calls |

Both files share a `requestID` field for cross-referencing.

**Implementation** (3 files):
- `session/profiler.ts` — JSONL writer with `startRequest` / `appendText` / `appendReasoning` / `appendToolCall` / `endRequest`
- `session/llm.ts` — captures request metadata before `streamText()`
- `session/processor.ts` — captures output via stream events (`text-delta`, `reasoning-delta`, `tool-call`, `finish-step`)

## `bun dev` vs Built Binary

`bun dev` runs TypeScript source directly; `./packages/opencode/script/build.ts --single` produces a standalone native binary. Key difference: `generate.ts` creates `models-snapshot.js` (model catalog from models.dev), which is embedded in the binary but absent in dev mode. If network is unavailable, run `bun ./packages/opencode/script/generate.ts` first to create the snapshot for dev mode.

## Important Notes

- Migration files under `packages/opencode/migration/` are **denied for editing** in the project config
- The TUI is built with OpenTUI (custom terminal UI framework) + Solid.js with JSX (`jsxImportSource: "@opentui/solid"`)
- The HTTP server uses Hono with platform-specific adapters (Bun and Node.js)
- WebSocket support is used for real-time session updates
