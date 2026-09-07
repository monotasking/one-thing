# 会话同步协议整条撤回（2026-09-07）

删了什么：`packages/shared/sync/`、`packages/client/sync/`、`packages/backend/server/sync{,-backend,-notifications}.ts`
及其测试；`GET /api/sync`、`GET /api/events?sync=1`、`x-onething-sync-protocol` 头、`session:sync` 帧；
client 的 `onSync` / `syncSnapshot` / `setSyncScopes` / `'syncing'` 连接态；渲染层
（`chat-source` / `sessions-source` / 两个 port）的 `synchronized` 分支与
`materializeSynchronizedMessages`；CLI daemon 的 `sync.open/snapshot/close` 与客户端重同步；
`RuntimeHostCapabilities.syncProtocol`；`projection-cache` 里只服务同步的 `observeChanges`。

为什么：**一份账本一份真相**。`sessions/<id>/events.jsonl` 已经是唯一账本，渲染层自己折投影 +
`StreamWater` 流水位 + 缺号整会话重折。服务端权威快照是第二套真相，而且每个 token 都重新取整会话
消息、深比对、序列化再推一遍，与 09-03 治掉的「每条 delta 全量物化」同源同病。

断线恢复仍然靠原路：SSE 的 `?after=`（= 账本 sequence）从环形缓冲续播，缺号则整会话重折。
背压溢出走 `transport:resync-required`（与同步协议无关，保留）。

验尸规则：`scripts/headless-boundary-check.ts` 的
`session state reaches clients only through the ledger`。
