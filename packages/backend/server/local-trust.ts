/**
 * files 域的**本机宿主豁免**单槽端口(2026-08-30 用户拍板的安全语义变更)。
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

const log = getLogger('server.files-trust')

/** 谁声明的 —— 只进日志,不参与判定。 */
export type FilesLocalTrustOrigin = 'desktop-embedded' | 'loopback-server'

export interface FilesLocalTrustDeclaration {
  origin: FilesLocalTrustOrigin
  /** 绑定地址,只为日志好读(桌面内嵌面也有一个)。 */
  host?: string
}

let declaration: FilesLocalTrustDeclaration | null = null

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
export function configureFilesLocalTrust(
  next: FilesLocalTrustDeclaration | null,
): () => void {
  const previous = declaration
  declaration = next
  const forced = isFilesSandboxForcedByEnv()
  if (next && !forced) {
    log.info('files domain: http face is locally trusted (same rights as desktop IPC)', {
      origin: next.origin,
      host: next.host,
    })
  } else if (next && forced) {
    log.info('files domain: local trust declared but ONETHING_SERVER_FILES_SANDBOX forces the sandbox', {
      origin: next.origin,
      host: next.host,
    })
  } else {
    log.info('files domain: http face stays sandboxed', { forcedByEnv: forced })
  }
  return () => {
    if (declaration === next) declaration = previous
  }
}

/** 本次进程的 HTTP 面可不可信 —— files 域唯一的问法。 */
export function isFilesHostLocallyTrusted(): boolean {
  if (isFilesSandboxForcedByEnv()) return false
  return declaration !== null
}

/**
 * 同一件事实的**通名**(08-31 第二个消费者落地时补):「本机 HTTP 面可信」是
 * **面级**声明,不是 files 域私产 —— 第二个消费者是 sessions 域的
 * `updateWorkingDirectory`(React 壳走 http 面,从项目建会话的第二步落目录被
 * 沙箱拒掉,真机账单:会话 71886081,`Working directory must stay inside …` 被
 * 渲染层静默吞)。判据、反悔口(`ONETHING_SERVER_FILES_SANDBOX`)与声明口都
 * 不变;`isFilesHostLocallyTrusted` 保留为 files 域的旧名。其余四个同病域
 * (project-dirs / markdown / permission-grants / tools / evals)仍属另拍。
 */
export function isHostLocallyTrusted(): boolean {
  return isFilesHostLocallyTrusted()
}

/** 测试用:把槽清回未声明。 */
export function resetFilesLocalTrustForTests(): void {
  declaration = null
}
