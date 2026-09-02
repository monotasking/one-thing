import { useMemo } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { createMutation } from '../data/kernel'
import type { Mutation } from '../data/kernel'
import { notify } from '../services/notify'
import { t } from '../i18n'
import type { MessageKey } from '../i18n'
import { spacesPort } from '../data/spaces-port'
import { projectWorkspaces } from './projection'
import {
  DEFAULT_SPACE_ID,
  WORKSPACE_SWATCHES,
  type WorkspaceStatus,
  type WorkspaceSwatch,
  type WorkspaceView,
} from './types'

/**
 * 工作区切换器的**唯一**状态源(v1)。全应用一份:Dock 瓦、⌘⇧W 命令面板、
 * 工作区总览三处都从这里取,不许谁再开第二份 —— 与 data/files-source.ts、
 * data/sessions-source.ts 逐字同一条纪律。
 *
 * 分工:
 *  - 形状与判据(次序 / 色标 / 字标 / 序号键 / 过滤):`workspace/projection.ts` 的纯函数;
 *  - 取数与写回:端口(`data/spaces-port.ts`,后端 spaces 域四条口);
 *  - **写路的生命周期**:下面那只 `workspaceMutation`(`data/kernel` 的 createMutation);
 *  - 唯一碰 DOM 的那一半:`workspace/apply.ts`;
 *  - 画:`workspace/components/*`。
 *
 * ── 「当前工作区」住在哪,为什么 ─────────────────────────────────────────
 * 住在这个 store 的 persist 槽(`onething.workspace`,只存 `currentId` 一格)。
 * 这**不是**降级:契约 `@shared/ipc/spaces.ts` 的文件头写着「后端没有『当前空间』
 * 的概念:currentSpaceId 是 window 级状态,住在渲染层的 localStorage(为
 * 『两窗口开两 space』留路)」。旧 Vue 壳有它自己的一把钥匙
 * (`onething:current-space`),两把钥匙各记各的当前空间 —— 那正是「window 级」
 * 这四个字的字面结果,不是走漏。
 *
 * ── 切换换的是什么(09-01「真切换」批)───────────────────────────────────
 * 08-31 那版这里写着「切换只改这台壳记住的当前工作区,引擎那一侧不随之切换」。
 * 那条留账已经结清 —— 切换现在是**换世界**,而世界由两条机制换:
 *
 *  A. **壳这一侧订这个 store**(`workspace/current.ts` 的 `subscribeCurrentSpace`,
 *     窄读面 + 去重,三个消费者:`data/sessions-source`(列表按空间投影)、
 *     `data/models-source`(可见的家与可列的型)、`providers/store`(凭证池与
 *     provider 设置))。**这个 store 自己不认识那三个消费者** —— 它只把
 *     「当前是哪一个」摆在那儿,谁要谁订。反过来(store 里挨个去叫)会让
 *     切换器认识全应用的数据源,那是这一层最不该背的知识。
 *
 *  B. **引擎那一侧靠会话归属**,不靠「当前空间」——后端从来没有后者这个概念
 *     (见上一段)。新会话在 `sessions.create` 时带上 `workspaceId`,此后凭证
 *     (`resolveSessionProviderCredential(sessionId, …)`)、接入目录
 *     (`getConnectedDirectoriesForSession(sessionId)`)、provider 设置
 *     (`getSessionSettings(sessionId).ai`)、沙箱根、用量归因全由那一格派生。
 *     所以**壳只需要在建会话那一刻说对一次**,不必给每条取数都加参数。
 *
 * 换句话说:A 管「屏幕上看得见的是哪个世界」,B 管「引擎认哪个世界」,
 * 而两者的接缝只有一格 —— 建会话时写下的 `workspaceId`。
 */

/** persist 槽。与 stage / keymap 各自一把钥匙同理:切到哪个工作区是用户的位置,不搭别人的车。 */
const PERSIST_KEY = 'onething.workspace'

