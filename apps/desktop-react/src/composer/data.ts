import type { CommandEntry } from '../data/commands-source'
import type { AskSpec } from './types'

/**
 * Composer 的模拟数据。**这是「模拟出来的用户数据」,不是界面文案** ——
 * 判据同 data/chat-mock.ts 与 expose/data.ts(写在 i18n/index.ts 顶部):
 * 换一门语言,文件名、命令名与它的说明、AI 反问的题面,一个字都不该变。
 * 所以它们留在这里,不进字典。
 *
 * **D3 / D4 波二之后这里只剩 dev 扳机那一条路**(下面两块 + 那份 spec):
 * 文件 / 命令 / 模型 / 读数四块假数据都已经各自搬去真产地,搬迁账在中间那段注里。
 * 真实 `ask_user` 由 data/composer-interactions 接入。这里保留开发演示与测试题面。
 */

/**
 * `/ask-demo` 是 **dev-only 扳机**:仅用于离线查看表单样式。真实请求带 interaction
 * 应答口,不会走演示命令的聊天发送路径。
 *
 * 它是一张**表**而不是一条常量,因为它要和真表并起来
 * (`mergeCommands(BUILTIN_COMMANDS, pluginCommands, DEV_COMMANDS)`):
 * dev 的东西排在最后,顶不掉任何一条真命令。
 */
export const DEV_COMMANDS: CommandEntry[] = [
  {
    id: 'ask-demo',
    name: '/ask-demo',
    desc: 'dev · 模拟一组 AI 反问',
    usage: '/ask-demo',
    kind: 'dev',
    insertText: '/ask-demo',
    allowArgs: false,
    action: 'ask-demo',
  },
]

/*
 * D3 / D4 波二(2026-08-31)退役了另外两块常量,各自搬去了真产地:
 *  - `MOCK_FILES` → `data/file-mentions-source.ts`(`files.list`,按会话工作目录
 *    当 cwd 现搜;去抖 120ms 归调用现场);
 *  - `MOCK_COMMANDS` → `data/commands-source.ts`(内置七条来自
 *    `@onething/core/slash-commands` 的 `SHARED_SLASH_COMMANDS`,插件那一半来自
 *    `plugins.commands`)。那三条 `/review` `/plan` `/test` **没有搬家,是被删掉的**:
 *    整仓没有这三条命令,它们从来只是三行样例文案。
 *
 * D2 波一(2026-08-31)退役了另外三块,各自搬去了真产地:
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

/** dev-only:`/ask-demo` 与表单测试用的三题。 */
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
