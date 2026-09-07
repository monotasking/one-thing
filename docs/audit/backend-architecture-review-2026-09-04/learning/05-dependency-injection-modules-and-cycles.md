# 学习 05：依赖注入、模块与循环依赖

> [返回学习目录](./README.md) · [返回架构审查总览](../README.md)

## 依赖注入在解决什么

一个对象需要日志、存储或事件总线时，有两种取得方式。

隐藏依赖：

```ts
function renameSession() {
  const store = getGlobalSessionStore()
}
```

显式依赖：

```ts
function createSessionCommands(ports: { store: SessionStore }) {
  return { renameSession() { ports.store.rename() } }
}
```

第二种叫依赖注入。只看函数签名就知道它依赖什么，测试也可以传入替身。

## Constructor/Factory DI 与 Service Locator

- Constructor/Factory DI：创建对象时把依赖传进去；
- Service Locator：业务代码运行时主动调用 `getXxx()` 找依赖；
- Setter Injection：先 import 模块，再用 `configureXxx()` 往模块变量里塞依赖。

Service Locator 和全局 setter 写起来方便，但会隐藏依赖、污染测试状态，并让同一进程难以运行两套独立实例。

迁移时不必一次删完。可以保留一个明确命名的 `LegacyDefaultBackend`，让旧接口只通过这一处转发；新代码不允许使用它，调用量用门禁逐步降到零。

## Singleton 并不等于所有模块级状态

模块级 `let` 可能是：

- 正式 singleton；
- 当前 service/port；
- registry；
- timer、generation、关闭标记；
- cache。

它们风险不同。审查时应该问“谁创建、谁释放、能否属于某个实例”，而不是简单把全部变量改成 `const`。

## 什么是循环依赖

如果 A import B，B 又 import A，就构成环：

```text
Store → Commands → Store
```

多个模块形成的大环叫强连通分量（SCC）。ESM 加载会按顺序初始化，环中如果某个模块在顶层读取尚未初始化的值，可能出现 `undefined` 或 TDZ 错误。

即使目前通过“只在函数调用时读取”没有报错，环仍说明 ownership 不清楚：底层 store 为什么需要知道上层 command？

## 如何拆环

常见方法不是增加动态 import，而是改变职责：

1. 把双方都需要的类型或纯规则下沉；
2. 让上层声明 port，由组合根注入底层实现；
3. 用返回值或领域事件通知外层，不让底层反向调用；
4. 把本来属于同一个对象的状态合并到实例中；
5. 去掉只为 barrel export 形成的自引用。

## 在本项目中对应什么

- 当前 backend 实例槽：`packages/backend/current.ts`
- Session command/store 环：`packages/backend/session/commands.ts` 与 `packages/backend/stores/sessions.ts`
- Event surface/writer 环：`packages/backend/session/event-surface.ts` 与 `event-writer.ts`
- 装配入口：`packages/backend/backend.ts`

读主文档第 05、06 篇时，重点问每个模块的依赖能否从 factory 参数中看见。
