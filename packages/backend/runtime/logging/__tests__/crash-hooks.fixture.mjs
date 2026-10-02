/**
 * 子进程夹具:被 `crash-hooks.test.ts` 用 `node <this>` 直接跑。
 *
 * 它 import 的是 `../crash-hooks.ts` —— Node 原生剥类型即可,因为那个文件只有
 * `import type`,运行时零导入,不需要任何别名解析。夹具本身写成 `.mjs`,免得
 * 进到 tsc 的编译单元里(`.ts` 扩展名的显式 import 在 tsconfig 下是错)。
 *
 * 它做的事:装上进程钩子 → 制造一次未处理拒绝 / 未捕获异常 → 让进程按 Node 的
 * 默认行为死掉。父进程据此断言:①记录落进了文件 ②`flushSync` 在退出前被调用过
 * ③退出码仍是 Node 的默认值(钩子没有把崩溃吞掉)。
 */
import { appendFileSync } from 'node:fs'
import { installProcessCrashHooks } from '../crash-hooks.ts'

const outFile = process.argv[2]
const mode = process.argv[3] === 'uncaught' ? 'uncaught' : 'rejection'

let flushed = 0
const write = record => appendFileSync(outFile, `${JSON.stringify(record)}\n`)

const logger = {
  ns: 'process',
  isLevelEnabled: () => true,
  child() { return logger },
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (msg, fields) => write({ level: 'warn', msg, fields }),
  error: () => {},
  fatal: (msg, fields, err) => write({
    level: 'fatal',
    msg,
    fields,
    err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
  }),
}

installProcessCrashHooks(logger, {
  flushSync: () => {
    flushed += 1
    write({ level: 'info', msg: 'flushSync', fields: { flushed } })
  },
})

if (mode === 'uncaught') {
  setTimeout(() => {
    throw new Error('fixture uncaught')
  }, 0)
} else {
  void Promise.reject(new Error('fixture rejection'))
  // 让 unhandledRejection 有机会派发,再自己退出 —— 这样两条用例的退出码可分辨。
  setTimeout(() => process.exit(0), 150)
}
