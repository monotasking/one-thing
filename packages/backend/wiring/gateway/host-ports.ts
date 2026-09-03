/**
 * IM 网关生命周期的**宿主注入端口** —— 结构债 P4c 第八批。
 *
 * gateway 的八条数据面已经迁到通用 RPC 通道(`gatewayRouter` +
 * `backend/rpc/domains/gateway.ts`),而这八件事全都要**宿主本体**:微信网关是
 * 一个由桌面主进程拉起来的子进程 + 一张二维码的生命周期,只有 Electron 桌面
 * 做得到(Electron 宿主的 gateway/lifecycle 那套原语)。server / CLI 守护进程
 * 没有这套东西。
 *
 * 判例照 `runtime/src/shell/host-ports.ts` 与 `runtime/src/auth/host-ports.ts`:
 * **零依赖**(本文件只 import `@shared/ipc/gateway.js` 的类型)、**late-bound**
 * (每次调用现读,宿主接线晚于模块求值也照样生效)、**未注入即结构化降级**
 * 而不是抛错 —— 没有宿主的进程里「拉起微信网关」是一件做不到的事,不是 bug。
 *
 * ## 为什么放 backend/wiring 而不是 runtime
 *
 * 端口的形状**就是** `@shared/ipc/gateway.js` 上那八对请求/响应类型,而产品层
 * (`packages/onething-runtime`)是禁 `@shared/ipc` 的(只有 `*.wiring.ts` 例外)。
 * gateway 域在装配层本来就有住处(`backend/channel/`、`backend/wiring/`),把端口
 * 放这里既不需要给产品层开一个 `.wiring.ts` 的口子,也不用把八对类型再抄一份。
 * 对比 `shell/host-ports.ts` 放在产品层,是因为它的形状(`openPath` /
 * `openExternal` / `revealPath`)与任何契约类型都无关。
 *
 * ## 本域零推送
 *
 * 全仓没有 `GATEWAY_*_CHANGED` 一类的通道 —— 状态靠调用方在每次操作后重新
 * `getStatus()`(`ChannelsSettingsTab.vue` 的 `runGatewayAction` 就是这么写的)。
 * 所以这一批只有请求端口,没有像 oauth 那样的广播端口。
 */
import type {
  GatewayGetStatusResponse,
  GatewayStartRequest,
  GatewayStartResponse,
  GatewayStatus,
  GatewayStopResponse,
  GatewayWechatAccountStatus,
  GatewayWechatAddAccountRequest,
  GatewayWechatAddAccountResponse,
  GatewayWechatLogoutRequest,
  GatewayWechatLogoutResponse,
  GatewayWechatRemoveAccountRequest,
  GatewayWechatRemoveAccountResponse,
  GatewayWechatRenameAccountRequest,
  GatewayWechatRenameAccountResponse,
  GatewayWechatStopAccountRequest,
  GatewayWechatStopAccountResponse,
} from '@shared/ipc/gateway.js'
import type { AppSettings } from '@shared/ipc/settings.js'

/** 未注入宿主时给出的统一原因串。调用点按它分支毫无意义 —— 它只用来说人话。 */
export const GATEWAY_HOST_UNAVAILABLE
  = 'Gateway connections are not available in this runtime.'

type MaybePromise<T> = T | Promise<T>

/** 两条「顺带交回一个账号」的操作的原始返回。 */
export interface GatewayHostAccountResult {
  status: GatewayStatus
  account?: GatewayWechatAccountStatus
}

/**
 * 宿主可以贡献的八件事。全都可选:给一件就有一件,不给的那件降级。
 *
 * 签名收的是**生命周期原语的原始形状**(`GatewayStatus` / `{status, account?}`),
 * 不是契约上的 `{success, status, error}` 信封 —— 于是桌面那边的注入是八行
 * 转调、零翻译层,宿主 gateway/lifecycle 的导出直接贴上去。
 * 「成功包信封 / 抛错折成 `{success:false,error}`」这件事是**契约的事**,由本文件
 * 的门面统一做(从前它住在被删掉的 `apps/electron/src/ipc/gateway.ts` 工厂里,
 * 只有 Electron 那条线有 —— server 那条线各写各的)。
 */
export interface GatewayHostPorts {
  getStatus?(): MaybePromise<GatewayStatus>
  start?(request?: GatewayStartRequest): MaybePromise<GatewayStatus>
  stop?(): MaybePromise<GatewayStatus>
  wechatLogout?(request?: GatewayWechatLogoutRequest): MaybePromise<GatewayStatus>
  wechatAddAccount?(
    request?: GatewayWechatAddAccountRequest,
  ): MaybePromise<GatewayHostAccountResult>
  wechatStopAccount?(request: GatewayWechatStopAccountRequest): MaybePromise<GatewayStatus>
  wechatRemoveAccount?(request: GatewayWechatRemoveAccountRequest): MaybePromise<GatewayStatus>
  wechatRenameAccount?(
    request: GatewayWechatRenameAccountRequest,
  ): MaybePromise<GatewayHostAccountResult>
  /**
   * 设置存盘之后把网关那一段套用上去(P4c 第十一批)。
   *
   * 它跟着 `settingsRouter.saveSettings` 从 `@main/ipc/settings.ts` 搬过来 ——
   * 「按新设置起停微信网关」与上面八件事是同一台生命周期机器,不值得为它另立
   * 一张端口表。**未注入 = 这台进程没有网关**,安静跳过(不是失败)。
   */
  applySettings?(settings: AppSettings): MaybePromise<void>
}

