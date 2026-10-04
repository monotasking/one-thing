# onething

> An AI chat desktop app with multi-provider support, built-in tools, project context, and an event-driven streaming engine.

![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron)
![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)

[中文说明](./README.zh-CN.md)

## What is onething?

onething is an Electron-based desktop application that brings together multiple AI providers with a local tool execution system. It is built around an event-driven streaming engine, a typed Electron IPC bridge, project-directory context, and a Vue interface for long-running chat sessions.

## Key Features

- **Multi-provider chat** - OpenAI, Claude, Claude Code OAuth, DeepSeek, Gemini, GitHub Copilot, OpenRouter, Kimi, Zhipu, and OpenAI-compatible custom providers.
- **Event-driven streaming** - Session commands and stream events flow through the main-process EventBus and IPCBridge.
- **Built-in tools** - Bash, read/write/edit, glob/grep, calculator, web search, variables, todo plans, skills, and image generation support.
- **Permission controls** - Directory-scoped permissions for tool execution, with renderer confirmation for sensitive actions.
- **Project context** - Project directories, per-session `workdir`, notes directories, and context variables can be surfaced to the model.
- **Extensibility** - MCP servers, Codex-style skills, local plugins, custom themes, and provider model registries.
- **Desktop workflow UI** - Chat sessions, streaming markdown, file/editor panels, search, media preview, and settings screens.

## Download

Prebuilt installers for macOS (Apple Silicon), Windows, and Linux are published on
[GitHub Releases](https://github.com/monotasking/one-thing/releases). A download site
with China-friendly mirrors lives in [`site/`](./site) (see
[deployment guide](./docs/deploy/website-tencent-hk.md)).

## Quick Start

```bash
# Install dependencies (using bun)
bun install

# Development mode (electron-vite runs main, preload, and renderer)
bun run dev

# Build for production
bun run build
```

### First-Time Setup

1. Launch the app
2. Open settings (`Cmd/Ctrl + ,`)
3. Choose an AI provider and enter your API key (or use OAuth)
4. Start chatting!

## Development Commands

```bash
# Typecheck both Node and renderer projects
bun run typecheck

# Run tests
bun run test

# Run ESLint with auto-fix
bun run lint

# Typecheck, then build
bun run build:check
```

## Building & Releasing

### Development Build

```bash
# Run all build steps (renderer + main + preload)
bun run build

# Test packaging without full distribution
bun run build:unpack
```

### Platform-Specific Builds

```bash
# Build for specific platforms
bun run build:mac     # macOS (DMG + ZIP)
bun run build:win     # Windows (NSIS + Portable)
bun run build:linux   # Linux (AppImage + DEB)
```

### Creating a Release

Use the automated release script:

```bash
# Create and push a new release tag
bun run release 1.0.0
```

The release script updates `package.json`, creates a version commit and tag, and pushes both to the current branch's remote.

You can also tag manually:

```bash
# Update version in package.json, commit, and tag
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

GitHub Actions build and test workflows live in [`.github/workflows`](./.github/workflows).

## Architecture

The repository is a monorepo. The Electron app is the primary host; a headless
server and a browser build share the same runtime packages:

```
packages/core/              # Engine, sessions, permissions, tools, storage primitives
packages/onething-runtime/  # App runtime: prompts, themes, memory, media, agents
packages/gateway/           # WeChat/Telegram channel gateway (remote approval)
apps/electron/              # Electron-host-specific IPC/preload pieces
apps/backend-server/                # Headless server (HTTP, default port 8787)
apps/web/                   # Browser build of the renderer
src/main, src/renderer      # The Electron app itself
site/                       # Marketing/download website (static)
```

The Electron app follows the three-process model:

- **Main Process** - Node.js backend with EventBus, StreamEngine, AI providers, tool execution, permissions, and persistence
- **Renderer Process** - Vue 3 frontend with Pinia state management
- **Preload Script** - Type-safe IPC bridge between main and renderer

Key technologies: Electron, Vue 3, TypeScript, Pinia, Vercel AI SDK, electron-vite, and Vitest.

## Documentation

See `/docs` for detailed documentation:

- [Project directories](./docs/project-dirs.md)
- [Variables plugin guide](./docs/variables-plugin.md)
- [Long-session storage and rendering](./docs/design/long-session-storage-and-rendering.md)
- [Streaming markdown rendering](./docs/design/streaming-markdown-rendering.md)
- [Streaming scroll stability](./docs/design/streaming-scroll-stability.md)
- [Message action jitter](./docs/design/message-action-jitter.md)
- [Editor platform hardening](./docs/design/editor-platform-hardening.md)

Coding-agent guidance lives in [AGENTS.md](./AGENTS.md) and [CLAUDE.md](./CLAUDE.md).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 39 |
| Frontend | Vue 3 + TypeScript + Pinia |
| AI SDK | Vercel AI SDK (`ai`) |
| Storage | File-based JSON + per-session JSONL message logs |
| Build | electron-vite + electron-builder |
| Test | Vitest |