/**
 * 读不到列表时的兜底:**至少有一个空间**,界面不必处理「零个空间」。
 * 名字在这一刻翻译一次 —— 断线态下切语言不会重译这一条,那是可接受的:
 * 连得上的时候名字是后端给的真数据,根本不经过这里。
 */
function fallbackSpaces(): SpaceRecord[] {
  return [{ id: DEFAULT_SPACE_ID, name: t('workspace.defaultName'), createdAt: 0 }]
}

/** 删除被拒的三个码 → 一句人话。码是后端给的事实,这里只挑话。 */
const REMOVE_REJECTION: Record<string, MessageKey> = {
  DEFAULT_SPACE: 'workspace.removeDefault',
  NOT_EMPTY: 'workspace.removeNotEmpty',
  NOT_FOUND: 'workspace.removeMissing',
}

/** 四个写口各自那句「没成」。产地只有这一张表 —— 四处各写一遍就是四处会漂。 */
const FAILED_TITLE: Record<WorkspaceWrite['kind'], MessageKey> = {
  create: 'workspace.createFailed',
  rename: 'workspace.renameFailed',
  recolor: 'workspace.recolorFailed',
  remove: 'workspace.removeFailed',
}

/**
 * 新建时挑一个还没被用的色 —— 挑不出(六格用完了)就从头轮。
 * 它只是个**默认值**:建完在总览卡上一点「换色」就能改。
 */
function nextSwatch(spaces: readonly SpaceRecord[]): WorkspaceSwatch {
  const used = new Set(spaces.map((s) => s.color))
  return WORKSPACE_SWATCHES.find((c) => !used.has(c)) ?? WORKSPACE_SWATCHES[spaces.length % WORKSPACE_SWATCHES.length]
}

/**
 * 一次端口往返,**拒绝也是一个答案**。
 *
 * 这一层不是防御性编程,是把两种失败归一:传输层拒绝(没连上 core、404、
 * 超时)与后端答「不成功」对这块界面来说是同一件事 —— 都是「这台机器
 * 此刻给不出工作区」。不归一的话前者会变成一条逃逸的 promise:
 * 08-31 真机上就是这样 —— 浏览器直开(没有 core)时 `list()` 直接 reject,
 * 崩溃捕获弹出一条「Something broke in promise」,而 store 永远停在
 * loading、兜底表一次都没落上,瓦面也就没有字标。
 *
 * 原话原样留在 `error` 里:「404 Not Found」与「space not found」是两句
 * 不同的话,合成一句就没法排障了。
 */
async function call<T extends { success: boolean; error?: string }>(
  run: (port: Awaited<ReturnType<typeof spacesPort>>) => Promise<T>,
  onReject: (message: string) => T,
): Promise<T> {
  try {
    return await run(await spacesPort())
  } catch (err) {
    return onReject(err instanceof Error ? err.message : String(err))
  }
}

/** 写操作的共同收尾:重读列表(后端是唯一事实源,不在本地拼状态)。 */
async function reload(): Promise<void> {
  const response = await call(
    (port) => port.list(),
    (error) => ({ success: false, error }),
  )
  if (response.success && response.spaces) {
    useWorkspaceStore.setState({ spaces: response.spaces, status: 'ready', error: undefined })
    return
  }
  useWorkspaceStore.setState({ spaces: fallbackSpaces(), status: 'error', error: response.error })
}

/** 失败弹出来,不吞。后端原话原样进 detail —— 那是排障唯一的线索。 */
function reportFailure(title: MessageKey, error: string | undefined): false {
  notify({ level: 'error', source: 'workspace', title: t(title), detail: error })
  return false
}

