import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'
import { t as translate } from '../i18n'
import {
  BUILTIN_COMMANDS,
  executeCommand,
  findCommand,
  mergeCommands,
  parseDraftCommand,
  useCommandsSource,
} from '../data/commands-source'
import type { CommandEntry } from '../data/commands-source'
import { promoteSessionSeat } from '../content/session-open'
import { focusTree } from '../focus/registry'
import { notify } from '../services/notify'
import { ASK_DEMO_SPEC, DEV_COMMANDS } from './data'
import { composerSink } from './sink'
import { composerStoreFor } from './store'
import type { ComposerInputHandle } from './components/ComposerInput'
import type { ResolvedSegment } from '../references/segment'
import type { AskSpec } from './types'

/**
 * ── 切线 C:发送的三口 ──────────────────────────────────────────────────────
 *
 * 「按下发送」是**一条完整的职责**,不是三段散着的回调:
 *   `runCommand` —— 这句话是不是一条命令,是的话就地执行;
 *   `sendPlain`  —— 当一条消息交出去(含首开草稿态的惰性建会话);
 *   `doSend`     —— 岔口:命令先于消息。
 * 交出去的只有 `doSend` 一口 —— 输入框的回车与发送键读的是同一个它。
 *
 * ## 三张表
 *
 * **生命周期**:没有挂载 / 卸载动作 —— 它不订阅任何东西,不起计时器,不装监听。
 * 两把闸是 ref(见下),寿命跟着组件实例走,组件下场它们一起没。
 *
 * **UI 生命状态**:**它一格都不画**。命令在飞、会话在建,屏幕上都没有转圈 ——
 * 这是刻意的(理由写在两把闸的注释里),所以这只 hook 没有 loading / error 出口:
 * 失败走 `notify`,成功走 `notify` + 清框。
 *
 * **UI 交互状态**:同上,零。发送键的忙 / 闲两副面孔读的是引擎的 `busy`,
 * 不是这只 hook 的任何一格。
 */
export interface ComposerSendDeps {
  /** 内置 + 插件 + dev 三张表合过之后的命令表(编排点持有,抽屉那头读的是同一份)。 */
  allCommands: readonly CommandEntry[]
  sessionId: string
  inputRef: RefObject<ComposerInputHandle | null>
  openAsk: (spec: AskSpec) => void
  closeDrawer: () => void
  /**
   * store 的那一口。返回 false = 没交出去(空话,或者那条会话此刻不在)。
   * `toSession` 缺席 = 发给这块面板自己的收件人;首开草稿态那一下点名刚建出来的
   * 那一条(判词整段在 `composer/store.send` 上)。
   */
  send: (text: string, toSession?: string, segments?: readonly ResolvedSegment[]) => boolean
}

/**
 * 发完一句话,光标回输入框。
 *
 * R2 之前这是 `inputRef.current?.focus()` —— 一次**跨作用域的程序置焦**,而
 * 设计 §7 的「谁都不许」第二条正是这个。改走响应链:`activateScope('composer')`
 * 把焦点送到输入面板**声明的落点**上,于是「落点是哪一格」只有一个产地
 * (write 形态是那块可编辑区、ask 形态是自由答案那一格,见 Composer 的
 * `restingTarget`),这里不必知道。
 *
 * 输入面板没挂载(还在总览里)时它答 false,什么都不做 —— 与从前那个
 * 「没人登记就是恒等」的单槽口(`composer/focus.ts`,本批退役)逐字同义。
 */
function backToComposer(): void {
  focusTree.activateScope('composer')
}

