#!/usr/bin/env node
// CLI 产物由 scripts/build-cli.mjs 打到 dist/cli(运行时统一第三步,2026-09-03;从前是 Vue 宿主 electron-vite 的 out/main/cli.js)。
import '../dist/cli/main.cjs'
