import { useMemo } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SpaceRecord } from '@shared/ipc/spaces'
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
 * 工作区切换器的**唯一**状态源(v1)。全应用一份:Dock 瓦、⌘⇧O 命令面板、
 * 工作区总览三处都从这里取,不许谁再开第二份 —— 与 data/files-source.ts、
 * data/sessions-source.ts 逐字同一条纪律。
 *
 * 分工:
 *  - 形状与判据(次序 / 色标 / 字标 / 序号键 / 过滤):`workspace/projection.ts` 的纯函数;
 *  - 取数与写回:端口(`data/spaces-port.ts`,后端 spaces 域四条口);
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
 * ── 留账:切换今天改变了什么,没改变什么 ─────────────────────────────────
 * 改变的:这台壳记住的当前工作区(瓦面的色与字标、三处快切表的 ✓、
 * `documentElement` 上的 `data-workspace`)。
 * **没有**改变的:引擎那一侧 —— 凭证池、接入目录、provider 设置、会话归属
 * 并不随之切换。那需要每一条取数都带上 `workspaceId`,而壳今天的六个端口
 * (sessions / chat / files / models / provider-settings / meter)一条都没有这一格。
 * 这属**后端批**的方案项,不是本批漏做;界面上如实注脚
 * (`workspace.scopeNote`),代码里不假装。
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

/**
 * 新建时挑一个还没被用的色 —— 挑不出(六格用完了)就从头轮。
 * 它只是个**默认值**:建完在总览卡上一点「换色」就能改。
 */
function nextSwatch(spaces: readonly SpaceRecord[]): WorkspaceSwatch {
  const used = new Set(spaces.map((s) => s.color))
  return WORKSPACE_SWATCHES.find((c) => !used.has(c)) ?? WORKSPACE_SWATCHES[spaces.length % WORKSPACE_SWATCHES.length]
}

export interface WorkspaceState {
  spaces: SpaceRecord[]
  status: WorkspaceStatus
  /** 后端原话。归类不在这里 —— 读列表只有「读到 / 读不到」两档。 */
  error?: string
  /** 这台壳记住的当前工作区。见文件头。 */
  currentId: string
  /** 有写操作在飞 —— 总览上的动作键据此禁用,防连点建出两个同名空间。 */
  busy: boolean

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
    (set, get) => {
      /** 一次在飞的读。幂等靠它,不靠 status —— status 会被写操作后的重读改。 */
      let loading: Promise<void> | undefined

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
          set({ spaces: response.spaces, status: 'ready', error: undefined })
          return
        }
        set({ spaces: fallbackSpaces(), status: 'error', error: response.error })
      }

      /** 失败弹出来,不吞。后端原话原样进 detail —— 那是排障唯一的线索。 */
      function reportFailure(title: MessageKey, error: string | undefined): false {
        notify({ level: 'error', source: 'workspace', title: t(title), detail: error })
        return false
      }

      return {
        spaces: [],
        status: 'idle',
        error: undefined,
        currentId: DEFAULT_SPACE_ID,
        busy: false,

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

        createWorkspace: async (name) => {
          const trimmed = name.trim()
          if (!trimmed) return null
          set({ busy: true })
          try {
            const response = await call(
              (port) => port.create({ name: trimmed, color: nextSwatch(get().spaces) }),
              (error) => ({ success: false, error }),
            )
            if (!response.success || !response.space) {
              reportFailure('workspace.createFailed', response.error)
              return null
            }
            await reload()
            // 建完就切过去:「新建」这个动作的全部语义就是「我要去那儿」。
            set({ currentId: response.space.id })
            return response.space.id
          } finally {
            set({ busy: false })
          }
        },

        rename: async (id, name) => {
          const trimmed = name.trim()
          if (!trimmed) return false
          set({ busy: true })
          try {
            const response = await call(
              (port) => port.update({ id, name: trimmed }),
              (error) => ({ success: false, error }),
            )
            if (!response.success) return reportFailure('workspace.renameFailed', response.error)
            await reload()
            return true
          } finally {
            set({ busy: false })
          }
        },

        recolor: async (id, swatch) => {
          set({ busy: true })
          try {
            const response = await call(
              (port) => port.update({ id, color: swatch }),
              (error) => ({ success: false, error }),
            )
            if (!response.success) return reportFailure('workspace.recolorFailed', response.error)
            await reload()
            return true
          } finally {
            set({ busy: false })
          }
        },

        remove: async (id) => {
          // 当前那一个不许删 —— 删掉脚下这块地会让「当前」当场变成幽灵。
          if (get().currentId === id) return false
          set({ busy: true })
          try {
            const response = await call(
              (port) => port.remove(id),
              (error) => ({ success: false, error }),
            )
            if (!response.success) {
              const reason = response.code ? REMOVE_REJECTION[response.code] : undefined
              return reportFailure(reason ?? 'workspace.removeFailed', response.error)
            }
            await reload()
            return true
          } finally {
            set({ busy: false })
          }
        },

        reset: () => {
          loading = undefined
          set({
            spaces: [],
            status: 'idle',
            error: undefined,
            currentId: DEFAULT_SPACE_ID,
            busy: false,
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
 * 屏幕上的那份工作区表。**三个入口都调它** —— 投影只在这里发生一次,
 * 所以「哪个是当前」「⌘2 是谁」在三处逐字同源。
 */
export function useWorkspaceViews(): WorkspaceView[] {
  const spaces = useWorkspaceStore((st) => st.spaces)
  const currentId = useWorkspaceStore((st) => st.currentId)
  return useMemo(() => projectWorkspaces(spaces, currentId), [spaces, currentId])
}
