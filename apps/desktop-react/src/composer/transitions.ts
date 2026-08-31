import type {
  AskAnswer,
  AskQuestion,
  AskSpec,
  AttCardLayout,
  AttStackLayout,
  Attachment,
  CommandSpec,
  TokenHit,
} from './types'
import type { ProviderGroup } from '../data/models-source'

/**
 * Composer 的纯函数层。规矩同 stage/transitions.ts:
 * 这里一行都不许碰 React / DOM / window —— 光标位置、卡片实宽这些「宿主的事实」
 * 由组件量好递进来,函数只做判断与算术。所以整层可以逐条测。
 */

/* ── @ 与 / 的触发检测 ──────────────────────────────────────────────────────
 * 两个 token 的**触发位不同**,这是设计稿定的:
 *   @ 在任意处都触发(句中引文件是常态);
 *   / 只在整段话以 / 开头时触发(命令是一句话的主语,不是句中的词)。
 * 判据里 upto = 光标之前那一段文本,full = 整个输入框的纯文本 —— 后者只用来问
 * 「这句话是不是以 / 开头」,别的都不看。
 * ────────────────────────────────────────────────────────────────────────── */
export function parseToken(upto: string, full: string): TokenHit | null {
  const file = /@([\w.-]*)$/.exec(upto)
  if (file) return { kind: 'files', query: file[1] }
  const cmd = /(?:^|\s)\/([\w-]*)$/.exec(upto)
  if (cmd && full.trim().startsWith('/')) return { kind: 'commands', query: cmd[1] }
  return null
}

/**
 * 文件是**包含**匹配(路径中段也该命中)。
 *
 * D3 波二起 `@` 候选由后端筛(`files.list` 收 `query`),但这一条不但没退役,
 * 反而更要紧了:候选到手之后还得在**已到手的那批**里再收一次 —— 去抖窗口里
 * 人又多打了两个字,列表该立刻收窄,而不是等下一次往返。两处收窄用的是
 * 同一句判据,这个函数就是那句判据**唯一**的写法。
 *
 * 收字符串表(测试与老调用点)也收带 `label` 的候选对象(真候选带着路径,
 * 筛完还得认得出选中的是哪一条)。**不写成两个函数** —— 那就有两处包含匹配了。
 */
export function matchFiles<T extends string | { label: string }>(
  files: readonly T[],
  query: string,
): T[] {
  return files.filter((f) => (typeof f === 'string' ? f : f.label).includes(query))
}

/**
 * 命令是**前缀**匹配(命令名从头念)。
 *
 * 泛型是为了**不丢子类型**:表里流过来的是 `CommandEntry`(带 id / kind /
 * insertText),筛完还得是它 —— 写死成 `CommandSpec[]` 的话调用现场就得
 * 再断言一次回去,而那正是「判断层偷偷改了形状」的入口。
 */
export function matchCommands<T extends CommandSpec>(cmds: readonly T[], query: string): T[] {
  return cmds.filter((c) => c.name.slice(1).startsWith(query))
}

/*
 * 「列表里上下走」与「夹进范围」这两条判据 09-01 收进了 `ui/a11y/list-selection`
 * (`stepListIndex` / `clampListIndex`),连同它们旁边那件真正要紧的纪律:
 * **hover 不许改选中位**。抽屉、工作区快切、模型抽屉从前各写一份走法,
 * 于是也各写一份 hover 处理 —— 收敛掉走法,才收得掉那条病。
 */

/* ── ask 问卷 ────────────────────────────────────────────────────────────── */

export function initAskAnswers(spec: AskSpec): AskAnswer[] {
  return spec.questions.map(() => null)
}

/**
 * 「答了没」只有一句话:不是 null / undefined,且多选不是空数组。
 * 空数组要算没答 —— 否则「全选后再全取消」会被记成已答,提交按钮会说谎。
 */
export function isAskAnswered(ans: AskAnswer | undefined): boolean {
  if (ans === null || ans === undefined) return false
  if (Array.isArray(ans)) return ans.length > 0
  return true
}

export function askAnsweredCount(answers: readonly AskAnswer[]): number {
  return answers.filter((a) => isAskAnswered(a)).length
}

export function askAllAnswered(spec: AskSpec, answers: readonly AskAnswer[]): boolean {
  return askAnsweredCount(answers) === spec.questions.length
}

/**
 * 点一条选项。两种题型是**同一个动作的两种投影**,不是两个函数:
 *   多选 = 在下标集合里进出;
 *   单选 = 设成那条的标签,**再点同一条即取消**(设计稿明写「再点取消」)。
 */
