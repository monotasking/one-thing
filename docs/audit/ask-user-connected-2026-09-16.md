# React 界面接通 ask_user

已将真实交互请求接入输入区的问答表单。答案通过 `interaction.respond` 返回原提问，不再作为一条新的用户消息发送。

## 行为

- 收到 `interaction:requested` 即展示问题；首次打开、切回会话及连接恢复时查询 `interaction.getPending`。
- 按会话隔离。多个待答请求依次展示，同一个请求重新同步时保留已填写答案。
- 按 question ID 回传单选、多选和自由文本，标题相同也不会覆盖答案。
- 遵守 `allowFreeText: false`；自由输入随输入保存，不必先按回车。没有自由输入框时，键盘焦点可落到选项。
- 拒绝回答使用 `decline: true`。停止、超时或其他窗口已经回答后，关闭对应表单。
- 提交期间防重复发送；失败保留答案并显示错误，允许重试。
- 迟到的查询不会复活已结算请求，旧请求的回执不会清掉下一份表单。
- 不改正文账本；此前“停止后正文漏画”的修复继续保留。

## 实现

- `apps/desktop-react/src/data/interaction-port.ts`：真实 RPC 和事件端口。
- `apps/desktop-react/src/data/composer-interactions.ts`：待答请求同步、排队、答案映射和生命周期。
- `apps/desktop-react/src/composer/components/Composer.tsx`：按当前会话接入。
- Composer store 与 AskForm：真实请求的异步提交、错误保留和自由输入。
- `/ask-demo` 仍为开发环境的离线样式演示；真实请求使用单独的原工具应答通道。

## 验证

- 151 项相关测试通过，涵盖表单、输入区、事件同步、真实客户端端口与正文装配。
- 真实交互内核 + 真实客户端路由 + 内存传输：待答恢复后提交，原 `Interaction.ask()` 返回 `answered`；实时请求出现后拒绝，原等待返回 `declined`，没有额外发送聊天消息。
- 组件测试实际选择选项、填写自由文本、点击提交，核对结构化应答。
- 覆盖断线重连、查询与事件并发、重复提交、错误重试、超时、跨会话隔离、卸载后的迟到响应。
- TypeScript 检查及修改范围内的 ESLint 检查通过。现有组件测试仍有 React `act` 提示，测试没有失败。

本轮未重启用户应用，也未在用户正在运行的会话里代答问题；未做真实 Electron/HTTP 全链路的现场验收。代码尚未提交。
