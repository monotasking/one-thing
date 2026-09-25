/**
 * **把几何断言那几行留下来**(G 线 P4-b,正本 `docs/stream-geometry-2026-09.md` §22.4 第二条)。
 *
 * dev 断言(`content/viewport/geometry-ledger.ts`)只 `warn` 不抛,说给壳自己的
 * `getLogger('chat.geometry')`。**§22.4 写的「渲染日志经 RPC 落到 store 文件」对这块壳不成立**
 * (P4-b 施工时量出来的):React 壳的 `services/log.ts` 是一只内存环(`window.__log.dump()`,
 * 200 条,所有 ns 共用)+ dev 档把同一句话说给 console,没有任何一条路把它送进 `app.jsonl` /
 * `server.jsonl`(那条 RPC 传输是退役 Vue 渲染层的,壳没接)。于是这一族门跑完删 store 时,
 * 本来也没有东西可读 —— 第一批违例「从来没人读到过」(§19.7 末条)的真因在这儿。
 *
 * 所以这里收的是 **dev 档那一句 console**:门在拿到窗口之后 `attach(page)`,Playwright 的
 * `console` 事件把每一条 `[chat.geometry]` 连同它的 `fields` 交过来。不读那只环:它 200 条封顶、
 * 所有 ns 共用,一道十几个场景的门跑完,前面的违例早被挤掉了。
 *
 * **只在显式要的时候做**:环境变量 `ONETHING_GATE_GEOMETRY_LOG=<目录>` 在场才挂监听,不在场
 * `attach` / `flush` 都是空跳 —— 门的缺省跑法与从前逐字相同。收到的行写进
 * `<目录>/<门>-<档>.jsonl`,一行一条 `{ at, level, msg, fields }`,由读的人归类(§22.5)。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const TAG = '[chat.geometry]'

export function geometryLogCollector(gate, lane) {
  const outDir = process.env.ONETHING_GATE_GEOMETRY_LOG
  const kept = []
  const pending = []
  /** 门此刻在跑哪一段(`mark` 写);每一行记下它**到的那一刻**的这一格,归类时才说得出是哪个场景。 */
  let current = '(开场)'
  return {
    /** 门每进一段调一次 —— 只是一格标签,不做别的。 */
    mark(label) {
      current = label
    },
    /** 窗口一到手就挂上(越早越好:进场那几帧的违例也算)。 */
    attach(page) {
      if (!outDir) return
      page.on('console', (message) => {
        if (!message.text().startsWith(TAG)) return
        const at = Date.now()
        const label = current
        const level = message.type()
        // args = [TAG, msg, fields];jsonValue 是异步的,等 flush 时一起收
        pending.push(
          Promise.all(message.args().map((arg) => arg.jsonValue().catch(() => null)))
            .then(([, msg, fields]) => kept.push({ at, label, level, msg, fields }))
            .catch(() => kept.push({ at, label, level, msg: message.text(), fields: null })),
        )
      })
    },
    /** 收尸之前调:把收到的写出去,打一行计数。 */
    async flush() {
      if (!outDir) return
      await Promise.all(pending)
      mkdirSync(outDir, { recursive: true })
      const file = path.join(outDir, `${gate}-${lane}.jsonl`)
      if (kept.length > 0) appendFileSync(file, `${kept.map((row) => JSON.stringify(row)).join('\n')}\n`)
      console.log(`  [geometry-log] chat.geometry ${kept.length} 行 → ${file}`)
    },
  }
}