/** 永远可调用的门面 —— 未注入时八件事都是结构化失败。 */
export interface GatewayHost {
  getStatus(): Promise<GatewayGetStatusResponse>
  start(request?: GatewayStartRequest): Promise<GatewayStartResponse>
  stop(): Promise<GatewayStopResponse>
  wechatLogout(request?: GatewayWechatLogoutRequest): Promise<GatewayWechatLogoutResponse>
  wechatAddAccount(
    request?: GatewayWechatAddAccountRequest,
  ): Promise<GatewayWechatAddAccountResponse>
  wechatStopAccount(
    request: GatewayWechatStopAccountRequest,
  ): Promise<GatewayWechatStopAccountResponse>
  wechatRemoveAccount(
    request: GatewayWechatRemoveAccountRequest,
  ): Promise<GatewayWechatRemoveAccountResponse>
  wechatRenameAccount(
    request: GatewayWechatRenameAccountRequest,
  ): Promise<GatewayWechatRenameAccountResponse>
  /** 设置存盘后的套用。没有网关能力时是安静的 no-op —— 调用方不必分支。 */
  applySettings(settings: AppSettings): Promise<void>
}

let hostPorts: GatewayHostPorts = {}

export function configureGatewayHost(ports: GatewayHostPorts): void {
  hostPorts = ports
}

/**
 * 还原到**未注入**态(C0 R6)。`applyHostPorts` 的还原函数逆序调它,于是
 * `backend.dispose()` 之后这个进程回到"没有宿主声明过这件能力"。
 */
export function resetGatewayHost(): void {
  hostPorts = {}
}

/** 当前注入的原始端口。串联/诊断用;日常调用请走 `getGatewayHost()`。 */
export function getGatewayHostPorts(): GatewayHostPorts {
  return hostPorts
}

/** 宿主到底有没有网关能力(UI 据此决定要不要画那些按钮)。 */
export function hasGatewayHost(): boolean {
  return typeof hostPorts.getStatus === 'function'
}

/**
 * 状态型操作的信封 —— 逐字沿用被删掉的那只 IPC 工厂的 `toResponse`:
 * 成功 = `{ success:true, status }`,抛错 = `{ success:false, error }`。
 * 未注入 = 同一个失败形状,**不带 status**(没有网关就没有状态可报)。
 */
async function envelope(
  port: (() => MaybePromise<GatewayStatus>) | undefined,
): Promise<{ success: boolean; status?: GatewayStatus; error?: string }> {
  if (!port) return { success: false, error: GATEWAY_HOST_UNAVAILABLE }
  try {
    return { success: true, status: await port() }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 「顺带交回一个账号」那两条的信封 —— 旧工厂的 `toObjectResponse`。 */
async function accountEnvelope(
  port: (() => MaybePromise<GatewayHostAccountResult>) | undefined,
): Promise<{
  success: boolean
  status?: GatewayStatus
  account?: GatewayWechatAccountStatus
  error?: string
}> {
  if (!port) return { success: false, error: GATEWAY_HOST_UNAVAILABLE }
  try {
    return { success: true, ...(await port()) }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 门面对象是**常量**,八个方法每次调用现读 `hostPorts` —— 所以谁先谁后都不影响:
 * 模块求值期拿到的这一个对象,在宿主 `configureGatewayHost` 之后自动变得有能力。
 */
const gatewayHost: GatewayHost = {
  getStatus: () => envelope(hostPorts.getStatus?.bind(hostPorts)),
  start: request => envelope(
    hostPorts.start ? () => hostPorts.start!(request) : undefined,
  ),
  stop: () => envelope(hostPorts.stop?.bind(hostPorts)),
  wechatLogout: request => envelope(
    hostPorts.wechatLogout ? () => hostPorts.wechatLogout!(request) : undefined,
  ),
  wechatAddAccount: request => accountEnvelope(
    hostPorts.wechatAddAccount ? () => hostPorts.wechatAddAccount!(request) : undefined,
  ),
  wechatStopAccount: request => envelope(
    hostPorts.wechatStopAccount ? () => hostPorts.wechatStopAccount!(request) : undefined,
  ),
  wechatRemoveAccount: request => envelope(
    hostPorts.wechatRemoveAccount ? () => hostPorts.wechatRemoveAccount!(request) : undefined,
  ),
  wechatRenameAccount: request => accountEnvelope(
    hostPorts.wechatRenameAccount ? () => hostPorts.wechatRenameAccount!(request) : undefined,
  ),
  applySettings: async settings => {
    await hostPorts.applySettings?.(settings)
  },
}

export function getGatewayHost(): GatewayHost {
  return gatewayHost
}
