---
name: onething-self-evolution
description: Extend the running onething app at runtime by writing and mounting a **feature** (a small ES module) — no rebuild, no restart. Use when the user wants the app itself to gain a backend capability (an RPC domain, a timer, a watcher) right now. Enabling this skill exposes the feature_inspect / feature_mount / feature_unmount tools.
default-enabled: false
metadata:
  hermes:
    tags: [onething, self-evolution, feature, runtime-extension]
---

# Onething Self-Evolution (runtime features)

This app can be extended at runtime by you. A **feature** is a small ES module the app mounts into itself while running. Three tools own this — they are only present while this skill is enabled:

- `feature_inspect` — what is mounted, what sits in `features-dev/` and could be mounted, plus the module contract and a starter template. **Always call it first.**
- `feature_mount` — mount `<store>/features-dev/<id>/feature.mjs`. Executes the code you wrote, so every call asks the user for permission and that answer is never remembered.
- `feature_unmount` — unwind everything a mounted feature registered (built-in features cannot be unmounted).

## Facts

- Features live at `<store>/features-dev/<id>/feature.mjs` — the store path is printed by `feature_inspect`. This is **user data**, not the app's source repository: do not look for features in the project working directory.
- The module default-exports `{ id, mount(ctx) }`. `id` must equal the directory name you pass to `feature_mount`.
- `ctx` offers exactly two registration surfaces, both returning a disposer:
  - `ctx.registerRpcDomain(router, handlers)` — router is pure data: `{ domain, channels: { name: 'domain:name' }, methods: [name] }`.
  - `ctx.registerDisposer(fn)` — pair every side effect (timer, watcher, connection) with one.
- Current scope is **backend only**: a feature can add RPC domains and hold resources. It cannot change the UI or register new tools.

## Workflow

1. `feature_inspect` → read the store path, the candidates and the template.
2. Write the file with `write` (create the directory with `bash mkdir -p` if `feature_inspect` says it does not exist — the tool never creates it for you).
3. `feature_mount({ id })`. A mount failure is rolled back automatically and the error text tells you what to fix; fix the file and mount again.
4. To change a mounted feature: edit the file → `feature_unmount` → `feature_mount`. The module cache is bypassed, so you always get the code currently on disk.

## Minimal template

```js
// <store>/features-dev/<id>/feature.mjs
export default {
  id: '<id>',
  mount(ctx) {
    const timer = setInterval(() => {}, 60_000)
    ctx.registerDisposer(() => clearInterval(timer))
    // ctx.registerRpcDomain(
    //   { domain: 'demo', channels: { ping: 'demo:ping' }, methods: ['ping'] },
    //   { async ping(input) { return { pong: input.value } } },
    // )
  },
}
```