/* ── 写路:一条 mutation,四个格 ──────────────────────────────────────────
 *
 * 从前这里是 state 上一颗全局 `busy` 布尔,四个写口各自 set true/false。
 * 后果是**病型 B(粒度病)**:改 A 的名字,B、C 两张卡上的六颗钮全部禁灰 ——
 * 用户看见的是「改一个名把整面锁住了」,而实际在飞的只有一格。
 *
 * 交互稳定律③要的是**逐格** pending,而「哪一格」这件事只有发起方说得清。
 * 所以写路整只交给 `data/kernel` 的 `createMutation`(与 providers 那一路
 * `settingsMutation` 逐字同形):它按 `key(input)` 分格记账,同一格连点两下
 * 也不会被第一发的收尾提前解禁。
 *
 * **不做乐观更新**:现状就是等后端回话再重读列表,这一批是等价迁移,不借机
 * 改语义。真要上乐观补丁是另一次拍板(名字/颜色可以,新建与删除牵涉列表身份)。
 */

/** 忙态格子的**唯一词表**。store 记账与组件读账共用它 —— 两头各拼一次字符串就是两处会漂。 */
export const workspaceKey = {
  /** 新建只有一颗钮,格子不带 id(那一刻新空间还没有 id)。 */
  create: () => 'create',
  /** 其余三口一张卡一格 —— 律③要的「长在被点的那一个控件上」就是这一格。 */
  rename: (id: string) => `rename:${id}`,
  recolor: (id: string) => `recolor:${id}`,
  remove: (id: string) => `remove:${id}`,
} as const

/** 一次工作区写要带的全部东西。四口一个联合,`kind` 同时是分派与格子的产地。 */
export type WorkspaceWrite =
  | { kind: 'create'; name: string }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'recolor'; id: string; swatch: WorkspaceSwatch }
  | { kind: 'remove'; id: string }

/** 写完之后 settle 要用的那点东西。create 之外三口没有东西要交待。 */
interface WorkspaceWriteDone {
  /** 只有 create 有:新空间的 id。对账落地之后「当前」就挪到它上面。 */
  createdId?: string
}

function keyOf(input: WorkspaceWrite): string {
  return input.kind === 'create' ? workspaceKey.create() : workspaceKey[input.kind](input.id)
}

/**
 * 「后端说没成」抛出来的那一发。
 *
 * 为什么不是一个普通 `new Error(response.error)`:后端原话**可能没有**
 * (`error` 是可选的),而 `Error.message` 会把「没有原话」变成空字符串 ——
 * 那两件事在通知的 detail 里长得不一样(一条没有详情 vs 一条详情是空)。
 * 删除那一路还多一格 `code`(DEFAULT_SPACE / NOT_EMPTY / NOT_FOUND),
 * 它决定弹哪一句人话,塞进 message 里就得再解析出来。两格都原样带着。
 */
class WorkspaceWriteError extends Error {
  /** 后端原话,可能没有 —— 原样带着,这里不编一句。 */
  readonly detail: string | undefined
  /** 删除被拒的码。只有 remove 用得上。 */
  readonly code: string | undefined
  constructor(detail: string | undefined, code?: string) {
    super(detail ?? '')
    this.name = 'WorkspaceWriteError'
    this.detail = detail
    this.code = code
  }
}

/**
 * 最近一次**对账**(settle 里那发 reload)的把手。
 *
 * 为什么需要它:`createMutation` 的 settle 是**不被 await 的** —— 对账是后台
 * 的事,不该把钮多按住一拍(理由写在 kernel 的 `mutation.ts` 里)。但这四个
 * action 的返回值是**有承诺的**:`createWorkspace` 交出 id 之后,调用方下一句
 * 就去屏幕上找那张卡(`WorkspaceOverview.commitCreate` 的 rAF + scrollIntoView),
 * 而「当前」也得已经挪过去。所以两件事各归各位:**钮**的忙态在 settle 之前
 * 解除(律③要的那一拍),**action 自己**多等这一口对账。
 */
let reconcile: Promise<void> | undefined

/*
 * 类型**显式写出来**,不靠推断:这只 mutation 与下面那只 store 互相引用
 * (它读 `getState().spaces` 挑色、写 `setState({ currentId })`;store 的四个
 * action 又调它的 `run`)。运行期没问题(两边都是**调用时**才碰对方),但
 * TS 的推断会绕成一个环 —— 一句注解就把环剪断,比拆结构便宜得多。
 */
