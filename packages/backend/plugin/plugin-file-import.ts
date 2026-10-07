/**
 * `file-pick` 的**拷贝执行面**(B 期,用户壁纸)。
 *
 * 判据全在 core(`plugins/file-pick.ts`),这里只做 IO:stat 一次、过闸、
 * 拷进这个插件的数据目录、把**地址**递回去。
 *
 * 为什么拷贝而不是记住用户的原路径:
 *  - 原路径是用户的目录结构,递给插件等于免费送它一份文件系统情报
 *    (`/Users/<name>/Desktop/…` 里连人名都有);
 *  - 用户下次把那张图挪走 / 删掉,背景就凭空消失,而没人说得清为什么;
 *  - 卸载插件时要连数据一起清,只有落在家目录里的东西才在拆除快照的账上。
 *
 * 落点是 `plugins/<id>/storage/imports/`:`storage/` 是 api.storage 的 scratch
 * 根 —— 插件**自己**也能读写那里,这是有意的(它可以自己列出导入过哪些壁纸)。
 * `imports/` 这一层是宿主的约定,让"用户导入的"与"插件自己写的"在同一个根下
 * 仍分得开。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  PLUGIN_IMPORTS_DIR_NAME,
  PLUGIN_STORAGE_IMAGE_PREFIX,
  clampPluginFilePickMaxBytes,
  describePluginFileImportProblem,
  nextAvailablePluginImportFileName,
  parsePluginStorageImageRef,
  resolvePluginFilePickAccept,
  sanitizePluginImportFileName,
  type PluginFilePickResult,
} from '@onething/backend/plugin-contract'
import type { PickPluginFileRequest, PickPluginFileResponse, PickedPluginFile } from '@shared/ipc/plugins.js'
import { assertNotInNodeModules, getCorePluginScratchDir } from './plugin-storage.js'
import { getPluginsDir } from './plugin-disk-loader.js'

export interface PluginFileImportRequest {
  pluginId: string
  /** 用户在原生对话框里选中的绝对路径。**插件永远看不到它。** */
  sourcePath: string
  /** 节点声明的 accept(未 resolve);缺省 = 全白名单。 */
  accept?: unknown
  /** 节点声明的 maxBytes(未 clamp);缺省 = 宿主硬顶。 */
  maxBytes?: unknown
}

export type PluginFileImportOutcome =
  | { ok: true; result: PluginFilePickResult }
  /** 闸不过 / IO 失败。`reason` 是**给用户看的一句人话**(宿主 toast 原样弹)。 */
  | { ok: false; reason: string }

/** 一个插件的导入目录:`plugins/<id>/storage/imports/`。 */
export function getPluginImportsDir(pluginId: string): string {
  return path.join(getCorePluginScratchDir(getPluginsDir(), pluginId), PLUGIN_IMPORTS_DIR_NAME)
}

/**
 * 把用户选中的文件拷进插件的数据目录。
 *
 * 闸的顺序有意义:**先 stat 再判**(尺寸闸要有真实字节数),**先判再建目录**
 * (一次被拒的导入不该留下一个空目录),**建目录前过 node_modules 铁律**
 * (数据永远不进代码区,与 storage/config/KV 三条写路径同一道闸)。
 */
