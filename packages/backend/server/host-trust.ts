/**
 * **本机宿主可信**单槽端口(2026-08-30 用户拍板的安全语义变更;09-03 方案 B2 改名)。
 *
 * ## 改名(B2,`docs/design/backend-transport-forks-2026-09.md` §2.1)
 *
 * 文件原名 `local-trust.ts`、函数原名 `configureFilesLocalTrust` —— 名字里的
 * "files" 是历史,它先为 files 域而生。B2 之后 tools / search / evals / mcp /
 * sessions / files 六个域都问它,所以文件与导出改成**通名**
 * (`configureHostLocalTrust` / `isHostLocallyTrusted` / `hostLocalTrustOrigin` /
 * `resetHostLocalTrustForTests`),旧名在文件末尾保留为 `@deprecated` 别名。
 * 判据、反悔口(`ONETHING_SERVER_FILES_SANDBOX`,环境变量名不动 —— 它是用户
 * 机器上已经在用的开关)与声明口一个字没变。
 *
 * ## 它解决的是什么
 *
 * `rpc/domains/files.ts` 按 `context.transport` 分两种语义:桌面 IPC 不夹路径,
 * 联网 HTTP 每条路径都夹进 `context.sandboxRoot`。这条判据在「联网宿主 = 别人的
 * 机器」的前提下是对的,但它把**本机自己那只 HTTP 面**也一起夹了:桌面内嵌的
 * HTTP/SSE 面(`embed.ts`)与本机回环上的 `server:start` 服务的都是同一个用户、
 * 同一台机器上的同一个 store,却因为走的是 `POST /api/rpc` 而被夹进
 * `<workspaceRoot>/<uid>/<wid>` 那棵空子树 —— 文件树、检索、reveal 对仓内任何
 * 真实路径全被拒。桌面 parity 的既有裁定(server 默认给 `toolRegistry: 'full'`)
 * 到了 files 域这里断了一截。
 *
 * 拍板:**本机可信宿主的 HTTP 面与 IPC 同权**。独立部署(非回环绑定)的 server
 * 护栏原样不动。
 *
 * ## 为什么是「装配时声明」而不是「请求时推断」
 *
 * 「这台 HTTP 面可不可信」是一件**宿主自己知道、请求无从证明**的事:信封里没有
 * 任何字段能用来判断对面是不是同一台机器(`RpcRequest` 不带 context 是刻意的,
 * 身份一律由宿主 mint)。所以豁免只能由装配处声明,和 `configure*Host` 那一族
 * 端口同一个形状:单槽、late-bound(每次现读)、注册返回**还原**函数,好让桌面
 * 内嵌 HTTP 面与 `server:start` 在同一个进程里先后起落时,后者的 shutdown 不会
 * 把前者的声明一起清掉。
 *
 * 谁声明:
 *  - **桌面内嵌 HTTP 面**(`startEmbeddedOnethingHttpServer`)无条件可信 ——
 *    它只服务本机同一个用户,token 写在 0600 的发现文件里。
 *  - **独立 server**(`apps/server/src/main.ts`)**仅当绑定为回环**时可信;
 *    非回环绑定一律不声明,护栏原样。
 *
 * ## 反悔口
 *
 * `ONETHING_SERVER_FILES_SANDBOX=1` 强制收紧:即便声明了可信也照夹。给想在本机
 * 也保留护栏的人留的手,**每次查询现读**,所以它压得住任何声明。
 *
 * 未声明 = 这台进程没有本机可信的 HTTP 面(单元测试、CLI daemon、非回环 server),
 * files 域走的就是迁移前那条夹紧的路。
 */
import { getLogger } from '../wiring/logging/index.js'

const log = getLogger('server.host-trust')

/**
 * 谁声明的。
 *
 * B2 之前只进日志、不参与判定;B2 起有**一个**判据读它:mcp 域的 stdio probe
 * (`canSpawnLocalProcesses`)只认 `desktop-embedded`。见 `rpc/domains/mcp.ts`。
 */
export type HostLocalTrustOrigin = 'desktop-embedded' | 'loopback-server'

