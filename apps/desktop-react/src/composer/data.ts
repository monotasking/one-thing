import type { AskSpec, CommandSpec, ProviderGroup } from './types'

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

/** 接 model-registry 时换源。 */
export const MOCK_PROVIDERS: ProviderGroup[] = [
  {
    provider: 'Anthropic',
    models: [
      { model: 'claude-opus-5', desc: '最强推理' },
      { model: 'claude-sonnet-5', desc: '均衡' },
      { model: 'claude-haiku-4.5', desc: '轻快' },
    ],
  },
  {
    provider: 'xAI',
    models: [
      { model: 'grok-4', desc: '量大管饱' },
      { model: 'grok-4-fast', desc: '低延迟' },
    ],
  },
  {
    provider: 'DeepSeek',
    models: [
      { model: 'deepseek-chat', desc: '便宜' },
      { model: 'deepseek-reasoner', desc: '长思考' },
    ],
  },
]

export const DEFAULT_MODEL = 'claude-opus-5'

/**
 * 读数明细的四行。**接遥测账本时换源** —— 组件只认这个形状,不认数字从哪来。
 * 存的是数不是句子:句子由 i18n 模板拼(不同语言的量词位置不一样)。
 */
export const MOCK_METER = {
  contextUsed: 124_000,
  contextMax: 200_000,
  tokensIn: 48_200,
  tokensOut: 12_600,
  costUsd: 0.87,
  cacheHitPct: 91,
  cacheSavedUsd: 2.1,
} as const

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
