/**
 * **每一型块的流式注册契约 —— 五问,缺一问不许注册**(R4a,设计 §5.6 的块版)。
 *
 * 立这张表的理由是一条判例:六轮事故的元凶**全是政策渗进机制** —— 「未闭合的原子块
 * 按 code 画」「表头两行提前补分隔行」「成形之后不许降级」这些话,从前都直接写在
 * 增量解析器的函数体里。于是机制层每认识一种块就多长一根倒刺,而**每一根倒刺都是
 * 下一轮事故的落脚点**。
 *
 * 所以:机制(开块 / 追行 / 关块 / 容器栈 / 活尾槽)永不为任何一型开特例;
 * **政策由型自报**,住在它自己的注册契约里。加一种块 = 回答五个问题,机制一个字不改。
 *
 * ── 五问 ──────────────────────────────────────────────────────────────
 *  ① `midway`   流式中间态长什么样(半成品能不能画)
 *  ② `settled`  落定形与中间态是不是同一个渲染器
 *  ③ `failure`  画不出来时兜到哪儿
 *  ④ `identity` 身份号从哪儿来(memo 与零重挂的键)
 *  ⑤ `geometry` 没画完之前先占多大(媒体流的头号体感病:布局位移)
 *
 * 与库件那条「三类状态缺一不许入库」同款门槛 —— 沉默不是答案,「设计文档里没写」
 * 也不是。执法在 `BlockRegistry.register`:少答一问当场抛,不是 warn。
 */

/** ① 流式中间态。 */
export type BlockMidwayPolicy =
  /** 半成品照画,一行一行亮出来(段落 / 标题 / 未闭合围栏 / 引用 / 列表)。 */
  | 'grow'
  /**
   * 关块才渲 —— 半截画不出合法的样子(图、diff)。
   *
   * 注意这**不是**「流式期间显示成源码」:那条降级 09-01 已经撤掉(病历在
   * markdown/incremental.ts 的注里)。`hold` 说的是「这一型在合上之前不出现」,
   * 而它在流式期间由**别的型**代为呈现(围栏路由让它先当 `code(closed:false)`)。
   */
  | 'hold'

/** ② 落定形。 */
export type BlockSettledPolicy =
  /** 关块前后同一个渲染器,只是内容长齐了。 */
  | 'same'
  /**
   * 关块那一刻**原位换装**:流式期它以另一种 kind 在屏幕上(表 / 图 / diff 都由
   * `code(closed:false)` 代画),合上才换成自己。换装 = 换身份号 = React 重挂,
   * 这是对的:复用会把上一种块的状态(展开态、横滚位置)带进新组件。
   */
  | 'swap'

/** ③ 失败态。 */
export type BlockFailurePolicy =
  /** 兜到 `source-fallback`:源码永远可见(全系统的失败语义)。 */
  | 'source'
  /** 就地画一句诚实话(它自己已经**是**失败态的归宿了)。 */
  | 'honest'

/** ④ 身份号的产地。 */
export type BlockIdentityPolicy =
  /**
   * 产地派生:`${源偏移}:${kind}`。
   *
   * 直播 / 收尾 / 重折 / 冷加载四条路上逐字相同 —— 不透明计数器做不到这一条
   * (计数器活在一台机器实例里,重折换一台号就全变,那一刻整条消息重挂)。
   */
  | 'origin'
  /**
   * 内容地址派生(hash/ref)。今天没有消费者,给资产型(图片 / 视频 / 文件)留位:
   * 它们的字节走旁路解析,身份不该跟着「此刻解到哪一步」变。
   */
  | 'ref'

