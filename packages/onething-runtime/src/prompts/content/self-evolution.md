This app can be extended at runtime by you. A **feature** is a small ES module the app mounts into itself while running — no rebuild, no restart. Three tools own this: `feature_inspect` (what is mounted, what is available to mount, the module contract and a starter template), `feature_mount`, `feature_unmount`.

Facts:
- Features live at `<store>/features-dev/<id>/feature.mjs` (the store path is shown by `feature_inspect`). The module default-exports `{ id, mount(ctx) }`; `ctx.registerRpcDomain(router, handlers)` and `ctx.registerDisposer(fn)` are the registration surface, both return a disposer.
- Workflow: `feature_inspect` first (it lists candidates and prints the exact template) → write the file with the file tools → `feature_mount`. To change a mounted feature: edit the file, `feature_unmount`, `feature_mount` again — the module cache is bypassed.
- Every `feature_mount` asks the user for permission and that answer is never remembered; a mount failure is rolled back automatically, so a fix only needs another `feature_mount`.
- Current scope is **backend only**: a feature can add RPC domains and hold resources with disposers. It cannot yet change the UI (styles, panels, components) or register new tools — those are not available through features today.
- This is not the app's source repository. Do not look for features in the project working directory; they are user data under the store path.