export function importPluginFile(request: PluginFileImportRequest): PluginFileImportOutcome {
  const { pluginId, sourcePath } = request
  if (!pluginId || typeof sourcePath !== 'string' || !sourcePath) {
    return { ok: false, reason: 'That file could not be read.' }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(sourcePath)
  } catch {
    return { ok: false, reason: 'That file could not be read.' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'Pick a file, not a folder.' }

  const accept = resolvePluginFilePickAccept(request.accept)
  const maxBytes = clampPluginFilePickMaxBytes(request.maxBytes)
  const originalName = path.basename(sourcePath)
  const problem = describePluginFileImportProblem({
    name: originalName,
    size: stat.size,
    accept,
    maxBytes,
  })
  if (problem) return { ok: false, reason: problem }

  // 清洗之后再核一次扩展名:清洗只动主干,但"只动主干"是这个函数的承诺,
  // 而承诺该有一条断言而不是一句注释。
  const safeName = sanitizePluginImportFileName(originalName)
  const safeProblem = describePluginFileImportProblem({
    name: safeName,
    size: stat.size,
    accept,
    maxBytes,
  })
  if (safeProblem) return { ok: false, reason: safeProblem }

  const targetDir = getPluginImportsDir(pluginId)
  try {
    assertNotInNodeModules(getPluginsDir(), targetDir)
    fs.mkdirSync(targetDir, { recursive: true })
  } catch {
    return { ok: false, reason: 'That file could not be saved.' }
  }

  const fileName = nextAvailablePluginImportFileName(
    safeName,
    candidate => fs.existsSync(path.join(targetDir, candidate)),
  )
  if (!fileName) return { ok: false, reason: 'That file could not be saved.' }

  try {
    fs.copyFileSync(sourcePath, path.join(targetDir, fileName))
  } catch {
    return { ok: false, reason: 'That file could not be saved.' }
  }

  return {
    ok: true,
    result: {
      path: `${PLUGIN_STORAGE_IMAGE_PREFIX}${PLUGIN_IMPORTS_DIR_NAME}/${fileName}`,
      name: fileName,
      size: stat.size,
    },
  }
}

export interface PluginFileBytesImportRequest {
  pluginId: string
  /** 客户端报上来的文件名(只取最后一段,照样清洗)。 */
  name: string
  bytes: Uint8Array
  accept?: unknown
  maxBytes?: unknown
}

/**
 * 客户端把字节交回来的那一种导入(第④步批 4:对话框在客户端开,后端进程里没有窗口)。
 *
 * 闸与 `importPluginFile` 逐条相同(扩展名白名单、尺寸上限、清洗后的名字再核一次、不进 node_modules、
 * 不覆盖已有文件),只是「源」从一条本机路径换成一段字节 —— 浏览器壳拿得到字节、拿不到路径。
 */
export function importPluginFileBytes(request: PluginFileBytesImportRequest): PluginFileImportOutcome {
  const { pluginId, bytes } = request
  const originalName = path.basename(String(request.name ?? '').replace(/\\/g, '/'))
  if (!pluginId || !originalName || !(bytes instanceof Uint8Array)) {
    return { ok: false, reason: 'That file could not be read.' }
  }
  const accept = resolvePluginFilePickAccept(request.accept)
  const maxBytes = clampPluginFilePickMaxBytes(request.maxBytes)
  for (const name of [originalName, sanitizePluginImportFileName(originalName)]) {
    const problem = describePluginFileImportProblem({ name, size: bytes.byteLength, accept, maxBytes })
    if (problem) return { ok: false, reason: problem }
  }
  const safeName = sanitizePluginImportFileName(originalName)
  const targetDir = getPluginImportsDir(pluginId)
  try {
    assertNotInNodeModules(getPluginsDir(), targetDir)
    fs.mkdirSync(targetDir, { recursive: true })
  } catch {
    return { ok: false, reason: 'That file could not be saved.' }
  }
  const fileName = nextAvailablePluginImportFileName(
    safeName,
    candidate => fs.existsSync(path.join(targetDir, candidate)),
  )
  if (!fileName) return { ok: false, reason: 'That file could not be saved.' }
  try {
    fs.writeFileSync(path.join(targetDir, fileName), bytes, { flag: 'wx' })
  } catch {
    return { ok: false, reason: 'That file could not be saved.' }
  }
  return {
    ok: true,
    result: {
      path: `${PLUGIN_STORAGE_IMAGE_PREFIX}${PLUGIN_IMPORTS_DIR_NAME}/${fileName}`,
      name: fileName,
      size: bytes.byteLength,
    },
  }
}

/** 客户端交路径时,来访者不是本机可信的那一句(路径是**后端那台机器**上的路径,只有本机来访者说得出)。 */
export const PLUGIN_FILE_PICK_PATH_NEEDS_LOCAL_CLIENT
  = 'That file path can only be used by an app running on this computer.'

/**
 * `plugins.pickFile` 带着客户端选好的文件进来时的那一步(第④步批 4):路径形走 `importPluginFile`、
 * 字节形走 `importPluginFileBytes`,答案折成契约的 `PickPluginFileResponse`。`allowLocalPath` 由 client-api
 * 按本机信任判(这一层不认识来访者)。
 */
export function importClientPickedPluginFile(
  request: PickPluginFileRequest & { file: PickedPluginFile },
  options: { allowLocalPath: boolean },
): PickPluginFileResponse {
  const { file } = request
  const outcome = 'path' in file
    ? options.allowLocalPath
      ? importPluginFile({ pluginId: request.pluginId, sourcePath: file.path, accept: request.accept, maxBytes: request.maxBytes })
      : { ok: false as const, reason: PLUGIN_FILE_PICK_PATH_NEEDS_LOCAL_CLIENT }
    : importPluginFileBytes({
        pluginId: request.pluginId,
        name: file.name,
        bytes: decodeBase64(file.base64),
        accept: request.accept,
        maxBytes: request.maxBytes,
      })
  return outcome.ok ? { ...outcome.result } : { error: outcome.reason }
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string') return new Uint8Array()
  return new Uint8Array(Buffer.from(value, 'base64'))
}

/**
 * `storage:<rel>` 指向的文件在不在。
 *
 * `api.theme.updateBackground({ image })` 的最后一道闸:core 判得了寻址的形状,
 * 判不了文件存不存在(它不吃 fs)。一条指向空气的背景不该被记进内存态 ——
 * 那会让设置页的卡片说"生效中",而屏幕上什么也没有。
 */
export function pluginStorageImageExists(pluginId: string, imageRef: string): boolean {
  const relative = parsePluginStorageImageRef(imageRef)
  if (!relative) return false
  const root = getCorePluginScratchDir(getPluginsDir(), pluginId)
  const target = path.resolve(root, relative)
  // 判据已经拒了穿越,这条是兜底:realpath 之前的字符串前缀复核,与协议那边同规。
  if (target !== root && !target.startsWith(root + path.sep)) return false
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}