export function toggleAskOption(
  spec: AskSpec,
  answers: readonly AskAnswer[],
  idx: number,
  optIndex: number,
): AskAnswer[] {
  const question = spec.questions[idx]
  if (!question) return [...answers]
  const next = [...answers]
  if (question.multi) {
    const arr = Array.isArray(answers[idx]) ? [...(answers[idx] as number[])] : []
    const at = arr.indexOf(optIndex)
    if (at >= 0) arr.splice(at, 1)
    else arr.push(optIndex)
    next[idx] = arr
  } else {
    const label = question.opts[optIndex]?.l
    next[idx] = answers[idx] === label ? null : (label ?? null)
  }
  return next
}

/** 「其他」那行:写空了就等于没答(不留空串占位)。 */
export function setAskCustomAnswer(
  answers: readonly AskAnswer[],
  idx: number,
  text: string,
): AskAnswer[] {
  const next = [...answers]
  next[idx] = text.trim() || null
  return next
}

/** 是不是手写的那句:是字符串、且不等于任何一条现成选项的标签。 */
export function isCustomAnswer(question: AskQuestion, ans: AskAnswer | undefined): boolean {
  return typeof ans === 'string' && !question.opts.some((o) => o.l === ans)
}

/** 翻题钳制:两端不循环 —— 问卷有头有尾,转圈会让人不知道自己在哪。 */
export function moveAskIndex(idx: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(idx + delta, count - 1))
}

/** 一题的答案念成一句话。joiner 由调用方给(它是文案,归 i18n)。 */
export function askAnswerText(
  question: AskQuestion,
  ans: AskAnswer | undefined,
  joiner: string,
): string {
  if (Array.isArray(ans)) return ans.map((i) => question.opts[i]?.l ?? '').join(joiner)
  return typeof ans === 'string' ? ans : ''
}

/**
 * 几何钉死:问卷区按「选项最多的那题 + 恒在的『其他』行」预留高度,
 * 于是翻题时面板一动不动 —— 翻页不该让整块面板跳。
 */
export function askMaxRows(spec: AskSpec): number {
  return Math.max(0, ...spec.questions.map((q) => q.opts.length)) + 1
}

/* ── 附件收拢 / 展开的排布 ──────────────────────────────────────────────────
 * 这几个数与 Composer.module.css 里的同名 token 是**同一份事实的两处写法**
 * (JS 算不了 var(),CSS 排不了累计坐标),改一处必须改另一处。
 * ────────────────────────────────────────────────────────────────────────── */

/** 拍立得方卡宽 = --att-photo-w */
export const ATT_PHOTO_W = 76
/** 小票长卡宽 = --att-doc-w */
export const ATT_DOC_W = 132
/** 展开成排时卡与卡的间隙 = --att-gap */
export const ATT_GAP = 10
/** 收拢摞的基础内衬:旋转的卡角不出容器(overflow:hidden 曾裁掉左缘)= --att-inset */
export const ATT_INSET = 6
/** 摞里每往上一张多探出多少 = --att-offset */
export const ATT_OFFSET = 7
/** 摞里的错角度数 = --att-rotate */
export const ATT_ROTATE = 3
/** 收拢态实宽之外再留的旋转余量 */
export const ATT_SLACK = 12
/** 收拢只画最上三张:阴影不堆黑晕、摞形干净 */
export const ATT_VISIBLE = 3

/** 小票卡右端那枚扩展名徽:大写、最多四个字母(.markdown 也不该把卡撑破)。 */
export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toUpperCase().slice(0, 4)
}

export function attachmentWidth(a: Attachment): number {
  return a.url ? ATT_PHOTO_W : ATT_DOC_W
}

/**
 * 一次算完整摞的排布。两态是**同一个函数的两条分支**,不是两套代码:
 *   展开 = 从左往右累计 x,零旋转,总宽撑出横滚;
 *   收拢 = 只留最上三张,逐张 offset + 错角,宽度按「最宽可见卡的右缘」。
 */
