import { useEffect, useMemo, useRef } from 'react'
import { createFileToken, expandFileTokens } from '@onething/runtime/prompts/prompt-references'
import { resolveIcon } from '../../components/icons'
import {
  FILE_MENTION_DEBOUNCE_MS,
  useFileMentionsSource,
} from '../../data/file-mentions-source'
import type { FileMention } from '../../data/file-mentions-source'
import { matchFiles } from '../../composer/transitions'
import { basename } from '../../content/tools/result'
import { openFileInCurrentTarget } from '../../content/viewer/open-target'
import { registerReferenceKind } from '../registry'
import { isDirectoryPath, PATH_REF_PATTERN, pathRefOf } from './path-ref'
import s from '../ReferenceChip.module.css'
import type { PickContext, PickResult, ReferenceKind } from '../kind'

/**
 * **文件引用** `@<绝对路径>`。
 *
 * 五格都在这一只文件里:`@` 抽屉那一列(它同时是目录的拾取口,见 `kindOf`)、
 * 落进草稿的 `{{file:…}}` 记号与它的展开、气泡里怎么认出来、画成什么、点了去哪。
 *
 * ── 这一列是文件与目录**共用的一次取数** ────────────────────────────────────
 * `files.list` 一发就带回两种(`FileMention.type`),抽屉里它们混在一列里 ——
 * 人打 `@src/` 的时候心里没有「我现在要找的是目录还是文件」这一格。所以拾取归
 * 一家、落稿归两家:`kindOf` 说这条候选落稿时算哪一种,目录那一枚的尾斜杠与
 * chip 写法归 `kinds/dir.ts` 自己。
 */

const FileIcon = resolveIcon('FileText')

/**
 * `@` 候选。**去抖在这里,不在数据源**:`search` 是立即发的(竞速由令牌管),
 * 「人打字的节奏」是编排的事 —— 与 `search/components/SearchPanel.tsx` 逐条同款。
 *
 * **首开不去抖**(09-12 第二批):去抖是给打字的节奏准备的,而 `@` 刚敲下去的那
 * 一拍没有节奏可言 —— 它是一次明确的「我要看候选」,后面跟着的 120ms 纯粹是白等。
 * 所以首开当场发一次,去抖只管此后每一次改词。
 *
 * 不在场时**清候选**(它是「此刻在匹配什么」,不是缓存),而切到在场的那一拍
 * 一个字都不清 —— 所以「开抽屉」本身从不制造一次空列表。
 */
function useFileMentions(ctx: PickContext): PickResult<FileMention> {
  const { active, query, cwd, sessionId } = ctx
  const mentions = useFileMentionsSource((st) => st.mentions)
  const status = useFileMentionsSource((st) => st.status)
  const search = useFileMentionsSource((st) => st.search)
  const clear = useFileMentionsSource((st) => st.clear)

  /** 「是不是刚切到在场的那一拍」。ref 而不是 state:读它的人不需要重渲染。 */
  const justOpened = useRef(false)
  useEffect(() => {
    if (!active) {
      justOpened.current = false
      clear()
      return
    }
    if (!justOpened.current) {
      justOpened.current = true
      void search(query, cwd, sessionId)
      return
    }
    const timer = setTimeout(() => void search(query, cwd, sessionId), FILE_MENTION_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [active, query, cwd, sessionId, search, clear])

  /*
   * 候选到手之后还得在**已到手的那批**里再收一次:去抖窗口里人又多打了两个字,
   * 列表该立刻收窄,而不是等下一次往返。两处收窄用的是同一句判据(`matchFiles`)。
   */
  const hits = useMemo(
    () => (active ? matchFiles(mentions, query) : []),
    [active, mentions, query],
  )
  return { hits, status }
}

/** 一条候选落稿时算哪一种:候选自己说得清是 `directory` 还是 `file`。 */
export function pathKindOf(hit: FileMention): string {
  return hit.type === 'directory' ? 'dir' : 'file'
}

export const fileReferenceKind: ReferenceKind<FileMention, { kind: 'fileRef'; path: string }> = {
  id: 'file',

  source: {
    trigger: '@',
    where: 'anywhere',
    // 路径里的点与连字符都算 token 的一部分(`@src/a-b.ts` 打到一半不许断)。
    tokenChars: '.-',
    /*
     * **空着也画组头**:这是 `@` 这个字符下唯一的一组,组头说的是**整列是什么**,
     * 不是「这里有几条」。底下那句「无匹配 / 正在找…」跟在它后面。
     */
    group: { key: 'composer.headFiles', always: true },
    hint: 'composer.hintFile',
    useQuery: useFileMentions,
    // 抽屉那一行念的是 label(cwd 之下的相对路径),目录**不带尾斜杠**
    // (呈现层的既有拍点,a00e1728 留账未动)。
    row: (hit) => ({ primary: hit.label }),
    kindOf: pathKindOf,
  },

  draft: {
    /*
     * 候选 → **这一枚引用**。09-14 之前这里交的是一枚 chip(`@<相对路径>`),
     * 而气泡里那一枚由 `render` 画成 basename —— 同一个文件两种写法,按下回车
     * 就换一次形。今天两边读的都是下面那只 `render`。
     */
    toRef: (hit) => ({ kind: 'fileRef' as const, path: hit.path }),
    // chip 是呈现,token 才是位置(`@onething/runtime` 的 `FILE_REF_PATTERN` 那段注)。
    token: (ref) => createFileToken(ref.path),
    /*
     * **展开在草稿出口,而且只在那里**(a00e1728):交出去的那一句必须与账本上
     * 最终落下的逐字相同,不然乐观上屏那一格永远认领不到自己那条消息。
     */
    expand: expandFileTokens,
  },

  parse: {
    text: {
      pattern: PATH_REF_PATTERN,
      toRef: (m) => {
        const hit = pathRefOf(m)
        if (isDirectoryPath(hit.path)) return null
        return { ref: { kind: 'fileRef' as const, path: hit.path }, start: hit.start, end: hit.end }
      },
    },
  },

  render: (ref) => ({
    className: s.ref,
    dataKind: 'fileRef',
    icon: FileIcon,
    iconClassName: s.refIcon,
    label: basename(ref.path),
    labelClassName: s.refName,
    tooltipKey: 'chat.ref.openFile',
    tooltipArgs: { path: ref.path },
    // 悬停看到的是这条路径的两层形(09-13);「打开 …」那句动词退到
    // `aria-label` 上 —— `chat.ref.openFile` 这个键因此**不删**,它现在只服务
    // 无障碍名。
    tooltipPath: { path: ref.path },
    clickable: true,
  }),

  /*
   * 同步开完 —— 一句 `placeRef`,没有可等的东西,所以答 boolean 而不是 promise
   * (pending 那一格的判据就是这个,见 `ReferenceChip`)。
   *
   * `~/` **原样交出去**:渲染层没有 homedir 这个事实(判词逐字写在
   * `data/files-source.ts` 文件头),展不展得开由那条路自己答 —— 也**不许**在这里
   * 拼一个第二套展开。
   */
  open: (ref) => {
    openFileInCurrentTarget(ref.path)
    return true
  },
}

registerReferenceKind(fileReferenceKind, import.meta.hot)