export const workspaceMutation: Mutation<WorkspaceWrite, WorkspaceWriteDone> = createMutation<
  WorkspaceWrite,
  WorkspaceWriteDone
>('workspace', {
  key: keyOf,
  run: async (input) => {
    switch (input.kind) {
      case 'create': {
        const response = await call(
          (port) =>
            port.create({ name: input.name, color: nextSwatch(useWorkspaceStore.getState().spaces) }),
          (error) => ({ success: false, error }),
        )
        // 「后端说没成」与「这一发抛了」在这条原语里是同一件事:都得走 onError。
        if (!response.success || !response.space) throw new WorkspaceWriteError(response.error)
        return { createdId: response.space.id }
      }
      case 'rename': {
        const response = await call(
          (port) => port.update({ id: input.id, name: input.name }),
          (error) => ({ success: false, error }),
        )
        if (!response.success) throw new WorkspaceWriteError(response.error)
        return {}
      }
      case 'recolor': {
        const response = await call(
          (port) => port.update({ id: input.id, color: input.swatch }),
          (error) => ({ success: false, error }),
        )
        if (!response.success) throw new WorkspaceWriteError(response.error)
        return {}
      }
      case 'remove': {
        const response = await call(
          (port) => port.remove(input.id),
          (error) => ({ success: false, error }),
        )
        // 拒绝码原样带上去:界面据它说人话,不在这里判第二次。
        if (!response.success) throw new WorkspaceWriteError(response.error, response.code)
        return {}
      }
    }
  },
  settle: (result) => {
    reconcile = (async () => {
      await reload()
      // 建完就切过去:「新建」这个动作的全部语义就是「我要去那儿」。
      // 排在 reload **之后** —— 列表里还没有它的时候把「当前」指过去,
      // `currentSpaceId()` 会当场把它解析成默认空间(见 workspace/current.ts)。
      if (result.createdId) useWorkspaceStore.setState({ currentId: result.createdId })
    })()
  },
  onError: (error, input) => {
    const failure = error instanceof WorkspaceWriteError ? error : undefined
    const reason = failure?.code ? REMOVE_REJECTION[failure.code] : undefined
    // 拒绝码只在删除那一路有意义;其余三口恒走自己那句。
    const title = input.kind === 'remove' ? reason ?? FAILED_TITLE.remove : FAILED_TITLE[input.kind]
    reportFailure(title, failure ? failure.detail : error.message)
  },
})

export interface WorkspaceState {
  spaces: SpaceRecord[]
  status: WorkspaceStatus
  /** 后端原话。归类不在这里 —— 读列表只有「读到 / 读不到」两档。 */
  error?: string
  /** 这台壳记住的当前工作区。见文件头。 */
  currentId: string

