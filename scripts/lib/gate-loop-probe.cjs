/**
 * 主线程事件循环延迟的**探针**——给 `gate:search-index` 的第 ⑤ 条用
 * (检索重建 §5.3 末句:「门:`gate:search-index` 里量**主线程事件循环延迟**
 * (`perf_hooks.monitorEventLoopDelay`)—— 冷建全程 p99 < 20ms、增量折期间 < 5ms;
 * 把索引服务改回主线程跑这条门必红。」)。
 *
 * ## 它是**预加载**,不是产品代码
 *
 * 用法:`node --require scripts/lib/gate-loop-probe.cjs dist/server/main.js`,再给一个
 * `ONETHING_GATE_LOOP_OUT=<文件路径>`。没有那个环境变量就**什么都不做** —— 所以即使
 * 有人误把 `--require` 带进别的场合,它也只是一段立刻返回的代码。
 *
 * 被测的进程里于是一行产品代码都没改。这一点是有意的:要证的是「索引不在主线程上
 * 跑」,而为了量它去动被量的那个东西,量出来的就不是产品的行为了。
 *
 * ## 为什么不是别的两种量法
 *
 * 派工单给了两条路:
 *
 *  - **(a) 让 server 自己在某条既有诊断口上吐读数** —— 那要在 `search.status` 的契约上
 *    加一格 `loopDelay`,而那一格**只有门会读**。契约里不该长出只为门服务的格子;
 *    这一批确实给 `status` 加了一格(`docs`),但那是壳与门都要的真读数,不是这个。
 *  - **(b) `--inspect` + CDP `Runtime.evaluate`** —— **实测走不通**:evaluate 出来的那个
 *    上下文里 `require` 不存在,而 `await import('node:perf_hooks')` 当场抛
 *    `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`(「A dynamic import callback was not
 *    specified」)。拿不到 `perf_hooks` 就只能在 evaluate 里手搓一个 setTimeout 漂移
 *    采样器 —— 那是另一个量,不是 `monitorEventLoopDelay`。
 *
 * 预加载这条路两头都占到了:量的是**真的** `monitorEventLoopDelay`(libuv 那一份,
 * 10ms 分辨率),而产品代码一个字没动。
 *
 * ## 怎么取读数
 *
 * `process.kill(pid, 'SIGUSR2')` → 探针把当前直方图写进 `ONETHING_GATE_LOOP_OUT`
 * (一行 JSON:`{ p50, p90, p99, max, mean, count, at }`,毫秒),**然后 reset**。
 * 于是「冷建那一段」与「增量折那一段」各是一次 SIGUSR2 之间的窗口,两段互不污染。
 *
 * SIGUSR2 是有意选的:node 自己占的是 SIGUSR1(启调试器),SIGUSR2 没有默认行为。
 */

/*
 * `require` 是这个文件存在的**理由**,不是遗留写法:`--require` 只吃 CJS,而它要在
 * 产品代码之前跑。所以这一条规则在这里关掉,并且只在这里。
 */
/* eslint-disable @typescript-eslint/no-require-imports */

'use strict'

const outPath = process.env.ONETHING_GATE_LOOP_OUT
if (outPath !== undefined && outPath.length > 0) {
  const fs = require('node:fs')
  const { monitorEventLoopDelay } = require('node:perf_hooks')

  /*
   * **`resolution: 1`,不是 10**(S3c 实测定的)。
   *
   * `monitorEventLoopDelay` 的每个采样里带着它自己那一拍的间隔:同一台机器上一条
   * **完全空闲**的事件循环,`resolution: 10` 读出来 p50 12.03ms / p99 12.06ms,
   * `resolution: 5` 读 6.28 / 6.42,`resolution: 1` 读 1.27 / 1.33。也就是说 10 的
   * 底噪就已经越过了 §5.3 给增量段定的 5ms 线 —— 拿它去判「主线程闲不闲」,量的是
   * 采样周期不是阻塞。1ms 的底噪把两条线(冷建 20ms / 增量 5ms)都留在了可判的范围
   * 里,而一次 200ms 的同步阻塞在这个档下如实读成 `max 201.2ms`(同一支反证脚本量的)。
   */
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()

  process.on('SIGUSR2', () => {
    const ms = value => Number((value / 1e6).toFixed(3))
    const snapshot = {
      p50: ms(histogram.percentile(50)),
      p90: ms(histogram.percentile(90)),
      p99: ms(histogram.percentile(99)),
      max: ms(histogram.max),
      mean: ms(histogram.mean),
      count: histogram.count,
      at: Date.now(),
    }
    try {
      fs.writeFileSync(outPath, `${JSON.stringify(snapshot)}\n`)
    } catch {
      // 门读不到就自己超时报错,这里不抬高被测进程的风险。
    }
    histogram.reset()
  })

  // 这条直方图不该拦住进程退出。
  histogram.unref?.()
}
