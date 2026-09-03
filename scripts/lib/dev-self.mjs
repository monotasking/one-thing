import os from 'node:os'
import path from 'node:path'

// 自举开发(用 onething 开发 onething)的第二条泳道:
//
//   A 实例 = 日常那只(store ~/.onething,端口 5173/5174/8787,产物 out/)
//   B 实例 = dev-self(store ~/.onething-dev,端口 5273/5274/8887,产物 dist/dev-self)
//
// 两条泳道跑的是同一份代码、同一套脚本(dev-unified / dev-with-logging),
// 差别只有三样:store、端口、产物目录。这个模块是这三样的唯一定义处,
// 外加一条"进程属于谁"的判据 —— 两边的清扫逻辑都靠它划界,谁也不许越界杀
// 对方的进程。

export const DEV_SELF_OUT_DIR = 'dist/dev-self'
export const DEV_SELF_ELECTRON_ENTRY = `${DEV_SELF_OUT_DIR}/main/index.js`
export const DEV_SELF_SERVER_OUT_DIR = 'dist/dev-self-server'
export const DEV_SELF_WEB_CACHE_DIR = 'node_modules/.vite/web-dev-self'
export const DEV_SELF_USER_DATA_DIR_NAME = 'dev-self-user-data'
export const DEV_SELF_STORE_DIR_NAME = '.onething-dev'
export const DEV_SELF_RUNNER_FLAG = '--dev-self'

export const DEFAULT_PORTS = { renderer: 5173, web: 5174, server: 8787 }
export const DEV_SELF_PORTS = { renderer: 5273, web: 5274, server: 8887 }

export function devSelfStorePath(env = process.env) {
  return env.ONETHING_STORE_PATH || path.join(os.homedir(), DEV_SELF_STORE_DIR_NAME)
}

// 子进程一律通过 env 认领泳道身份(runner 的 argv 里另有 --dev-self,
// 那是给 ps 看的 marker,见下)。
export function isDevSelfLane(env = process.env) {
  return env.ONETHING_DEV_SELF === '1'
}

export function lanePorts(devSelf) {
  return devSelf ? DEV_SELF_PORTS : DEFAULT_PORTS
}

export function laneServerOutDir(devSelf) {
  return devSelf ? DEV_SELF_SERVER_OUT_DIR : 'dist/server'
}

// dev-self 的每个进程命令行里都带得上 "dev-self" 这个子串:
//   runner        node scripts/dev-unified.mjs electron --dev-self
//   electron-vite / Electron 主进程   …/dist/dev-self/main/index.js
//   Electron 子进程(helper)         --user-data-dir=<store>/dev-self-user-data
//   headless server                   node dist/dev-self-server/main.js
// web 前端是个例外(vite 命令行里没有产物路径),用它独占的端口号兜底。
export function commandBelongsToDevSelf(command) {
  const normalized = command.replaceAll('\\', '/')
  return normalized.includes('dev-self')
    || normalized.includes(`--port ${DEV_SELF_PORTS.web}`)
}

// electron-vite 起 Electron 时把入口当第一个参数传(默认 '.';dev-self 走
// ELECTRON_ENTRY 指到自己的产物)。入口字符串就是区分两只 Electron 的钥匙。
export function electronMainCommandPrefix(projectRoot, devSelf) {
  // 日常泳道(2026-09-03 起)是 React 壳:apps/desktop-react/scripts/dev-app.mjs 把打好的
  // dist-electron/main.cjs 当入口传给 Electron。dev-self 泳道仍是 Vue 宿主的产物入口(第四步一起退役)。
  // dev-self 泳道(Vue 宿主的 B 实例)随第四步退役;两档都认 React 入口,参数留着不改调用方。
  void devSelf
  const entry = `${projectRoot}/apps/desktop-react/dist-electron/main.cjs`
  return `${projectRoot}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ${entry}`
}
