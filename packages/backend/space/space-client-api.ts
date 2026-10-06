/**
 * space(工作空间)域 —— 结构债 P0.3 / P4a 的第一个模板域。
 *
 * 替换 `apps/electron/src/ipc/spaces.ts`(已删)、
 * `apps/electron/src/ipc/spaces-controller.ts`(已删)与
 * `apps/electron/src/main/ipc/spaces.ts` 里调 `registerHostSpacesHandlers` 的那一半
 * (该文件只剩 `SPACES_CHANGED` 广播订阅);渲染侧的 13 个 `platformApi.spacesXxx`
 * 方法与 `packages/renderer/platform/web.ts` 里那批 `/api/spaces*` soft-fail 桩
 * 一起删掉 —— **server 侧零改动**:域挂上 router 之后就经 `POST /api/rpc` 自动可达,
 * 不需要任何一条手写 REST 路由。
 *
 * 这里只做一件事:**把依赖递给 runtime 的 `*ForIpc` 一族**。所有判定 ——
 * 默认空间不许删、只删空的、只对**已登记**的空间开放 overlay/providers/credentials、
 * 默认空间不许「从默认空间导入」—— 全在
 * `packages/backend/space/space-ipc-operations.ts` 里,传输面不许自己加分支。
 * 搬家时逐条对着旧文件抄的也正是这些注入点:
 *  - `removeSpace` 的占用统计吃 `countSessionsInWorkspace`(spaces store 不认识会话);
 *  - `hasSpace` 一律是 `getSpacesStore().list()` 的存在性判定 —— 否则一个手滑的 id
 *    会在 `workspaces/` 下长出一个没有主人的目录;
 *  - `getSpaceProviderSettings` 读不到文件时给**空设置**(无回落),不是全局那份。
 *
 * 不在这条路上的:`IPC_CHANNELS.SPACES_CHANGED` 广播。router 今天只有请求/响应面,
 * 没有推送面,所以那条通道原样留在手写 IPC 上(`@main/ipc/spaces.ts`)。
 */
import type { RouteHandlers } from '@shared/ipc/router'
import { spacesRouter, type SpacesRoutes } from '@shared/ipc/spaces.js'
import {
  clearOnethingSpaceCredentialForIpc,
  createOnethingSpaceForIpc,
  getOnethingSpaceCredentialsForIpc,
  getOnethingSpaceOverlayForIpc,
  getOnethingSpaceProviderSettingsForIpc,
  importOnethingSpaceCredentialsForIpc,
  listOnethingSpacesForIpc,
  removeOnethingSpaceForIpc,
  setOnethingSpaceCredentialForIpc,
  setOnethingSpaceCredentialPoolForIpc,
  setOnethingSpaceOverlayForIpc,
  setOnethingSpaceProviderSettingsForIpc,
  updateOnethingSpaceForIpc,
} from './space-ipc-operations.js'
import { readSpaceOverlay, writeSpaceOverlay } from '@onething/backend/space/space-overlay'
import {
  createEmptySpaceProviderSettings,
  readSpaceProviderSettings,
  writeSpaceProviderSettings,
  type SpaceProviderSettings as RuntimeSpaceProviderSettings,
} from '@onething/backend/space/space-provider-settings'
import { getSpacesStore } from '@onething/backend/space/space-store'
import { DEFAULT_SPACE_ID } from '@onething/backend/space/space-types'
import {
  clearSpaceProviderCredential,
  credentialsReady,
  credentialsStatus,
  CredentialsExportFailure,
  exportCredentialsWithPassphrase,
  getSpaceCredentialsSummary,
  importCredentialsWithPassphrase,
  importDefaultSpaceCredentials,
  prepareCredentialsWrite,
  setSpaceProviderCredential,
  setSpaceProviderCredentialPoolForRequest,
  unlockCredentials,
} from '@onething/backend/credentials'
import { isHostLocallyTrusted } from '@onething/backend/http-server/http-server-host-trust.js'
import { countSessionsInWorkspace } from '@onething/backend/session'
import { persistManualOrphans } from '@onething/backend/settings'
import { getCurrentBackendInstance } from '@onething/backend/backend-current.js'
import { defineClientApi } from '@onething/backend/http-server/http-server-dispatch-table.js'

/** 已登记判定。每个带 id 的方法都过这一关 —— 见文件头。 */
function hasSpace(id: string): boolean {
  return getSpacesStore().list().some(space => space.id === id)
}

