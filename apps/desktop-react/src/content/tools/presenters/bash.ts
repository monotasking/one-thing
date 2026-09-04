import type { ToolPresenter } from '../presenter'
import { baseToolRow, partialArgString, truncate } from '../row'
import { argString, detailNumber, toolOutputText } from '../result'

/**
 * `bash` 的展示(§5.1 表第三行)。
 *
 * 行 = **命令首词** + 参数摘要,成果词 = 退出码语义。
 *
 * 为什么首词单列一格:一条命令的「是什么」全在第一个词上(`npm` / `rg` / `git`),
 * 后面那一长串是「怎么做」。首词用正常字重、其余用灰字,一眼扫下来一列命令就是
 * 一列动词 —— 这正是 A1 卡行「左端是身份」的意思。
 *
 * ── 成果词只说退出码,不解读输出 ──────────────────────────────────────
 * 定稿举的例子是「616 通过」那种从测试输出里读出来的话。本批**不做**:那要一张
 * 「哪个命令的输出长什么样」的规则表(vitest / jest / cargo 各不同),而规则表猜错
 * 的代价是屏幕上一句**假的**成果词 —— 比没有成果词坏得多。今天只说退出码,它是
 * bash 自己写进 metadata 的事实。真要那句话,它该是 P4/P5 的一张明表,不是这里
 * 一个正则。
 */
export const bashPresenter: ToolPresenter = {
  match: (call) => (call.toolName || call.toolId) === 'bash',

  row: (call) => {
    const command = argString(call, 'command', 'CommandLine')
    const flat = command?.replace(/\s*\n\s*/g, ' ').trim()
    const [head, ...rest] = flat ? flat.split(/\s+/) : []
    const exit = detailNumber(call, 'exitCode')
    return baseToolRow(call, {
      icon: 'Terminal',
      // 头行里这一步就叫首词:`bash` 的行名**本身是动词**,回落规则会把它念成
      // 「bash rg」。自述掉这一格,card.ts 里就不必认得 bash 是谁(§6.1)。
      // 没有命令(参数还没到 / 拿不到)时不设 —— 那时头行念「bash」才是实话。
      ...(head ? { name: head, headLabel: head, title: flat } : {}),
      ...(rest.length > 0 ? { summary: truncate(rest.join(' '), 72) } : {}),
      ...(exit !== undefined && call.status === 'completed'
        ? {
            outcome:
              exit === 0
                ? ({ key: 'chat.tool.exitOk' } as const)
                : ({ key: 'chat.tool.exitCode', vars: { code: exit } } as const),
          }
        : {}),
    })
  },

  /**
   * 参数流中的形:**首词一到就是首词**,后面那截逐字长。
   *
   * 与 `row` 走同一条切法(首词 + 其余),所以参数收齐那一帧行上的字**不跳** ——
   * 半截的 `rg -n "foo` 变成完整的 `rg -n "foo" src`,只是那一格文字变长。
   *
   * `headLabel` 同理要在这里也报一次:这一刻 `row()` 的 `arguments` 还是 `{}`,
   * 它报不出首词,补丁不带这一格的话头行会先念「bash rg」、等参数收齐再变成
   * 「rg」—— 那正是「参数收齐那一帧字不跳」这条要挡的形,只是发生在头行上。
   */
  partial: (call) => {
    const flat = partialArgString(call, 'command', 'CommandLine')?.replace(/\s*\n\s*/g, ' ')
    if (!flat) return {}
    const [head, ...rest] = flat.trimStart().split(/\s+/)
    return {
      icon: 'Terminal',
      ...(head ? { name: head, headLabel: head, title: flat } : {}),
      ...(rest.length > 0 ? { summary: truncate(rest.join(' '), 72) } : {}),
    }
  },

  detail: (call) => {
    const source = toolOutputText(call)
    // 输出是终端的原话:不推语言(它不是任何一门语言),也不在这里截 —— 限高折叠
    // 是**壳**的六件公共事之一(§4.1),块自己截会截出第二套规矩。
    return source === undefined ? [] : [{ kind: 'code', lang: null, source, closed: true }]
  },
}
