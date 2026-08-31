import type { AskSpec, CommandSpec } from './types'

/**
 * Composer 的模拟数据。**这是「模拟出来的用户数据」,不是界面文案** ——
 * 判据同 data/chat-mock.ts 与 expose/data.ts(写在 i18n/index.ts 顶部):
 * 换一门语言,文件名、命令名与它的说明、模型名与它的定位、AI 反问的题面,
 * 一个字都不该变。所以它们留在这里,不进字典。
 *
 * 每一块都标了「接真源时换谁」:这一批全是常量,接引擎时只换这个文件里的来源,
 * 组件与纯函数一行不动。
 */

/** 接 @ 引用时换成工作区文件索引。 */
export const MOCK_FILES = [
  'model-capability.ts',
  'model-registry.ts',
  'codex.ts',
  'factory.ts',
] as const

/**
 * 接 slash-commands 注册表时换源。
 * `/ask-demo` 是 **dev-only 入口**:这一批没有引擎,ask 形态没有真正的产地,
 * 所以给它留一条命令当扳机。真接上 ask_user 事件后删掉这一条即可 —— 形态本身不动。
 */
export const MOCK_COMMANDS: CommandSpec[] = [
  { name: '/review', desc: '按评审清单过一遍改动' },
  { name: '/plan', desc: '先出方案不动代码' },
  { name: '/test', desc: '只跑相关测试' },
  { name: '/ask-demo', desc: 'dev · 模拟一组 AI 反问', dev: true, action: 'ask-demo' },
]

/*
 * D2 波一(2026-08-31)退役了三块常量,各自搬去了真产地:
 *  - `MOCK_PROVIDERS` → `data/models-source.ts`(providers.list + models.getWithCapabilities,
 *    两道闸筛可见的家);顺带 `ProviderGroup` / `ModelSpec` 两个形状也搬了过去 ——
 *    形状归产地,不归这块假数据文件;
 *  - `DEFAULT_MODEL` → 没有替代品,**它本来就是一句谎**:壳不该替引擎钦定一个
 *    默认模型。当前模型现在从三层事实里推(`resolveModelSelection`),
 *    三层都答不上来就诚实地写「选择模型」;
 *  - `MOCK_METER` → `data/meter-source.ts`(usage.getSession + sessions.getTokenUsage)。
 *    那七格里的 `cacheSavedUsd`(省了多少钱)**整仓没有产地**,所以它没有搬家,
 *    是被删掉的 —— 连同 i18n 里 `meter.cacheValue` 的那半句。
 */

/** dev-only:`/ask-demo` 用的三题。接 ask_user 事件后,spec 由事件带来。 */
export const ASK_DEMO_SPEC: AskSpec = {
  questions: [
    {
      tag: '徽标',
      q: '徽标那处要一并改吗?',
      multi: false,
      opts: [
        { l: '一并改', d: '徽标与生图路由从此同一判据' },
        { l: '不改', d: '本次只动三处读取点' },
      ],
    },
    {
      tag: '验证',
      q: '这批改动要跑哪些验证?',
      multi: true,
      opts: [
        { l: 'providers 套件', d: '77 例,约 40s' },
        { l: '全量测试', d: '11k 例,约 6min' },
        { l: '真机走查', d: '起 dev server 手动过' },
      ],
    },
    {
      tag: '提交',
      q: '改完直接提交吗?',
      multi: false,
      opts: [
        { l: '直接提交', d: 'haiku 生成提交信息' },
        { l: '先看 diff', d: '过目后你说了算' },
      ],
    },
  ],
}