/** 默认空间 + 名录里的全部空间(导出按这份清单走)。 */
function allSpaceIds(): string[] {
  return [...new Set([DEFAULT_SPACE_ID, ...getSpacesStore().list().map(space => space.id)])]
}

/**
 * 凭证写之前那一步(第④步批 0):新装时现造主密钥、钥匙丢了时换一把;此刻写不了就答
 * `CREDENTIALS_LOCKED` + 原因码,不抛到传输面。
 */
async function withCredentialsWritable<T extends { success: boolean }>(
  run: () => T | Promise<T>,
): Promise<T | { success: false; error: string; code: string }> {
  try {
    await prepareCredentialsWrite()
  } catch (error) {
    return lockedResult(error)
  }
  return run()
}

function lockedResult(error: unknown): { success: false; error: string; code: string } {
  const reason = (error as { reason?: unknown })?.reason
  if ((error as { code?: unknown })?.code === 'CREDENTIALS_LOCKED' && typeof reason === 'string') {
    return { success: false, error: reason, code: 'CREDENTIALS_LOCKED' }
  }
  return { success: false, error: error instanceof Error ? error.message : String(error), code: 'INTERNAL' }
}

/** 导出 / 导入的口令错、文件不对,答成码。 */
function exportFailureCode(error: unknown): string | null {
  if (!(error instanceof CredentialsExportFailure)) return null
  if (error.reason === 'wrong-passphrase') return 'WRONG_PASSPHRASE'
  if (error.reason === 'not-an-export') return 'NOT_AN_EXPORT'
  return 'EMPTY_PASSPHRASE'
}

