import type { FigureKindDef, FigureRendered } from './registry'

/**
 * mermaid 图种 —— **一个 figKind,不是一族**。
 *
 * P1 的围栏路由把 ```mermaid 产成 `figKind:'mermaid'`(词汇表里那句「不枚举图种」
 * 的兑现);P3 归一到这一个键,不再有 `mermaid-flowchart` 这样的复合键 ——
 * **图种由 mermaid 自己认**(源码第一行就写着 `flowchart TD` / `sequenceDiagram`),
 * 让路由层去猜等于在本仓维护第二份 mermaid 语法表,而它一定会过时。
 *
 * ── 懒加载:一次拉起,全家共用 ────────────────────────────────────────
 * mermaid 是几 MB 的东西,静态 import 会把它焊进主包。这里是全仓**唯一**提到它的
 * 地方,而且只在 `import('mermaid')` 里出现 —— 于是打包器把它切成独立 chunk,
 * 主包一个字节都不沾,只有真的画一张图时才拉。`ready` 记住那个 promise,
 * 一台上只拉一次;拉失败**不记住**(下一张图再试一次:一次网络/磁盘抖动
 * 不该让这台永远没有图)。
 *
 * ── 主题:内置 `neutral`,这是临时落点 ────────────────────────────────
 * 内置四档(default / neutral / dark / forest)里 neutral 最接近壳的暖纸:它是
 * 低饱和的灰底黑字,不像 default 的淡紫、forest 的绿。**留账**:主题 → 壳 token
 * 的映射是后续拍板件(和 shiki 的 vitesse-light 同一笔账,见 code/highlight.ts
 * 头注)。那之前图的配色不跟主题走 —— 深色主题下它仍是浅底,这是记在案的过渡形。
 * 同理不覆盖 `fontFamily`:CSS 变量在 SVG 里能解析,但 PNG 导出时 SVG 是被
 * `new Image()` 独立加载的,那时 `var(--font-body)` 无从解析,导出的图会换字体。
 *
 * ── `securityLevel: 'strict'` ────────────────────────────────────────
 * 图源码是模型吐出来的任意文本。strict 是 mermaid 的默认档(标签走 DOMPurify、
 * 不许点击回调),这里**显式写出来**:它是一条安全判据,不该靠上游的默认值不变。
 * 上屏那一步另有一道(SvgCanvas 走 DOMParser 而不是 innerHTML)—— 两道是有意的。
 */

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}

let ready: Promise<MermaidApi> | undefined

async function loadMermaid(): Promise<MermaidApi> {
  ready ??= import('mermaid')
    .then((module) => {
      const mermaid = (module.default ?? module) as unknown as MermaidApi
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
      })
      return mermaid
    })
    .catch((thrown: unknown) => {
      // 记住失败会让这台永远没有图;忘掉它,下一张图重试一次。
      ready = undefined
      throw thrown
    })
  return ready
}

/** 每次渲染要一个唯一 id:mermaid 拿它当 SVG 里的元素前缀,重名会串样式。 */
let seq = 0

async function render(source: string): Promise<FigureRendered> {
  const mermaid = await loadMermaid()
  seq += 1
  const id = `onething-figure-${seq}`
  try {
    const { svg } = await mermaid.render(id, source)
    return { svg }
  } finally {
    dropMermaidScratch(id)
  }
}

/**
 * 收掉 mermaid 留在 `document.body` 上的临时容器。
 *
 * mermaid 量文字宽度要真排版,所以它把图先画进一个 `#d<id>` 的临时 div(挂在 body 上)。
 * 画成了它自己收走;**解析失败时不收** —— 于是页面尾巴上会凭空多出一张巨大的
 * 「Syntax error in text」炸弹图,而那张图既不属于任何一条消息,也没人能关掉它。
 * (真机截图抓到的,不是推测。)这里在 finally 里兜一道:成功路径上是个空操作,
 * 失败路径上把它清掉,降级仍旧只有卡片里那一行说明 + 源码。
 */
function dropMermaidScratch(id: string): void {
  if (typeof document === 'undefined') return
  document.getElementById(`d${id}`)?.remove()
  document.getElementById(id)?.remove()
}

/**
 * 檐上的类型词 —— **一张浅表,只影响那一个词**。
 *
 * 判据是第一行有效源码的头一个词(mermaid 自己的语法就是这么开头的)。指令行
 * (`%%{init: …}%%`)、注释(`%%`)、空行先跳过。表里没有的写法返回 undefined,
 * 檐上就显 `mermaid` —— 「显示得不够细」是这条捷径的全部代价。
 */
function label(source: string): string | undefined {
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    const head = /^([A-Za-z][\w-]*)/.exec(line)?.[1]
    if (!head) return undefined
    return DIAGRAM_TYPES[head.toLowerCase()]
  }
  return undefined
}

/** 头词 → 檐上显示的类型词。值刻意都用小写(檐的 `.id` 本来就压小写)。 */
const DIAGRAM_TYPES: Record<string, string> = {
  graph: 'flowchart',
  flowchart: 'flowchart',
  'flowchart-elk': 'flowchart',
  sequencediagram: 'sequence',
  classdiagram: 'class',
  'classdiagram-v2': 'class',
  statediagram: 'state',
  'statediagram-v2': 'state',
  erdiagram: 'er',
  journey: 'journey',
  gantt: 'gantt',
  pie: 'pie',
  quadrantchart: 'quadrant',
  requirementdiagram: 'requirement',
  gitgraph: 'gitgraph',
  mindmap: 'mindmap',
  timeline: 'timeline',
  zenuml: 'zenuml',
  sankey: 'sankey',
  'sankey-beta': 'sankey',
  xychart: 'xychart',
  'xychart-beta': 'xychart',
  block: 'block',
  'block-beta': 'block',
  packet: 'packet',
  'packet-beta': 'packet',
  architecture: 'architecture',
  'architecture-beta': 'architecture',
  kanban: 'kanban',
  radar: 'radar',
  treemap: 'treemap',
  c4context: 'c4',
}

export const mermaidFigureKind: FigureKindDef = {
  kind: 'mermaid',
  // 拉库单列一格,虽然 render 自己也会 await 一次(promise 有缓存,第二次是同步命中)。
  // 分开写是为了让「库没拉到」和「图画不出来」在**表**这一层就是两件可分辨的事,
  // 尽管它们在屏幕上降级到同一个样子。
  loader: loadMermaid,
  render,
  label,
}

/** 只给测试用:模块级的 promise 要能在用例之间归零。 */
export function resetMermaidForTest(): void {
  ready = undefined
  seq = 0
}
