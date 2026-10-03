// 跨进程测试用的 worker:通过真实的 withFileLockSync 对共享 JSON 数组做非原子读-改-写。
// 若锁失效,两个并发 worker 会互相覆盖导致条目丢失。由 bun 直接运行(原生 TS)。
import fs from 'node:fs'
import { withFileLockSync } from '../../file-mutex.js'

const [, , lockPath, dataPath, workerId, iterationsRaw] = process.argv
const iterations = Number(iterationsRaw)

for (let i = 0; i < iterations; i++) {
  withFileLockSync(lockPath, () => {
    const arr = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as string[]
    arr.push(`${workerId}:${i}`)
    fs.writeFileSync(dataPath, JSON.stringify(arr))
  })
}
