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
 * `packages/onething-runtime/src/spaces/ipc-operations.ts` 里,传输面不许自己加分支。
 * 搬家时逐条对着旧文件抄的也正是这些注入点:
 *  - `removeSpace` 的占用统计吃 `countSessionsInWorkspace`(spaces store 不认识会话);
 *  - `hasSpace` 一律是 `getSpacesStore().list()` 的存在性判定 —— 否则一个手滑的 id
 *    会在 `workspaces/` 下长出一个没有主人的目录;
 *  - `getSpaceProviderSettings` 读不到文件时给**空设置**(无回落),不是全局那份。
 *
 * 不在这条路上的:`IPC_CHANNELS.SPACES_CHANGED` 广播。router 今天只有请求/响应面,
 * 没有推送面,所以那条通道原样留在手写 IPC 上(`@main/ipc/spaces.ts`)。
 */
import type { RouteHandlers } from '@onething/core/ipc'
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
} from '@onething/runtime/spaces'
import { readSpaceOverlay, writeSpaceOverlay } from '@onething/runtime/spaces/overlay'
import {
  createEmptySpaceProviderSettings,
  readSpaceProviderSettings,
  writeSpaceProviderSettings,
  type SpaceProviderSettings as RuntimeSpaceProviderSettings,
} from '@onething/runtime/spaces/provider-settings'
import { getSpacesStore } from '@onething/runtime/spaces/store'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import {
  clearSpaceProviderCredential,
  getSpaceCredentialsSummary,
  importDefaultSpaceCredentials,
  setSpaceProviderCredential,
  setSpaceProviderCredentialPoolForRequest,
} from '../../wiring/providers/space-credentials.js'
import { countSessionsInWorkspace } from '../../stores/sessions.js'
import { registerRouterHandlers } from '../registry.js'

/** 已登记判定。每个带 id 的方法都过这一关 —— 见文件头。 */
function hasSpace(id: string): boolean {
  return getSpacesStore().list().some(space => space.id === id)
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
    const result = setOnethingSpaceProviderSettingsForIpc({
      request: { id: request.id, ai: request.ai as unknown as RuntimeSpaceProviderSettings },
      hasSpace,
      writeProviderSettings: (id, ai) => writeSpaceProviderSettings(id, ai),
    })
    return result as SpacesRoutes['setProviderSettings']['output']
  },
  // provider 凭证池(批 B3;C1 起 default 也走这条)。唯一还挡着默认空间的
  // 是「导入」—— 它就是导入的来源,导给自己是句废话。
  async getCredentials(request) {
    return getOnethingSpaceCredentialsForIpc({
      request,
      hasSpace,
      readCredentials: id => getSpaceCredentialsSummary(id),
    })
  },
  async setCredential(request) {
    return setOnethingSpaceCredentialForIpc({
      request,
      hasSpace,
      writeCredential: input => setSpaceProviderCredential(input),
    })
  },
  // 整池写(批 D):排序 + 删除 + 策略。密钥原文走上面那条 setCredential。
  async setCredentialPool(request) {
    return setOnethingSpaceCredentialPoolForIpc({
      request,
      hasSpace,
      writePool: input => setSpaceProviderCredentialPoolForRequest(input),
    })
  },
  async clearCredential(request) {
    return clearOnethingSpaceCredentialForIpc({
      request,
      hasSpace,
      clearCredential: input => clearSpaceProviderCredential(input),
    })
  },
  async importCredentials(request) {
    return importOnethingSpaceCredentialsForIpc({
      request,
      hasSpace,
      isDefaultSpace: id => id === DEFAULT_SPACE_ID,
      importCredentials: id => importDefaultSpaceCredentials(id),
    })
  },
}

export function registerSpacesRpcDomain(): () => void {
  return registerRouterHandlers(spacesRouter, spacesRpcHandlers)
}