export function layoutAttachments(atts: readonly Attachment[], open: boolean): AttStackLayout {
  const cards: AttCardLayout[] = []
  const first = Math.max(0, atts.length - ATT_VISIBLE)
  let x = 0
  let stackW = 0

  atts.forEach((a, i) => {
    if (open) {
      cards.push({ id: a.id, hidden: false, left: x, rotate: 0, zIndex: i })
      x += attachmentWidth(a) + ATT_GAP
      return
    }
    if (i < first) {
      cards.push({ id: a.id, hidden: true, left: 0, rotate: 0, zIndex: i })
      return
    }
    const k = i - first // 0..2,顶卡 = 最新一张
    const off = ATT_INSET + k * ATT_OFFSET
    cards.push({ id: a.id, hidden: false, left: off, rotate: ((k % 3) - 1) * ATT_ROTATE, zIndex: i })
    stackW = Math.max(stackW, off + attachmentWidth(a))
  })

  return {
    cards,
    rowWidth: open ? Math.max(x - ATT_GAP, 0) : stackW + ATT_SLACK,
    stackWidth: open ? null : stackW + ATT_SLACK,
  }
}

/* ── 模型抽屉 ────────────────────────────────────────────────────────────── */

/**
 * 搜模型**或** Provider:输入 "anthropic" 要能整组捞出来,
 * 输入 "grok" 只留那两条。空组不画头 —— 所以过滤完还要把空组滤掉。
 */
export function filterProviders(groups: readonly ProviderGroup[], query: string): ProviderGroup[] {
  const kw = query.trim().toLowerCase()
  return groups
    .map((g) => ({
      // `...g` 而不是逐格重建:组上的 `id`(provider id,上行要它)不能在筛一遍
      // 之后丢掉 —— 逐格重建是这类「新加的字段静默消失」的头号产地。
      ...g,
      models: g.models.filter(
        (m) =>
          !kw || m.model.toLowerCase().includes(kw) || g.provider.toLowerCase().includes(kw),
      ),
    }))
    .filter((g) => g.models.length > 0)
}

/* ── 读数 ────────────────────────────────────────────────────────────────── */

/**
 * 圆环的 dash:第二个数直接给整圈周长,保证只画一段(给差值会在环末尾再冒出一小截)。
 */
export function ringDash(pct: number, radius: number): string {
  const c = 2 * Math.PI * radius
  const on = (c * Math.max(0, Math.min(100, pct))) / 100
  return `${on.toFixed(1)} ${c.toFixed(1)}`
}

/**
 * 缺席态的环:不知道窗口多大时,把**底圈**画成一串点(八段等分),
 * 而不是画一圈实线 + 0% 的弧。判据在 `percent` 那条注释里 ——
 * 「空环」不能同时表示 0% 与「不知道」。
 *
 * 段数是这枚 18px 环自己的画法比例,与 `ringDash` 的整圈周长同一份几何事实;
 * 它是**算出来的 dash**,不是一条写在组件里的字面量。
 */
export function ringUnknownDash(radius: number): string {
  const segment = (2 * Math.PI * radius) / 16
  return `${segment.toFixed(1)} ${segment.toFixed(1)}`
}

/** 48200 → '48.2k';200000 → '200k'(整数不留 .0)。 */
export function formatCount(n: number): string {
  if (Math.abs(n) < 1000) return String(n)
  const k = n / 1000
  const s = k.toFixed(1)
  return `${s.endsWith('.0') ? s.slice(0, -2) : s}k`
}

/**
 * 金额。**不足一块钱留四位小数**(Vue 壳 `formatSessionCostUSD` 的同一条):
 * 两位小数会把 $0.0031 写成 $0.00 —— 那读起来是「免费」,而它不是。
 * 单位符号($)在模板里,这里只出数。
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0.00'
  if (value >= 1) return value.toFixed(2)
  // 四位起步,但**末尾的零不留**(至少两位):$0.8700 里那两个零一个信息都不带,
  // 而 $0.0031 里的每一位都带。
  const raw = value.toFixed(4).replace(/0+$/, '')
  const decimals = raw.split('.')[1] ?? ''
  return decimals.length < 2 ? value.toFixed(2) : raw
}

/**
 * 百分比取整 —— 读数是给人看的一眼,不是账。
 *
 * **分母不成立时返回 null,不是 0**(D2 波一改)。这两件事在屏幕上长得一样
 * (一圈空环),意思却相反:0% 是「这个模型窗口很大,才用了一点点」,
 * null 是「不知道这个模型的窗口多大」。环据此画成缺席态(见 `ringUnknownDash`),
 * 卡上那一行据此换一句话。用 0 顶替 null 是这张卡上最容易犯的谎。
 *
 * 上界夹在 100:超窗那一下(压缩前)不该画出一圈半。
 */
export function percent(used: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null
  return Math.min(100, Math.round((used / total) * 100))
}

/** 状态条上那句话按字数截断(超出加省略号)。 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