/** ⑤ 几何策略。 */
export type BlockGeometryPolicy =
  /** 随内容长,不预留 —— 纸上的一段字。 */
  | 'flow'
  /**
   * **先立骨架、再往里填**(R4b 兑现)。
   *
   * 答 `reserve` 的型向壳声明:我在流式期间会**先长出一个形**,内容后到 —— 壳因此
   * 在块身上挂 `data-geometry="reserve"`,由样式表把「内容后到不许把下面踹一脚」的
   * 那几条(滚动条槽常留、行高不随内容变)一次给全。
   *
   * 今天只有表答它:117 列的真机读数里,成表那一刻裸文本段落从 179px 塌到 22px,
   * 下面的内容整体上跳 157px —— 那一跳的根治是「压根别经过裸文本那一态」(commit
   * 政策),而这一格管的是**表自己**长起来时不许抖(滚动条出没造成的竖向位移)。
   */
  | 'reserve'

/**
 * **承诺(commit)政策** —— 正在出生的那一型自己认领活尾巴。
 *
 * 从前这是增量解析器里一段写死的 `upgradeTableTail`:它认识表、认识分隔行、认识
 * GFM 的列数规矩。R4a 把它翻成一问(那时叫 `earlyForm`),R4b 把它的野心从「补半截
 * 分隔行」推到「**行首第一根竖线就承诺**」—— 名字跟着换:补齐是手段,承诺才是这件事。
 *
 * 机制只负责三步,一步都不认识表:补一刀 → 重解析一次 → **子解析里真的出现了声明者
 * 那一型才认**,否则整段作废、一个字不改。
 *
 * ── 为什么返回的不是一个字符串 ────────────────────────────────────────
 * 补出来的字**一个都不上屏**,所以块的偏移必须能映射回真实文本。R4a 时补的那一刀
 * 永远落在活尾巴的**最末尾**(后面没有别的块),一句「末块的 end 夹回文本长度」就够;
 * R4b 的承诺会把分隔行插在**表头与数据行之间**(分隔行写错 / 漏写的那一形),
 * 插入点后面还有块 —— 它们的偏移得整体左移,不然身份号会指到文本外面去。
 * 所以政策要连**补在哪儿、补了多少**一起交出来。
 *
 * ── 单调性由**构造**保证,不由记账保证 ────────────────────────────────
 * 「承诺不可逆」不需要一本承诺账:判据只许在文本增长时从假变真。唯一一处故意的反向
 * 是「分隔行写完了而格数对不上」—— 那不是反悔,是事实变得可知(理由写在
 * markdown/table-tail.ts 的 `SEPARATOR_MISMATCH` 段)。
 */
export interface BlockCommitResult {
  /** 补齐之后的源文本(喂给解析器的脚手架版本)。 */
  text: string
  /** 补的那一段落在**原文**的哪个下标。 */
  insertAt: number
  /** 净补了多少个字符(可为负 = 净删)。 */
  insertLen: number
}

/**
 * @param source 活尾巴那一块的源文本(贴着流末尾的那一段)
 * @returns 补齐结果;认不出就 `undefined`(最坏情况白算一次)
 */
export type BlockCommit = (source: string) => BlockCommitResult | undefined

export interface BlockStreamContract {
  midway: BlockMidwayPolicy
  settled: BlockSettledPolicy
  failure: BlockFailurePolicy
  identity: BlockIdentityPolicy
  geometry: BlockGeometryPolicy
  /** 可选的第六格:承诺。没有就是「等解析器自己认出来」。 */
  commit?: BlockCommit
}

/** 五问的键 —— 执法与文档共用一份,免得两处各列一遍。 */
export const BLOCK_STREAM_QUESTIONS = [
  'midway',
  'settled',
  'failure',
  'identity',
  'geometry',
] as const

/** 少答哪一问?答不上来就返回 `undefined`(注册合法)。 */
export function missingStreamAnswer(contract: BlockStreamContract | undefined): string | undefined {
  if (!contract) return BLOCK_STREAM_QUESTIONS.join(' / ')
  const missing = BLOCK_STREAM_QUESTIONS.filter((key) => contract[key] === undefined)
  return missing.length > 0 ? missing.join(' / ') : undefined
}
