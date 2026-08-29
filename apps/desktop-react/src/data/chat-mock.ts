/**
 * 主聊天区的模拟内容。**这是「模拟出来的用户数据」,不是界面文案** ——
 * 所以它不进 i18n 字典,换语言时它一个字都不该变(和 expose/data.ts 同一条边界,
 * 判据写在 i18n/index.ts 顶部)。它从 components/ChatMock.tsx 搬到这里,
 * 只为让「组件文件里不落字面文案」这条铁律能被 grep 机械验证。
 *
 * L3 起它多了一层结构:对话是**一串轮次**。
 *
 * D1(2026-08-29)搬走了章节表:钢琴键 TOC 的章节与键从此接**真数据**
 * (`sessions.getSegments` / `getUserMarkers`,见 data/sessions-source.ts),
 * 这里只剩聊天区自己的正文 mock —— 真消息流是 D3。
 */

/** 一轮工具卡。mock 里最多一张,真实数据会是数组 —— 那是接真数据时才需要动的形状。 */
export interface ChatToolCard {
  seq: string
  file: string
  status: string
}

/** 一轮 = 一条用户消息 + 一段回复(可能带一张工具卡)。TOC 的「键」一键对一轮。 */
export interface ChatTurn {
  user: string
  body: string
  tool?: ChatToolCard
}

export const CHAT_TURNS: ChatTurn[] = [
  {
    user: '把 provider 的能力判定收敛到一处,别再一边读请求侧一边读能力侧。',
    body:
      '我先看了三处读取点:请求装配、能力徽标、生图路由。它们读的是同一条目录条目,但取的是不同字段 ——' +
      ' 这就是「同一个模型在不同面上能力不一致」的根。我打算把判定抽成一个纯函数,三处都改成调用它。',
  },
  {
    user: '先别改代码,先告诉我三处读取点分别读的是哪个字段。',
    body:
      '请求装配读 capabilities.output,能力徽标读 modalities,生图路由读的是第三个字段 supportsImageOutput。' +
      '同一条目录条目、三个字段,谁也没保证它们一致。',
    tool: {
      seq: '01',
      file: 'packages/onething-runtime/src/providers/model-registry.ts',
      status: '已读',
    },
  },
  {
    user: '那这个不一致是从什么时候开始的?',
    body:
      '从目录条目加上 modalities 那次开始 —— 新字段只补了徽标那一处,另外两处还读老字段。' +
      '之后每加一个模型,不一致就多一条。',
  },
  {
    user: '好,抽成纯函数。名字用 onethingModelSupportsImageGeneration。',
    body:
      '函数只吃目录条目、返回一个布尔。三个字段的优先级写在它里面:显式声明 > modalities > 老字段兜底,' +
      '这个顺序从此只在这一处定义。',
    tool: {
      seq: '02',
      file: 'packages/onething-runtime/src/providers/model-capability.ts',
      status: '已应用',
    },
  },
  {
    user: '徽标那处也要改,不然还是两套事实。',
    body:
      '徽标已经改成调同一个函数。改完之后徽标和生图路由不可能再各说各话 ——' +
      '它们拿到的是同一个返回值,而不是同一份数据的两种读法。',
  },
  {
    user: '跑一下 typecheck。',
    body:
      'typecheck 零错。三个调用点全部收敛到新函数,老字段在产品代码里已经没有读取者,只剩目录解析那一处在写。',
    tool: {
      seq: '03',
      file: 'packages/onething-runtime/src/providers/__tests__/model-capability.test.ts',
      status: '通过',
    },
  },
  {
    user: '目录缓存按时间过期这个是另一个 bug 吧?顺手一起修。',
    body:
      '是另一个。缓存键原先是时间戳,换了目录也得等它过期才生效。现在跟着目录键走,换目录当场失效。',
    tool: {
      seq: '04',
      file: 'packages/onething-runtime/src/providers/model-registry.ts',
      status: '已应用',
    },
  },
  {
    user: '测试补上,至少覆盖「请求侧说支持、能力侧说不支持」这一条。',
    body:
      '补了四条:三个字段各自缺席时的兜底,加上你说的那条冲突用例。' +
      '冲突用例现在断言的是「以显式声明为准」,而不是「看谁先被读到」。',
  },
  {
    user: '最后把结论写一句给我。',
    body:
      '三处读取点共用一个判定函数,目录缓存跟着目录键走。徽标、请求装配、生图路由不会再各说各话 ——' +
      '要改能力口径,只有一处可改。',
  },
]

export const CHAT_MOCK = {
  turns: CHAT_TURNS,
} as const