export function useComposerSend({
  allCommands,
  sessionId,
  inputRef,
  openAsk,
  closeDrawer,
  send,
}: ComposerSendDeps): (text: string, segments?: readonly ResolvedSegment[]) => void {
  const ensurePluginCommands = useCommandsSource((st) => st.ensurePluginCommands)

  /*
   * 「此刻正为这句话建一条会话」。ref 而不是 state:它不画任何东西 ——
   * 建会话是一次往返,不该为它长出一个转圈的发送键。
   *
   * 它挡的是**建会话在飞的那段窗口里的第二下发送**(中文输入法一次回车发两下是
   * 真发生过的事)。编排点自己那道闸只防「同时建两条」,防不了「建完之后两下各
   * 补发一次」—— 所以闸必须在这一层:在飞时后来的那几下当没按,话还在框里,无损。
   */
  const starting = useRef(false)

  /**
   * 「此刻正在跑一条命令」。同 `starting` 是 ref 而不是 state:它不画任何东西,
   * 挡的是那一段往返窗口里的第二下发送(中文输入法一次回车发两下是真发生过的事)。
   */
  const running = useRef(false)

  /**
   * 这句话是不是一条命令;是的话就地执行,并说清楚**要不要再当消息发一遍**。
   *
   * 返回 true = 这一下已经被消费掉了(执行了 / 报了用法错),调用方到此为止;
   * 返回 false = 壳不执行这一条(表里没有它,或者它属于「只插文本」那一类),
   * 那句话原样走发送那条直路。
   */
  const runCommand = useCallback(
    async (text: string): Promise<boolean> => {
      const parsed = parseDraftCommand(text)
      if (!parsed) return false

      let entry: CommandEntry | undefined = findCommand(allCommands, parsed.token)
      if (!entry) {
        // 表里没有 —— 可能只是插件那一半还没拉过(抽屉从没开过)。补拉一次再查,
        // 与 Vue 壳 `InputBox.sendMessage` 的 `refreshPluginCommands` 同一手。
        await ensurePluginCommands()
        entry = findCommand(
          mergeCommands({
            builtin: BUILTIN_COMMANDS,
            plugin: useCommandsSource.getState().pluginCommands,
            dev: DEV_COMMANDS,
          }),
          parsed.token,
        )
      }
      if (!entry) return false

      if (entry.action === 'ask-demo') {
        inputRef.current?.clear()
        openAsk(ASK_DEMO_SPEC)
        return true
      }

      const outcome = await executeCommand(entry, parsed.args, {
        sessionId,
        startSession: () => composerSink().startSession(),
      })

      if (outcome.kind === 'sendAsText') return false

      if (outcome.kind === 'failed') {
        // **话留在框里** —— 用法写错了,人要改的正是框里那一句。
        // 空 error = 编排点自己已经说过了(`/new` 建不成那条路),不加第二条提示。
        if (outcome.error) {
          notify({
            level: 'warn',
            source: 'composer.command',
            title: translate('command.failed', { name: entry.name }),
            body: outcome.error,
            detail: outcome.error,
          })
        }
        return true
      }

      inputRef.current?.clear()
      closeDrawer()
      notify({
        level: 'success',
        source: 'composer.command',
        title: outcome.message || translate('command.done', { name: entry.name }),
        body: entry.name,
      })
      return true
    },
    [allCommands, ensurePluginCommands, sessionId, inputRef, openAsk, closeDrawer],
  )

  /**
   * 把这句话当**一条消息**交出去(命令那条岔口在 `doSend` 里,先分完才到这)。
   *
   * `segments` 是这句话的**段**(09-14):它一路穿到那格乐观气泡上,于是在飞的
   * 那一枚 chip 与落账之后那一枚是同一份 `render(ref)` 画的。缺席 = 这条路上没有
   * 段可言(命令执行完再当一句话发出去的那一支),乐观气泡照旧切 `text`。
   */
  const sendPlain = useCallback(
    (text: string, segments?: readonly ResolvedSegment[]) => {
      if (send(text, undefined, segments)) {
        // **发了一句话 = 这一格不再是「随手翻翻」**(C2 转正之一,设计 §4.1)。
        // 判据整件在 `content/session-open.promoteSessionSeat`(它自己会问那一格
        // 是不是预览格);这里只提供**时刻** —— 全壳唯一一处「一句话真的交出去了」。
        promoteSessionSeat(sessionId)
        inputRef.current?.clear()
        backToComposer()
        return
      }
      /*
       * send 说没交出去,两种可能:空话,或者**还没有当前会话**。
       * 空话到此为止(它本来就不该离开输入框);有话则是首开草稿态那一下 ——
       * 「发送」在这里的意思是「开始一段对话」:先惰性建一条,再把这句话发进去。
       * 判空在这里自己做一次,是因为 send 的 false 不区分原因,而这两条路的
       * 归宿完全不同(一条什么都不做,一条要建会话)。
       */
      const hasFiles = composerStoreFor(sessionId).getState().attachments.some((attachment) => attachment.file)
      if ((!text.trim() && !hasFiles) || starting.current) {
        backToComposer()
        return
      }
      starting.current = true
      void (async () => {
        try {
          const created = await composerSink().startSession()
          /*
           * 没建成:编排点已经 notify(error) 过了,这里**不再加一条 toast**,
           * 也**不清输入框** —— 那句话还在人手里,人可以直接再按一次。
           *
           * 建成了就**点名发给刚建出来的那一条**(W5-c-2):这块面板自己的收件人
           * 是空串(它就是那片「还没绑会话」的叶),而这一句的去处是新那条。
           * 判词整段在 `composer/store.send` 的 `toSession` 上。
           */
          if (created && send(text, created, segments)) {
            /* 与上面那一句同一条(C2 转正之一):首开草稿态发出的第一句话同样算数。
             * 转正的是**刚建出来那一条**的格子 —— 从前这里写 `sessionId`,靠的是
             * 内层那个同名 const 把外面那个遮住;W5-c 之后外面那个是这块面板的
             * prop(空串),遮不住了,所以名字换成 `created`,把那份隐式依赖
             * 变成一句写出来的话。 */
            promoteSessionSeat(created)
            inputRef.current?.clear()
          }
        } finally {
          starting.current = false
          backToComposer()
        }
      })()
    },
    [send, inputRef, sessionId],
  )

  return useCallback(
    (text: string, segments?: readonly ResolvedSegment[]) => {
      /*
       * 命令先于消息。判据是 `parseDraftCommand`:**整段话**就是 `/词` 或
       * `/词 <参数>` 才算,所以「看看 /new 那条」照常是一句话。
       *
       * 只有以斜杠开头的那一句会走这条异步路 —— 普通消息的发送路径**一步都没多**
       * (它上面挂着一串按同步语义写的断言,也确实没有理由为它多等一帧)。
       */
      if (parseDraftCommand(text)) {
        if (running.current) return
        running.current = true
        void (async () => {
          try {
            if (await runCommand(text)) return
            // 壳不执行这一条:原样当一句话发出去(`/goal …` 就走这里)。
            sendPlain(text, segments)
          } finally {
            running.current = false
            backToComposer()
          }
        })()
        return
      }
      sendPlain(text, segments)
    },
    [runCommand, sendPlain],
  )
}
