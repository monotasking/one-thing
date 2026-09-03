import { spacesRouter } from '@shared/ipc/spaces'
import type {
  SpacesCreateRequest,
  SpacesCreateResponse,
  SpacesListResponse,
  SpacesRemoveResponse,
  SpacesUpdateRequest,
  SpacesUpdateResponse,
} from '@shared/ipc/spaces'

/**
 * 工作区(space)取数与 core 的客户端(`@onething/client`)之间的那一层**端口** —— 与
 * `data/files-port.ts` / `data/sessions-port.ts` 同一形状、同一理由:
 * 切换器的全部判据(排序、字标、色标、序号键、过滤)都是纯逻辑,
 * 不该为了测它去起一台 core。真实现是下面那一个,测试用 `configureSpacesPort`
 * 换成假的。
 *
 * ── 形状 = 契约的**四条**,不是十三条 ─────────────────────────────────────
 * `@shared/ipc/spaces.ts` 的 router 有十三个动词。这里只开四条:
 * `list` / `create` / `update` / `remove`。另外九条(overlay / providerSettings /
 * credentials 六条 / importCredentials)是**空间里装什么**,不是**有哪些空间** ——
 * 切换器管的是后者。凭证池与 provider 设置随空间走那件事属后端批,见
 * `workspace/store.ts` 文件头的留账。
 *
 * ── 「当前空间」为什么不在这个端口上 ─────────────────────────────────────
 * 因为后端**没有这个概念**,不是因为本批没接。契约原话(`@shared/ipc/spaces.ts`
 * 文件头):「后端没有『当前空间』的概念:currentSpaceId 是 window 级状态,
 * 住在渲染层的 localStorage(为『两窗口开两 space』留路)。所以每个操作都显式带 id。」
 * 于是它住在 `workspace/store.ts` 的 persist 槽里 —— 那是照契约办事,不是降级。
 */
export interface SpacesPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  list(): Promise<SpacesListResponse>
  create(request: SpacesCreateRequest): Promise<SpacesCreateResponse>
  update(request: SpacesUpdateRequest): Promise<SpacesUpdateResponse>
  /**
   * 删一个空间。后端会拒:`DEFAULT_SPACE`(默认空间)/ `NOT_EMPTY`(还有会话)/
   * `NOT_FOUND`。拒绝码原样回上来 —— 界面据此说人话,不自己再判一次。
   */
  remove(id: string): Promise<SpacesRemoveResponse>
}

let port: SpacesPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureSpacesPort(next: SpacesPort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 files-port / sessions-port 逐字相同:它要的是
 * 那个连通之后才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来
 * (默认假端口装在 `src/test/setup.ts` 里)。
 */
async function realPort(): Promise<SpacesPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const spacesApi = client.api(spacesRouter)
  return {
    ready: () => whenConnected(),
    list: () => spacesApi.list({}),
    create: (request) => spacesApi.create(request),
    update: (request) => spacesApi.update(request),
    remove: (id) => spacesApi.remove({ id }),
  }
}

let pending: Promise<SpacesPort> | undefined

export function spacesPort(): Promise<SpacesPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