  /** 读一次列表。幂等(已经在读就不重入);失败退兜底表并如实标注。 */
  load(): Promise<void>
  /** 切到某个工作区。**这是切换的唯一入口**,三处入口都调它。 */
  switchTo(id: string): void
  /** 建一个并切过去。名字空白 = 不建(调用方负责先问)。回新空间的 id,失败回 null。 */
  createWorkspace(name: string): Promise<string | null>
  rename(id: string, name: string): Promise<boolean>
  recolor(id: string, swatch: WorkspaceSwatch): Promise<boolean>
  /** 删一个。当前那一个不许删(总览上根本不给这一档),默认空间由后端拒。 */
  remove(id: string): Promise<boolean>
  /** 只给测试用:模块级 store 要能在用例之间归零。 */
  reset(): void
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get): WorkspaceState => {
      /** 一次在飞的读。幂等靠它,不靠 status —— status 会被写操作后的重读改。 */
      let loading: Promise<void> | undefined

      return {
        spaces: [],
        status: 'idle',
        error: undefined,
        currentId: DEFAULT_SPACE_ID,

        load: async () => {
          if (loading) return loading
          // 已经读到了就不再读:Dock 与总览各调一次 load,那是两个消费者不是两次刷新。
          // **失败态照样重试** —— 一次读不到不该让这台壳一辈子只剩兜底表。
          // 写操作走的是内部的 reload(),不经过这道闸。
          if (get().status === 'ready') return
          set({ status: 'loading' })
          loading = (async () => {
            // 连不上也照样往下走:reload 自己会把拒绝翻成一句诚实的 error。
            await spacesPort()
              .then((port) => port.ready())
              .catch(() => undefined)
            await reload()
          })().finally(() => {
            loading = undefined
          })
          return loading
        },

        switchTo: (id) => {
          if (get().currentId === id) return
          set({ currentId: id })
        },

        /*
         * 四个写口一个形状:名字先 trim / 该拦的先拦 → 交给 mutation 那一格 →
         * 砸了就照原样回(通知已经在 onError 里发过,这里不再报第二遍,列表也不重拉)
         * → 成了就等这一口对账落地,再把承诺兑现给调用方。
         */
        createWorkspace: async (name) => {
          const trimmed = name.trim()
          if (!trimmed) return null
          const done = await workspaceMutation.run({ kind: 'create', name: trimmed })
          if (!done) return null
          await reconcile
          return done.createdId ?? null
        },

        rename: async (id, name) => {
          const trimmed = name.trim()
          if (!trimmed) return false
          const done = await workspaceMutation.run({ kind: 'rename', id, name: trimmed })
          if (!done) return false
          await reconcile
          return true
        },

        recolor: async (id, swatch) => {
          const done = await workspaceMutation.run({ kind: 'recolor', id, swatch })
          if (!done) return false
          await reconcile
          return true
        },

        remove: async (id) => {
          // 当前那一个不许删 —— 删掉脚下这块地会让「当前」当场变成幽灵。
          if (get().currentId === id) return false
          const done = await workspaceMutation.run({ kind: 'remove', id })
          if (!done) return false
          await reconcile
          return true
        },

        /**
         * 本模块**唯一的那一口拆卸**:读的闸、对账的把手、写路那只 mutation
         * (它自带监听表与逐格计数)连同 store 自己一起归零。
         * 下面的 HMR dispose 复用它,不另写一套。
         */
        reset: () => {
          loading = undefined
          reconcile = undefined
          workspaceMutation.reset()
          set({
            spaces: [],
            status: 'idle',
            error: undefined,
            currentId: DEFAULT_SPACE_ID,
          })
        },
      }
    },
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      // 只存「我在哪」。列表是后端的事实,存了只会在下次开机时先画一屏旧的。
      partialize: (s) => ({ currentId: s.currentId }),
    },
  ),
)

/**
 * **HMR 退役**(09-01 批 1 立的纪律,起因是 chat-source 那一案:热更之后旧模块
 * 的模块级副作用没死,两个实例同时活着)。
 *
 * 这个文件的模块级副作用有两样:写路那只 `workspaceMutation`(监听表 + 逐格
 * 计数)与对账把手 `reconcile`。两样的寿命都是「这个模块实例」,而热更换的
 * 正是模块实例 —— 不退役,旧 mutation 的监听表会攥着已卸载组件的回调。
 *
 * 退役**复用这个模块已有的那一口拆卸**(`reset()`),不写第二套。它自身幂等;
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useWorkspaceStore.getState().reset()
  })
}

/**
 * 屏幕上的那份工作区表。**三个入口都调它** —— 投影只在这里发生一次,
 * 所以「哪个是当前」「⌘2 是谁」在三处逐字同源。
 */
export function useWorkspaceViews(): WorkspaceView[] {
  const spaces = useWorkspaceStore((st) => st.spaces)
  const currentId = useWorkspaceStore((st) => st.currentId)
  return useMemo(() => projectWorkspaces(spaces, currentId), [spaces, currentId])
}