export const spacesRpcHandlers: RouteHandlers<SpacesRoutes> = {
  async list() {
    return listOnethingSpacesForIpc({ listSpaces: () => getSpacesStore().list() })
  },
  async create(request) {
    return createOnethingSpaceForIpc({
      request,
      createSpace: input => getSpacesStore().create(input),
    })
  },
  async update(request) {
    return updateOnethingSpaceForIpc({
      request,
      updateSpace: (id, patch) => getSpacesStore().update(id, patch),
    })
  },
  async remove(request) {
    return removeOnethingSpaceForIpc({
      request,
      // 「只删空的」的占用统计:spaces store 不认识会话,由这里注入。
      countSessions: spaceId => countSessionsInWorkspace(spaceId),
      removeSpace: (id, opts) => getSpacesStore().remove(id, opts),
    })
  },
  // overlay 落在 `workspaces/<id>/space.json`,只对**已登记**的空间开放 ——
  // 否则一个手滑的 id 会在 workspaces/ 下长出一个没有主人的目录。
  async getOverlay(request) {
    return getOnethingSpaceOverlayForIpc({
      request,
      hasSpace,
      readOverlay: id => readSpaceOverlay(id),
    })
  },
  async setOverlay(request) {
    return setOnethingSpaceOverlayForIpc({
      request,
      hasSpace,
      writeOverlay: (id, overlay) => writeSpaceOverlay(id, overlay),
    })
  },
  // 整套 provider 设置(C2):`workspaces/<id>/providers.json`。与 overlay 同
  // 一条纪律 —— 只对**已登记**的空间开放。缺文件 = 这个空间还是空的(无回落)。
  //
  // 两个 `ai` 上的强制转换是**有意的**,不是图省事:`providers.json` 的内容对
  // 存储层**故意不透明**(runtime 那边是 `Record<string, unknown>` —— 加一个
  // provider 字段不该逼存储层跟着改),而契约层给渲染侧的是有名字的
  // `ProviderConfig`。两者是同一份 JSON 的两种看法,转换点只有这一处;从前那条
  // 手写通道是靠 controller 上的 `unknown` 把它藏起来的,现在把它写在明面上。
  async getProviderSettings(request) {
    const result = getOnethingSpaceProviderSettingsForIpc({
      request,
      hasSpace,
      readProviderSettings: id => readSpaceProviderSettings(id) ?? createEmptySpaceProviderSettings(),
    })
    return result as SpacesRoutes['getProviderSettings']['output']
  },
  async setProviderSettings(request) {
    // 写前那一份先捕获:手填模型的老孤儿(勾了但目录没有)要按「写前 ∪ 写后」折 ——
    // 取消勾选一个老孤儿,写后那一份里已经没有它了(批 2,见 settings/settings-manual-model-store.ts)。
    const previous = hasSpace(request.id) ? readSpaceProviderSettings(request.id) : null
    const result = setOnethingSpaceProviderSettingsForIpc({
      request: { id: request.id, ai: request.ai as unknown as RuntimeSpaceProviderSettings },
      hasSpace,
      writeProviderSettings: (id, ai) => writeSpaceProviderSettings(id, ai),
    })
    if (result.success) persistManualOrphans(previous, request.ai as unknown as RuntimeSpaceProviderSettings)
    // 自定义服务商的增删改在这条写路上,不发 `settings:changed` —— manifest 注册表在这里对齐(批 M)。
    if (result.success) getCurrentBackendInstance()?.providerManifests?.sync()
    return result as SpacesRoutes['setProviderSettings']['output']
  },
  // provider 凭证池(批 B3;C1 起 default 也走这条)。唯一还挡着默认空间的
  // 是「导入」—— 它就是导入的来源,导给自己是句废话。
  async getCredentials(request) {
    // 钥匙串那一档的钥匙可能还在读;读完再答,免得把「还在读」答成「什么都没配」。
    await credentialsReady()
    return getOnethingSpaceCredentialsForIpc({
      request,
      hasSpace,
      readCredentials: id => getSpaceCredentialsSummary(id),
    })
  },
  async setCredential(request) {
    return withCredentialsWritable(() => setOnethingSpaceCredentialForIpc({
      request,
      hasSpace,
      writeCredential: input => setSpaceProviderCredential(input),
    }))
  },
  // 整池写(批 D):排序 + 删除 + 策略。密钥原文走上面那条 setCredential。
  async setCredentialPool(request) {
    return withCredentialsWritable(() => setOnethingSpaceCredentialPoolForIpc({
      request,
      hasSpace,
      writePool: input => setSpaceProviderCredentialPoolForRequest(input),
    }))
  },
  async clearCredential(request) {
    return withCredentialsWritable(() => clearOnethingSpaceCredentialForIpc({
      request,
      hasSpace,
      clearCredential: input => clearSpaceProviderCredential(input),
    }))
  },
  async importCredentials(request) {
    return withCredentialsWritable(() => importOnethingSpaceCredentialsForIpc({
      request,
      hasSpace,
      isDefaultSpace: id => id === DEFAULT_SPACE_ID,
      importCredentials: id => importDefaultSpaceCredentials(id),
    }))
  },
  // ── 凭证的钥匙与锁定状态、口令导出 / 导入(第④步批 0)──────────────────────────
  async credentialsStatus() {
    return { success: true, status: credentialsStatus() }
  },
  async unlockCredentials() {
    return { success: true, status: await unlockCredentials() }
  },
  /**
   * 导出交出去的是密文,但口令是调用方自己定的 —— 拿到文件的人就拿到了全部凭证。所以只给本机信任的
   * 来访者(桌面、回环 server),与「替调用方起本机进程」同一档判据。
   */
  async exportCredentials(request) {
    if (!isHostLocallyTrusted()) return { success: false, error: 'not available on this host', code: 'NOT_TRUSTED' }
    if (!request.passphrase) return { success: false, error: 'empty-passphrase', code: 'EMPTY_PASSPHRASE' }
    await credentialsReady()
    const status = credentialsStatus()
    // 锁着时读到的是空池;导出一份空文件只会让人以为备份过了。
    if (status.state !== 'ready') {
      return { success: false, error: status.reason ?? status.state, code: 'CREDENTIALS_LOCKED' }
    }
    try {
      const exported = await exportCredentialsWithPassphrase(request.passphrase, allSpaceIds())
      return { success: true, fileName: exported.fileName, data: exported.data, entries: exported.entries }
    } catch (error) {
      const code = exportFailureCode(error)
      return code ? { success: false, error: code, code } : lockedResult(error)
    }
  },
  async importExportedCredentials(request) {
    if (!isHostLocallyTrusted()) return { success: false, error: 'not available on this host', code: 'NOT_TRUSTED' }
    if (!request.passphrase) return { success: false, error: 'empty-passphrase', code: 'EMPTY_PASSPHRASE' }
    try {
      await prepareCredentialsWrite()
      const result = await importCredentialsWithPassphrase(request.passphrase, request.data, hasSpace)
      return { success: true, imported: result.imported, skippedSpaces: result.skippedSpaces }
    } catch (error) {
      const code = exportFailureCode(error)
      return code ? { success: false, error: code, code } : lockedResult(error)
    }
  },
}


/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `spaces` 的契约与处理者。 */
export const SPACES_CLIENT_API = defineClientApi({ id: 'rpc:spaces', router: spacesRouter, handlers: spacesRpcHandlers })
