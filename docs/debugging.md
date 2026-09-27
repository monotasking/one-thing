# 调试指南

读这个仓库时,**先打断点看调用栈,再读代码**。注册表、事件总线、依赖注入、回调对象这些间接层,
在运行时都会还原成真实的调用,调用栈会一次性列出从入口到断点的每一层。

主流程的调用地图在 [`docs/flows/`](flows/README.md),可以拿着地图对照断点。

## 一、在测试里调试(最简单)

测试直接跑 `.ts` 源码,不需要构建,断点一定停得住。

**JetBrains(WebStorm / IDEA)**:打开测试文件,点 `it(...)` 行号旁的绿色三角 → **Debug**。

**命令行**:

```bash
npx vitest --inspect-brk --no-file-parallelism <测试文件路径>
```

然后在 IDE 里用 **Attach to Node.js/Chrome** 连 `9229`。

适合用来看的测试:

| 想看什么 | 测试文件 | 断点打在 |
|---|---|---|
| RPC 分派与会话命令 | `packages/backend/rpc/__tests__/session-command-domain.test.ts` | `packages/backend/rpc/domains/session-command.ts` |
| 向模型发请求 | `packages/onething-runtime/src/agent-loop/providers/__tests__/deepseek-vision.test.ts` | `providers/base/http-agent-provider.ts` 的 `fetchOnce` |

测试里的 `fetch` 是假的,不会联网,但请求的 `url` / `headers` / `body` 都是真实拼出来的。

## 二、调试运行中的桌面应用:主进程(后端)

后端(HTTP 入口、RPC 处理、引擎、调用模型)跑在 Electron 主进程里。

```bash
ONETHING_INSPECT=1 bun run electron:dev      # 主进程开调试端口 9229
ONETHING_INSPECT=9230 bun run electron:dev   # 指定端口
ONETHING_INSPECT=brk bun run electron:dev    # 停在第一行,用来调试启动和装配过程
```

(开关在 `apps/desktop-react/scripts/dev-app.mjs` 的 `inspectArgs`,不设置时行为不变。)

然后在 IDE 里连上去:

- **JetBrains**:Run → Edit Configurations → `+` → **Attach to Node.js/Chrome**,Host `localhost`,Port `9229` → Debug。
- **VS Code**:`launch.json` 里加一项 `{ "type": "node", "request": "attach", "name": "Attach main", "port": 9229 }`。

主进程产物带 source map(`apps/desktop-react/scripts/build-electron.mjs` 的 `sourcemap: true`),
断点直接打在 `packages/**` 的 `.ts` 上。

注意:`packages/core`、`onething-runtime`、`backend` 被打包进 `dist-electron/main.cjs`,
**改了这些包要重启 `electron:dev`**,它们不走 vite 的热更新。

断点停不住(显示为空心)时,临时在代码里写一行 `debugger;` 再重启,一定会停。

## 三、调试前端:渲染进程

- 开发模式的菜单 **View → Toggle Developer Tools**;
- **Sources** 面板:`⌘P` / `Ctrl+P` 输入文件名(比如 `chat-port.ts`),点行号下断点;
- **Network** 面板:筛选 `rpc`,每条 `POST /api/rpc` 的请求体里能直接看到 `domain` / `method` / `payload`,
  「前端调了哪个接口」一眼就知道;回复走 `GET /api/events` 那条长连接(SSE)。

浏览器模式(`bun run web:dev`)一样,用浏览器自己的开发者工具。

## 四、让调试更顺的几个设置

- **开启异步调用栈**(JetBrains 默认开;Chrome DevTools 在设置里叫 *Async stack traces*)。
  这个仓库到处是 `await` 和异步生成器,关掉的话调用栈会在 `await` 处断开。
- **跳过 `node_modules`**(JetBrains:Settings → Debugger → Stepping;DevTools:Ignore List),单步时不会进第三方库。
- **日志断点代替 `console.log`**:断点上右键,取消 *Suspend*,填要打印的表达式。代码不用改,也不会碰到 `log:gate`。
- **条件断点**:比如只在 `sessionId === '…'` 时停,在热路径上很有用。

## 五、不用调试器时

| 想看什么 | 做法 |
|---|---|
| 总线上每一次事件分发(事件类型 + 订阅者标签) | 启动时加 `ONETHING_LOG=info,core.events=trace`,用 `bun run log:tail --ns core.events` 看 |
| 发给模型的完整请求体 | 启动时加 `ONETHING_DUMP_PROVIDER_REQUESTS=1`,文件在 `<store>/log/dumps/provider-requests/` |
| 一轮回复的完整经过(请求、工具调用、耗时) | `onething trace <sessionId> --last` |