export interface HostLocalTrustDeclaration {
  origin: HostLocalTrustOrigin
  /** 绑定地址,只为日志好读(桌面内嵌面也有一个)。 */
  host?: string
}

let declaration: HostLocalTrustDeclaration | null = null

/** `ONETHING_SERVER_FILES_SANDBOX` 的真值口径 —— 与仓里其它开关逐字同义。 */
function truthyEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').toLowerCase())
}

/** 强制收紧开关(每次现读:它必须压得住已经落下的声明)。 */
export function isFilesSandboxForcedByEnv(): boolean {
  return truthyEnv(process.env.ONETHING_SERVER_FILES_SANDBOX)
}

/**
 * 装配时声明本机可信(传 `null` = 明确声明不可信,只为让启动日志有一行现状)。
 * 返回**还原**函数。
 */
export function configureHostLocalTrust(
  next: HostLocalTrustDeclaration | null,
): () => void {
  const previous = declaration
  declaration = next
  const forced = isFilesSandboxForcedByEnv()
  if (next && !forced) {
    log.info('host trust: http face is locally trusted (same rights as desktop IPC)', {
      origin: next.origin,
      host: next.host,
    })
  } else if (next && forced) {
    log.info('host trust: declared but ONETHING_SERVER_FILES_SANDBOX forces the sandbox', {
      origin: next.origin,
      host: next.host,
    })
  } else {
    log.info('host trust: http face stays sandboxed', { forcedByEnv: forced })
  }
  return () => {
    if (declaration === next) declaration = previous
  }
}

/**
 * 这台进程的宿主面可不可信 —— B2 之后六个域共用的那一问。
 *
 * 「本机 HTTP 面可信」是**面级**声明,不是某个域的私产:08-31 第二个消费者是
 * sessions 域的 `updateWorkingDirectory`(React 壳走 http 面,从项目建会话的第二
 * 步落目录被沙箱拒掉,真机账单:会话 71886081,`Working directory must stay
 * inside …` 被渲染层静默吞);09-03 的 B2 又把 tools / search / evals / mcp 接上
 * 同一问。判据、反悔口与声明口一个字没变。
 */
export function isHostLocallyTrusted(): boolean {
  if (isFilesSandboxForcedByEnv()) return false
  return declaration !== null
}

/**
 * 可信是**谁**声明的(不可信时 `null`)。
 *
 * 只给需要在两种可信之间再分一档的判据用 —— 今天唯一一个是 mcp 域的 stdio
 * probe:替调用方**起本机进程**这件事只对桌面内嵌面开,回环 `server:start` 仍
 * 由 `ONETHING_SERVER_MCP_STDIO` 决定(方案 §4 那一行「请拍板」的保守取值)。
 * 环境变量强制收紧时与 `isHostLocallyTrusted()` 同进同退,回 `null`。
 */
export function hostLocalTrustOrigin(): HostLocalTrustOrigin | null {
  if (isFilesSandboxForcedByEnv()) return null
  return declaration?.origin ?? null
}

/** 测试用:把槽清回未声明。 */
export function resetHostLocalTrustForTests(): void {
  declaration = null
}

// ── 旧名(B2 改名前的口径,逐字同义)────────────────────────────────
// 留着是为了不把「改名」和「改语义」搅在一批里;新代码一律用上面的通名。

/** @deprecated 改用 {@link HostLocalTrustOrigin}。 */
export type FilesLocalTrustOrigin = HostLocalTrustOrigin
/** @deprecated 改用 {@link HostLocalTrustDeclaration}。 */
export type FilesLocalTrustDeclaration = HostLocalTrustDeclaration
/** @deprecated 改用 {@link configureHostLocalTrust}。 */
export const configureFilesLocalTrust = configureHostLocalTrust
/** @deprecated 改用 {@link isHostLocallyTrusted}。 */
export const isFilesHostLocallyTrusted = isHostLocallyTrusted
/** @deprecated 改用 {@link resetHostLocalTrustForTests}。 */
export const resetFilesLocalTrustForTests = resetHostLocalTrustForTests
