#!/usr/bin/env node
/**
 * 流式**块结构**门(09-01 用户录屏报障:「用 agent 时,流式渲染中 think、table
 * 等内容会出现再消失,再出现」;09-01 二期扩到工具路径)。
 *
 * ── 它与 gate:monotone 的分工 ──────────────────────────────────────────
 * `gate:monotone` 量的是**正文总长**不回缩,素材纯正文、没有推理也没有表。这条报障
 * 恰恰落在它盖不到的两格上:
 *
 *  · 一整块思考消失时,后面的正文还在继续长 —— **总长曲线可以是单调的**;
 *  · 表格在 code ↔ table 之间来回换装,总长的涨落被别处的增长盖住。
 *
 * 所以这条门量的是**结构**:逐帧记下最后一条 assistant 消息里每一件东西的类型、
 * 位置、身份与文本,断言七条纪律。
 *
 * ── 素材 × 粒度矩阵 ────────────────────────────────────────────────────
 * 一期只有一条素材、一档粒度,而且**刻意关掉了工具**(`enableToolCalls:false`)——
 * 09-01 的勘察正是在那块空白里抓到最疼的一条病(多轮工具的正文错位再消失 992ms)。
 * 二期扩成矩阵:
 *
 *   think × {6, 2} 字/帧   推理 ↔ 正文交替 + 一张逐行长出来的表(A/B/C)
 *   tool  × {6, 2} 字/帧   三轮工具:说话 → 连查两次 → 说话 → 再查一次 → 收尾(D/E/F/G)
 *   table × {6, 2} 字/帧   13 列宽表 + 表前不空行 + 分隔行未闭尾 + 缩进表(I/J/K)
 *   mixed × {7} 字 / **7ms**  真机节奏:两轮 + 工具 + 围栏 + 八列宽表(L/M)
 *
 * 粒度是第二根轴,因为分片越细、一个块「半成形」的帧数越多:真机上 SSE 分片不等长,
 * 2 字/帧是它的下界包络。
 *
 * ── 七条断言(各自钉一条真机病)────────────────────────────────────────
 *  A. **思考块只增不减**(think)。修前:t=7441ms `[think,text,think]` →
 *     `[think,text]`,整段思考没了 2166ms 才回来。
 *  B. **思考块不搬家**(think)。钉交接的顺序闸。
 *  C. **表格成形后不再降级回 code**(think)。修前一条流里降级 17 帧。
 *  D. **工具边界的正文零消失**(tool)。修前真机逐帧:
 *     ```
 *     t=6839  think | text(14) | text(28) | tool-group   ← 第二轮正文在工具组上面
 *     t=6864  think | text(14) | tool-group | think(6)   ← 整段 28 字消失
 *     t=7856  think | text(14) | tool-group | text(28) | …  ← 992ms 后从下面回来
 *     ```
 *     病根:账本的 `message.content` 是全部正文,而 `contentParts` 只有已结算那几轮
 *     —— 交接把新一轮的正文交给了那条**turn 盲**的扁平车道(见 chat-fold 的
 *     `FoldLens.contentPlaceable`)。
 *  E. **正文不许跨过工具**(tool)。同一段正文在相邻两帧里,它前面有几个工具容器
 *     必须相等 —— D 那条病如果换个形(不消失、直接跳过去)由这条抓。
 *  F. **工具那一件东西零重挂**(tool)。修前:第二次调用到达时单卡整行替换成组卡
 *     (t=6614,DOM 不是同一个节点),违反「列表 key 稳定,禁整树重挂」。
 *     判据是 DOM 节点身份:采样器给每个节点盖一次号,同一位次的工具容器换号即红。
 *  G. **参数流式期屏幕上有东西**(tool)。修前:说完一句话之后 309ms 零呈现
 *     (`tool:input-start` t=1693ms 就到了,而屏幕要等 `tool/call` t=1929ms)。
 *  H. **零双画**(全素材)。同一截源文本任一时刻只许被画一次 —— 用户证词
 *     「显示原始字符串,其实 table 已经画出来了」。
 *  I/J/K. **表**(table):一帧都不许以源码示人 / 在分隔行流完之前就成形 /
 *     缩进四格的表照旧是代码块(CommonMark 正解,我们不乱改)。
 *  L. **块不许整批消失**(mixed)。自查帧证:`t=3659` 一帧里块数 2→0、
 *     正文 786→371,下一帧原样回来 —— `appendTail` 从前"没尾巴就掉头",
 *     于是账本 parts 还画不到的那一截也没人画。
 *  M. **表成形之后不许退回裸文本**(mixed)。同一现场的后半段:交接线漂了几个字,
 *     分隔行多一格 / 少几个字,表头列数对不上,GFM 判它不是表,裸文本 350ms+。
 *
 * 每一格另有一条 **流式末帧 == 冷加载**:刷新重进会话,块序逐格相同。
 *
 * ── 三个测量坑(照抄 09-01 勘察的记录,别再踩一遍)──────────────────────
 *  1. 非前缀率若拿整条消息的 textContent 量会是 22–24%,其中 98% 是消息尾那行
 *     `Generating · N.Ns` **在跳秒**。所以可见文本只由采到的那几件东西拼,读数行
 *     根本不在采样口径里。
 *  2. 只挡 `chat-thought / data-block-kind / data-tool-group` 三种祖先会把 flow 块
 *     **自己带的** `data-prose` 重复计一遍(`<blockquote data-prose>` 里的 `<p>`),
 *     凭空多出几百次「换型」。判据必须是「身上有任何 `data-prose` 祖先的都不算一件
 *     东西」。
 *  3. 帧间身份**不能用文本头字认**:markdown 成形时块内文本会合法地非前缀变化
 *     (字面 `1.` → 生成序号、檐从 `Copy source` → `Copy Markdown`)。必须按节奏档
 *     做 LCS 对齐 —— 插入不算搬家,成长不算消失。
 *
 * 跑法:`node scripts/gate-stream-structure.mjs [--only=think|tool]`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每格一个全新的临时 store,跑完删干净;起的进程在 finally 里逐个收尸。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ── 素材一:推理 ↔ 正文交替 + 一张表 ─────────────────────────────────── */

const THINK_1 =
  '先看清楚要做什么。素材里既有思考也有正文,还有一张表。要量的是:思考段在打包行到达的那一刻会不会从屏幕上消失。这一段要写得足够长,长到跨过两秒那道打包闸,不然打包行根本不会来。再补几句凑长度,让这一段思考至少两百个字符往上,确保它自己就吃掉一整个打包窗。'
const TEXT_1 = '先说结论:这条链路是通的。下面按步骤展开,每一步都给出可以复核的读数。'
const THINK_2 =
  '第二段思考。它开在正文之后,所以是**行内推理**而不是顶部推理 —— 落点不同,尾巴里的去处也不同。行内推理在流式期间没有物化成 part,打包行若把它从尾巴前端裁走,屏幕上就没有第二个产地。这正是 A 条要钉的那件事。再写长一点,凑过打包闸。'
/*
 * 表**故意长**(12 行往上,400 字符往上)。
 *
 * 打包闸是「段收尾 / 64 条 delta / 2000ms 三者先到」,6 字/帧时 2000ms ≈ 264 字符
 * —— 表短于这个数就可能整张被一条打包行一口吃掉,量不到「表流到一半账本先物化」
 * 那一刻。而 09-01 用户报的那条正是这一刻:**「显示原始字符串,其实 table 已经
 * 画出来了」——渲染出来的表与它的原始 markdown 同屏并存**。
 *
 * 每一行埋一个只出现一次的记号(`TK*`),H 条数它在一帧里出现几次:**同一截源文本
 * 任一时刻只许被画一次**(要么是表,要么是原文,不许并存)。
 */
const TEXT_2 = [
  '',
  '| 项 | 状态 | 备注 |',
  '| --- | --- | --- |',
  '| 传输 | 真 | TKA1 POST /api/rpc |',
  '| 账本 | 真 | TKB2 events.jsonl |',
  '| 表格 | 真 | TKC3 需要整行结构才成形 |',
  '| 归档 | 真 | TKD4 冷加载走全量解析 |',
  '| 校验 | 真 | TKE5 增量必须等于全量 |',
  '| 交接 | 真 | TKF6 账本画得出来多少就交多少 |',
  '| 锚点 | 真 | TKG7 工具卡插在它发生的那处 |',
  '| 节拍 | 真 | TKH8 十六毫秒一批 |',
  '| 打包 | 真 | TKI9 两秒一道闸 |',
  '| 重折 | 真 | TKJ10 缺号就整会话重折 |',
  '| 尾巴 | 真 | TKK11 还没进打包行的那一截 |',
  '| 冷热 | 真 | TKL12 两条路必须逐格相同 |',
  '',
  '表格上面一段 TKM13,表格下面一段 TKN14 —— 中间那张表在流式期间要逐行长出来。',
].join('\n')
const THINK_3 =
  '第三段思考,继续往后拖时间,让整条流跨过又一道打包闸。写满两百字以上,确保每一段都各自经历一次打包行到达。这里再补一些字,把长度垫够,免得整段被一次打包行一口吃掉,那样就量不到交接的那一刻了。'
const TEXT_3 = '最后一段正文收尾,`行内代码` 与 **加粗**,把这条流收干净。'

const THINK_SCRIPT = [
  ['reasoning', THINK_1],
  ['content', TEXT_1],
  ['reasoning', THINK_2],
  ['content', TEXT_2],
  ['reasoning', THINK_3],
  ['content', TEXT_3],
]

/* ── 素材二:三轮工具 ──────────────────────────────────────────────────
 *
 * 选 `time` 是因为它零副作用、必然回来,不会卡在权限审批上(卡住的话探针只会超时)。
 * 参数**故意写长**(一个 40 字往上的 JSON):要量的正是「参数逐片到达的那一段时间里
 * 屏幕上有没有东西」(G),短参数量不出来。
 *
 * **不放表格、不放围栏**:markdown 起手式先以字面上屏、成形时换装,那是另一档已知
 * 的「合法但可见」(勘察 §2.4/§2.5,属行为裁定未拍板)。混进来只会让 D 那条断言分不清
 * 是「工具边界丢了正文」还是「表格正在成形」—— 一条断言只钉一件事。
 */
const TOOL_TURNS = {
  1: async ({ say, callTool, finish }) => {
    await say('reasoning', '先想一下要做什么 TKT3。这一段推理要长一点,跨过两秒那道打包闸:甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥,天地玄黄宇宙洪荒日月盈昃辰宿列张。想完之后我要连着查两次时间,一次上海一次协调世界时。')
    await say('content', '我先查一下时间,连着查两次。\n')
    await callTool(0, 'call_a', 'time', '{"action":"now","timezone":"Asia/Shanghai","format":"iso8601"}')
    await callTool(1, 'call_b', 'time', '{"action":"now","timezone":"UTC","format":"iso8601"}')
    finish('tool_calls')
  },
  2: async ({ say, callTool, finish }) => {
    // ★ 这一段就是修前消失 992ms 的那一段:第二轮的正文,前面是工具、后面还是工具。
    // TKT1 埋在这里:它走的正是新开的那条「账本 parts 画不到、由 content 补出来」
    // 的车道 —— 补出来的那一截若与尾巴里那一截重叠,记号会在一帧里出现两次(H)。
    await say('content', '\n拿到了 TKT1。下面这段正文夹在两次工具之间,要看它落在哪一边。\n')
    await say('reasoning', '工具结果回来之后的一段行内推理 TKT2。它前面是工具、后面还是工具,正是「工具与正文、推理夹杂」那一格。再补些字跨过打包闸:云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜。')
    await callTool(0, 'call_c', 'time', '{"action":"now","timezone":"America/New_York","format":"iso8601"}')
    finish('tool_calls')
  },
  3: async ({ say, finish }) => {
    await say('content', '\n三次时间都拿到了,收尾一句 `行内代码` 把这条流收干净。上面那段正文要一直待在两组工具之间,一帧都不许走开。\n')
    finish('stop')
  },
}

/**
 * 每条素材里**只出现一次**的记号 —— H 条(零双画)数的就是它们。
 *
 * 判据一句话:**同一截源文本,任一时刻只许被画一次**。渲染出来的表里有 `TKA1`,
 * 它的原始 markdown 里也有 `TKA1` —— 两者同屏就是一帧里数到 2。
 */
const TOKENS = {
  think: [
    'TKA1', 'TKB2', 'TKC3', 'TKD4', 'TKE5', 'TKF6',
    'TKG7', 'TKH8', 'TKI9', 'TKJ10', 'TKK11', 'TKL12', 'TKM13', 'TKN14',
  ],
  // TKT2 / TKT3 埋在两段推理里(R3 浸泡首单取证:推理内容此刻穿的是哪件衣服)。
  tool: ['TKT1', 'TKT2', 'TKT3'],
  mixed: ['TKX1'],
  pack: ['TKP1', 'TKP2'],
  table: ['TKW1', 'TKW2', 'TKI1'],
  monster: ['TKM1', 'TKM2', 'TKM3'],
  nested: ['TKN1', 'TKN2', 'TKN3'],
  reasontool: ['TKR1', 'TKR2'],
  // 无正文变体:用户截图的真形(推理直接接工具,整条消息一个字正文都没有)。
  reasonbare: ['TKR1', 'TKR2'],
  midjoin: ['TKJ0', 'TKJ1'],
}

/**
 * 素材三:**表**(09-01 用户复测报障 + 录屏)。
 *
 * 四样都在一条流里,一次跑完:
 *  · **13 列宽表 + 对齐冒号**(真机截图那一形:列越多,分隔行流得越久);
 *  · **表前不空行**(正文紧跟表头 —— 模型的常见形,实测 GFM 允许表打断段落);
 *  · **分隔行未闭尾**(流式期间每一帧都是这个状态,嫌疑 D 的现场);
 *  · **缩进四格的表**(CommonMark 里它就是缩进代码块 —— 门钉住我们**不乱改**它)。
 *
 * `rowSafe` 是这条素材最要紧的一格:**分片永不落在换行上**。真机 provider 的分片
 * 与 coalescer 的批次都是任意长度,一帧的文本结束在换行上纯属偶然 —— 录屏里那张
 * 八行表一次都没赶上。旧判据(`text.endsWith('\n')` 才升回 table)正是靠这份偶然
 * 活着的,慢分片的门每行都能赶上,于是从来没红过。把偶然去掉,门才照见真机。
 */
const TABLE_HEAD =
  '| 项目 TKW1 | 负责人 | 阶段 | 开始 | 结束 | 工时 | 进度 | 风险 | 优先级 | 依赖 | 状态 | 备注 | 验收 |'
const TABLE_SEP =
  '| :---: | :---: | :---: | :---: | :---: | :---: | ---: | :--- | :---: | :---: | :---: | :--- | :---: |'
const TABLE_ROW = (n, mark = '') =>
  `| 排期${n}${mark} | 甲乙 | 设计 | 09-0${n} | 09-1${n} | ${n}0 | ${n}0% | 低 | P${n} | 无 | 进行中 | 说明${n} | 待验 |`

const TABLE_SCRIPT = [
  ['reasoning', '先想清楚这张表要几列。列多的表分隔行本身就长,分隔行没到齐之前它按 GFM 的定义还不是表 —— 那正是要量的那一段。再补些字跨过打包闸:甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥。'],
  // ★ 正文与表头之间**故意不空行**:模型的常见形,实测 GFM 照样成表。
  ['content', `下面是排期表,一共十三列。\n${TABLE_HEAD}\n${TABLE_SEP}\n`],
  ['content', `${TABLE_ROW(1)}\n${TABLE_ROW(2, ' TKW2')}\n${TABLE_ROW(3)}\n${TABLE_ROW(4)}\n${TABLE_ROW(5)}\n`],
  ['content', '\n表下面这一段正文要一直在。下面再给一段**缩进四格**的表 —— 它在 CommonMark 里就是缩进代码块,我们不许自作主张把它改成表:\n\n'],
  ['content', '    | 名称 TKI1 | 值 |\n    | --- | --- |\n    | 甲 | 一 |\n'],
  ['content', '\n收尾一句 `行内代码`。\n'],
]

/**
 * 素材四:**真机节奏的混合体**(09-01 自查走查 `scratchpad/self-check-0901/` 帧证)。
 *
 * 前三条素材都是 45ms 一片的慢流,而真机 provider 是 **7 字 / 7ms**(约 1000 字/秒)。
 * 自查用真机节奏跑出两条前三条素材照不见的形:
 *
 *  · `t=3659` 一帧里**块数 2→0、正文 786→371**,下一帧原样回来(~17ms);
 *  · 那之后表**退回裸文本 433ms**(`| 宿主 | 工具档 |…` 明文在屏上),
 *    直到分隔行整行到齐才重新成表。
 *
 * 两条都不在 markdown 那一层:同一段源文本按 7 字/帧喂进 `MarkdownStream`,裸段落
 * 只有 56 个字符(表头那一行),表在分隔行流完之前就成形(单测 zz 记录)。所以这
 * 条素材要照真机的样子把**数据层**也拉进来:两轮 + 工具 + 围栏代码块 + 八列宽表。
 */
const MIXED_CODE = [
  '```ts',
  'export async function createOnethingBackend(options: OnethingBackendOptions) {',
  '  const stores = await createStores(options)',
  '  const settings = await loadSettings(stores)',
  '  const engine = new ProductStreamEngine(streamRuntime, ports)',
  '  return { engine, eventBus, streamChannel, shutdown: () => engine.stop() }',
  '}',
  '```',
].join('\n')
const MIXED_TABLE = [
  '| 宿主 TKX1 | 工具档 | 发送目标 | 会话技能 | MCP/ACP | 拥有后端 | 进程级端口 | 备注 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| Electron 桌面 | full | webContents | 否 | 窗口后 | 是 | 自己拥有 | 同时挂内嵌 HTTP 面 |',
  '| 无头服务端 | full | noop(SSE 观察总线) | 是 | 否 | 否 | host 档不抢 | 单用户,Bearer 鉴权 |',
  '| CLI 守护进程 | headless | noop | 是 | 是 | 是 | 自己拥有 | NDJSON over unix socket |',
].join('\n')

const MIXED_TURNS = {
  1: async ({ say, callTool, finish }) => {
    await say('reasoning', '先看清楚要答什么。这一段推理要长到跨过打包闸:甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥,天地玄黄宇宙洪荒日月盈昃辰宿列张。想完之后我要查一次时间,再把装配那一段抄出来。')
    await say('content', '先说结论:**装配只有一条路**,顺序约束写在工厂函数里,别处一个字都不写。\n\n### 三层的边界\n\n产品层不许 import 装配层。这一条由静态门守着,不靠自觉。\n\n- 骨架层零依赖,零 Electron\n- 产品层电子自由\n- 装配层可以说跨进程的词汇\n\n> 一个反复踩的坑:命令是 COW 的。\n\n我先查一下时间。\n')
    await callTool(0, 'call_m', 'time', '{"action":"now","timezone":"Asia/Shanghai"}')
    finish('tool_calls')
  },
  2: async ({ say, finish }) => {
    // ★ 第二轮:围栏代码块 + 八列宽表 —— 自查帧证里出事的正是这一段。
    await say('content', `\n拿到了。装配的入口长这样:\n\n${MIXED_CODE}\n\n各宿主的配置对照(这张表故意很宽):\n\n${MIXED_TABLE}\n\n行内的 \`createOnethingBackend()\` 与链接 [设计文档](https://example.com/design) 都在这一段里。\n\n最后一段普通正文,用来量段距。\n`)
    finish('stop')
  },
}

/**
 * 素材五:**静默窗**(R2 第六不变式:存储节拍不进显示路径)。
 *
 * 打包行是给磁盘定的节奏(2s / 64 条),凭什么被显示器听见?这条素材把它**单独关
 * 起来量**:说一段话,然后**闭嘴 2.6 秒**(跨过那道 2s 闸),再说一段。静默那一段里
 * 没有任何 delta,屏幕上**只可能**因为打包行而变 —— 所以「那几百帧逐帧一模一样」
 * 就是「打包行到达零像素变化」的直证。
 *
 * 断言写成「同长不同形 = 0」而不是「静默窗里帧全同」:前者对整条流都成立(delta 在
 * 长的时候总长在涨,只有打包行会造出**长度没变而画面变了**的那一帧),后者只盖静默
 * 那一段。两条都要,一条证形一条证窗。
 */
const PACK_SCRIPT = [
  ['reasoning', '先想一段,长到跨过打包闸:甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥,天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏。'],
  ['content', '第一段正文 TKP1,说完之后我要闭嘴两秒六,让打包行在没有任何 delta 的窗口里独自到达。'],
  ['silence', 2600],
  ['content', '\n\n第二段正文 TKP2,静默结束。'],
]

/**
 * 素材六:**怪物表**(R4b,09-01 用户两张截图为验收素材)。
 *
 * 两张表,各钉一条:
 *
 *  · **117 列**(截图一):列越多,分隔行流得越久 —— 13 列的分隔行 106 字符已经让
 *    表头裸挂 556ms,117 列的分隔行 700 字符往上。这条素材把「裸文本数秒」推到极端,
 *    同时量三件事:承诺(R)、竖向抖动(P)、削列(Q)。
 *  · **分隔行写错**(截图二):表头三格、分隔行两格 —— GFM 判它**不是表**,
 *    照既有拍板「模型写错照实画」它收尾必须是段落。承诺期它当过表(S 条量翻面次数,
 *    钉「一次性,不来回」)。
 *
 * 节拍取 12 字 / 12ms:这张表 3500 字符往上,按素材三的 6 字 / 45ms 要跑近半分钟。
 * `rowSafe` 照旧 —— 分片永不落在换行上(素材三那条学费:靠偶然活着的判据照不见真机)。
 */
const MONSTER_COLS = 117
const monsterCells = (make) => `| ${Array.from({ length: MONSTER_COLS }, (_, i) => make(i)).join(' | ')} |`
const MONSTER_HEAD = monsterCells(i => (i === 0 ? '字段 TKM1' : `列${i + 1}`))
const MONSTER_SEP = monsterCells(() => '---')
const MONSTER_ROW = n => monsterCells(i => (i === 0 ? `行${n}${n === 2 ? ' TKM2' : ''}` : `v${n}.${i + 1}`))
/** 表头三格、分隔行两格 —— GFM 判它不是表。收尾照实画成段落。 */
const MONSTER_BROKEN = ['| 名称 TKM3 | 值 | 备注 |', '| --- | --- |', '| 甲 | 一 | 二 |'].join('\n')

/**
 * 「裸挂」的预算。承诺在**行首 `|` 之后第二根竖线到达那一刻**做出,所以正常读数是
 * 0–1 帧(12 字/帧 ≈ 12ms,加上 rAF 采样粒度 ≈ 16ms)。给到 200ms 是一倍余量;
 * 修前(R4a 的 earlyForm 要等半截分隔行)这个数是**秒**级,一条判据把两边分开。
 */
const MONSTER_NAKED_BUDGET_MS = 200

/** 抓图节拍(只在 `STRUCT_SHOTS` 诊断口下用)。 */
const SHOT_INTERVAL_MS = 500

const MONSTER_SCRIPT = [
  ['reasoning', '先想清楚这张表有多宽。一百一十七列的分隔行本身就有七百多个字符,分隔行没到齐之前它按 GFM 的定义还不是表 —— 那正是用户截图里裸挂着的那一段。'],
  ['content', `下面是那张一百一十七列的宽表。\n${MONSTER_HEAD}\n${MONSTER_SEP}\n`],
  ['content', `${MONSTER_ROW(1)}\n${MONSTER_ROW(2)}\n${MONSTER_ROW(3)}\n`],
  ['content', `\n下面这张的分隔行写错了(表头三格、分隔行两格),按拍板要照实画:\n\n${MONSTER_BROKEN}\n`],
  ['content', '\n收尾一句 `行内代码`。\n'],
]

/**
 * 素材七:**嵌套**(R4b,容器栈那一格的守夜人)。
 *
 * 引用里的清单、清单项里的围栏、引用套引用 —— 这三形是「嵌套靠容器栈」那条设计
 * 落地之后**最容易走样**的地方。容器迁移本身这一批没做(理由见回报的裁定点),
 * 但素材先进门:等到真迁的那一天,「流式末帧 == 冷加载」与零双画就是现成的守卫,
 * 不必等出了事才补。
 */
const NESTED_SCRIPT = [
  ['reasoning', '先想清楚嵌套要覆盖哪几形:引用里的清单、清单项里的围栏、引用套引用。再补些字跨过打包闸:甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥。'],
  ['content', '下面是三形嵌套。\n\n> 引用里装一张清单 TKN1:\n>\n> - 第一条\n> - 第二条\n>   - 第二条的子项\n\n'],
  ['content', '- 清单项里装一段围栏 TKN2:\n\n  ```sh\n  npm run verify\n  ```\n\n- 清单项里装一张表:\n\n  | 名 | 值 |\n  | --- | --- |\n  | 甲 | 一 |\n\n'],
  ['content', '> 引用套引用 TKN3:\n>\n> > 里面这一层小一号。\n\n收尾一句 `行内代码`。\n'],
]

/**
 * 素材八:**工具结果之后新到的推理**(R3 浸泡首单第二轮取证,用户反证词)。
 *
 * 用户对「甲」的反证:「思考确实还在继续 —— 我截图那一刻它在流,工具调用确实在它
 * 下面」。上一轮的取证有一格没盖住:证了记号住在**思考件**里(T)、既有段不搬家
 * (A/B),但**没有证过新推理开在哪个位置** —— 若第二段推理被并进上方那个既有思考
 * 段(`message.reasoning` 是顶部推理字段,永远画在消息顶),上面每一条断言照样绿,
 * 病却在。
 *
 * 所以这条素材是**真实多请求回合**(engine 的 requestIndex 真的往前走,不是一个请求
 * 里连着说两段推理):
 *
 *   请求 1:推理(1) TKR1 → 正文 → 两次工具调用
 *   请求 2:**推理(2) TKR2(几百字慢流)** → 又一次工具调用   ← 用户截图的那一刻
 *   请求 3:收尾正文
 *
 * 并存窗口因此足够长(推理(2) 三百字往上,6 字/帧 ≈ 2.3 秒),而且它上面有一次工具、
 * 下面还会长出一次 —— 与用户截图里「think 还在,下面有一个工具调用」逐格对上。
 */
const REASON_LONG = [
  '第二段推理 TKR2。工具结果回来了,现在要想清楚下一步写什么。',
  '这一段故意写得长:几百字慢流才撑得开并存窗口,而并存窗口正是用户截图的那一刻 ——',
  '推理还在往下长,而工具调用行已经在它下面立着。',
  '甲乙丙丁戊己庚辛壬癸,子丑寅卯辰巳午未申酉戌亥,天地玄黄宇宙洪荒,日月盈昃辰宿列张,',
  '寒来暑往秋收冬藏,闰余成岁律吕调阳,云腾致雨露结为霜,金生丽水玉出昆冈,',
  '剑号巨阙珠称夜光,果珍李柰菜重芥姜,海咸河淡鳞潜羽翔,龙师火帝鸟官人皇。',
  '再补一段,确保这一请求的推理跨过打包闸,让账本至少物化一次,把「行内推理在流式期',
  '画不出来、顶部字段是唯一出口」那条嫌疑真正暴露在采样窗里。',
].join('')

const REASON_TOOL_TURNS = {
  1: async ({ say, callTool, finish }) => {
    await say('reasoning', '第一段推理 TKR1。先想清楚要做什么,这一段要长到跨过打包闸:甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥,天地玄黄宇宙洪荒日月盈昃辰宿列张。想完之后我要查一次时间。')
    await say('content', '我先查两次时间。\n')
    /*
     * **两次**调用不是随口写的:mock 的轮次派发按「已经回来了几条 tool 消息」算
     * (与真实 agent-loop 同口径,见 startMockProvider),0 条 → 第 1 轮、≤2 条 → 第 2 轮、
     * 更多 → 第 3 轮。turn 1 只发一次调用的话,turn 2 发完自己那一次仍只有 2 条 tool
     * 消息 —— **第 2 轮会被跑第二遍**,推理(2) 于是真的被说了两遍,H 条(零双画)当场
     * 红在素材自己身上。第一版就踩了这个坑,记在这里。
     */
    await callTool(0, 'call_r1a', 'time', '{"action":"now","timezone":"Asia/Shanghai","format":"iso8601"}')
    await callTool(1, 'call_r1b', 'time', '{"action":"now","timezone":"UTC","format":"iso8601"}')
    finish('tool_calls')
  },
  2: async ({ say, callTool, finish }) => {
    // ★ 用户现场:工具结果之后**新到**的推理,而且它下面还会再长出一次工具调用。
    await say('reasoning', REASON_LONG)
    await callTool(0, 'call_r2', 'time', '{"action":"now","timezone":"America/New_York","format":"iso8601"}')
    finish('tool_calls')
  },
  3: async ({ say, finish }) => {
    await say('content', '\n三次时间都拿到了,收尾一句 `行内代码`。\n')
    finish('stop')
  },
}

/**
 * 素材九:**一个字正文都没有**的多请求回合(用户截图的真形)。
 *
 * 用户那条消息里看不到正文 —— 推理之后直接就是 `write` 工具(264 lines)。这一格
 * 单独立出来,是因为**引擎判「顶部推理」的判据正是「这一轮还没有任何可见活动」**
 * (`getAgentLoopReasoningPlacement`:`turnIndex === 1 && 正文为空 && 本轮无可见活动`
 * → `top`,否则 `inline`)。素材八的第一轮里有一句正文,恰好把这条判据的边界让过去了;
 * 这一格把正文全部拿掉,让第一轮的推理**真的**落在 `top`,再看第二轮的推理站在哪儿。
 *
 * 旧路(`--r2=off`)在这一格上还多一条兜底(`placement ?? (有正文 ? inline : top)`),
 * 新路没有(缺席即 inline)—— 两条路的判据在这一格上第一次不一样,所以两条都要跑。
 */
const REASON_BARE_TURNS = {
  1: async ({ say, callTool, finish }) => {
    // ★ 一个字正文都不发 —— 直接推理 → 工具。
    await say('reasoning', '第一段推理 TKR1。这条消息一个字正文都不会有,想完直接调工具:甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥,天地玄黄宇宙洪荒日月盈昃辰宿列张。')
    await callTool(0, 'call_b1a', 'time', '{"action":"now","timezone":"Asia/Shanghai","format":"iso8601"}')
    await callTool(1, 'call_b1b', 'time', '{"action":"now","timezone":"UTC","format":"iso8601"}')
    finish('tool_calls')
  },
  2: async ({ say, callTool, finish }) => {
    await say('reasoning', REASON_LONG)
    await callTool(0, 'call_b2', 'time', '{"action":"now","timezone":"America/New_York","format":"iso8601"}')
    finish('tool_calls')
  },
  3: async ({ say, finish }) => {
    await say('content', '\n三次时间都拿到了。\n')
    finish('stop')
  },
}

/**
 * 素材十:**中途入场 / 重连**(09-02,编排者读源码审出的真回归)。
 *
 * 链是三段合起来才成立的,单看每一段都对:
 *  ① `contentParts` 只在 `requestSettled` 之后物化;
 *  ② `anchorMessage` 只在 parts **整个为空**时才回落 `message.content`;
 *  ③ 水位表按连续前缀律把「中途入场收到的第一条 delta(偏移不为 0)」丢掉。
 * 于是**当前这一个请求已经流出来的正文一个字都不画**,直到 `run/end`。而「账本
 * ≤2s 自愈」在这里不成立:打包行只让 `message.content` 变长,不物化 parts。
 *
 * 复现要两个条件同时成立,少一个就照不见:
 *  · **前面得有一个已经结算的请求**(否则 parts 整个为空,②那条回落把它救了);
 *  · **壳要来晚**(`lateOpen`:先开流、隔 `LATE_OPEN_MS` 再开会话)。
 * 所以第一轮走「正文 + 两次工具」把请求 0 结算掉,第二轮是一段长正文 —— 壳正好在
 * 那一段还在流的时候进场。
 *
 * 第二段验的是**重连**:进场之后再退回总览、再点回来(壳重新 `open`,水位整份丢),
 * 而那一轮还在流 —— 与断线重连是同一形。
 */
const MIDJOIN_LONG = [
  '第二个请求的正文 TKJ1。这一段要够长,好让壳在它还在流的时候才进场 ——',
  '「中途入场」的定义就是壳来晚了:第一条 delta 的偏移不为 0,按连续前缀律被丢掉,',
  '所以这一段既不在水位、也不在 parts(它所属的请求还没结算)。屏幕上要是一个字都',
  '没有,那就是这条回归。甲乙丙丁戊己庚辛壬癸,子丑寅卯辰巳午未申酉戌亥,',
  '天地玄黄宇宙洪荒,日月盈昃辰宿列张,寒来暑往秋收冬藏,闰余成岁律吕调阳,',
  '云腾致雨露结为霜,金生丽水玉出昆冈,剑号巨阙珠称夜光,果珍李柰菜重芥姜,',
  '海咸河淡鳞潜羽翔,龙师火帝鸟官人皇,始制文字乃服衣裳,推位让国有虞陶唐。',
  '再补一段把长度垫够,好让「退回总览再点回来」那一下也落在这一轮里。',
].join('')

const MIDJOIN_TURNS = {
  1: async ({ say, callTool, finish }) => {
    // 第一轮:正文 + 两次工具 —— 目的只有一个,把请求 0 结算掉(有 parts 了,
    // 「parts 整个为空就回落 content」那条兜底才不会把病盖住)。
    await say('content', '第一个请求的正文 TKJ0,它会结算。\n')
    await callTool(0, 'call_j1', 'time', '{"action":"now","timezone":"Asia/Shanghai","format":"iso8601"}')
    await callTool(1, 'call_j2', 'time', '{"action":"now","timezone":"UTC","format":"iso8601"}')
    finish('tool_calls')
  },
  2: async ({ say, finish }) => {
    await say('content', `\n${MIDJOIN_LONG}\n`)
    finish('stop')
  },
}

/** 壳晚多久进场 —— 要落在第二轮那段长正文还在流的时候。 */
const LATE_OPEN_MS = 2500

const CASES = {
  think: { tools: false, pieces: [6, 2] },
  tool: { tools: true, pieces: [6, 2] },
  table: { tools: false, pieces: [6, 2], script: TABLE_SCRIPT, rowSafe: true },
  // 真机节奏:7 字 / 7ms(自查探针实测的 provider 分片),分片随机落 —— 不 rowSafe。
  mixed: { tools: true, pieces: [7], delayMs: 7, turns: MIXED_TURNS },
  pack: { tools: false, pieces: [6], script: PACK_SCRIPT },
  // `geometry: true` 让采样器多量两个数(块顶 / 块高)—— 只这一格开,别的格读数
  // 与从前逐字可比(逐帧强制 layout 是有代价的,不能白白摊到所有素材上)。
  monster: { tools: false, pieces: [12], delayMs: 12, script: MONSTER_SCRIPT, rowSafe: true, geometry: true },
  // 节拍放慢到 25ms:这条素材短(450 字符上下),太快会让采样帧数贴着「>100 帧」
  // 那条门槛,读数余量不够。
  nested: { tools: false, pieces: [7], delayMs: 25, script: NESTED_SCRIPT, rowSafe: true },
  reasontool: { tools: true, pieces: [6], turns: REASON_TOOL_TURNS },
  reasonbare: { tools: true, pieces: [6], turns: REASON_BARE_TURNS },
  midjoin: { tools: true, pieces: [6], turns: MIDJOIN_TURNS, lateOpen: true },
}

const TRIGGER = 'STREAM_STRUCTURE_GATE'
const PIECE_DELAY_MS = 45 // 默认节奏;`delayMs` 的素材各自覆盖(mixed 用真机的 7ms)

/* ── 假慢流 provider ──────────────────────────────────────────────────── */

/** 当前这一格的分片粒度 —— 同一个 mock 服务两格(省一次 electron 冷启)。 */
const mockState = { piece: 6, tools: false, script: undefined, rowSafe: false, delay: 45, turns: undefined }

/**
 * 切分片。`rowSafe` 时**一片都不许结束在换行上** —— 真机分片就是这样(结束在换行上
 * 纯属偶然),而旧的表格降级判据恰恰靠那份偶然才会退出。
 */
function pieces(text) {
  const size = mockState.piece
  const out = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(text.length, at + size)
    if (mockState.rowSafe) {
      while (end < text.length && text[end - 1] === '\n') end += 1
    }
    out.push(text.slice(at, end))
    at = end
  }
  return out
}

function startMockProvider(port) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const flat = (Array.isArray(payload.messages) ? payload.messages : [])
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
        .join('\n')
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = obj => {
        if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finish = null) => ({
        id: 'chatcmpl-structure',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-reasoner',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const done = () => { res.write('data: [DONE]\n\n'); res.end() }
      if (!flat.includes(TRIGGER)) {
        send(frame({ content: 'ok' }))
        send(frame({}, 'stop'))
        done()
        return
      }
      const say = async (kind, text) => {
        for (const piece of pieces(text)) {
          if (res.destroyed) return
          send(frame(kind === 'reasoning' ? { reasoning_content: piece } : { content: piece }))
          await delay(mockState.delay)
        }
      }
      if (mockState.tools) {
        // 第几轮由**已经回来了几条 tool 消息**决定 —— 与真实 agent-loop 同一条口径。
        const turn = (payload.messages ?? []).filter(m => m.role === 'tool').length === 0
          ? 1
          : (payload.messages ?? []).filter(m => m.role === 'tool').length <= 2 ? 2 : 3
        const callTool = async (index, id, name, args) => {
          send(frame({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] }))
          await delay(mockState.delay)
          for (const piece of pieces(args)) {
            if (res.destroyed) return
            send(frame({ tool_calls: [{ index, function: { arguments: piece } }] }))
            await delay(mockState.delay)
          }
        }
        const turns = mockState.turns ?? TOOL_TURNS
        await (turns[turn] ?? turns[Object.keys(turns).length])({ say, callTool, finish: reason => send(frame({}, reason)) })
        done()
        return
      }
      for (const [kind, text] of mockState.script ?? THINK_SCRIPT) {
        // 静默:一条 delta 都不发,只等 —— 让打包行独自到达(素材五)。
        if (kind === 'silence') { await delay(text); continue }
        for (const piece of pieces(text)) {
          if (res.destroyed) return
          send(frame(kind === 'reasoning' ? { reasoning_content: piece } : { content: piece }))
          await delay(mockState.delay)
        }
      }
      send(frame({}, 'stop'))
      done()
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/* ── 支架(照 gate-stream-monotone.mjs)──────────────────────────────────── */

function readDiscovery(store) {
  try { return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8')) } catch { return undefined }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}
async function waitFor(label, predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(120)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}
async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
}
async function clickTestId(page, testId) {
  const clicked = await page.evaluate(id => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/**
 * rAF 采样器:逐帧记**最后一条 assistant 消息的结构**。
 *
 * 一件东西 = 一个思考块 / 一个正文块 / 一件工具(单卡或组)。三条判据:
 *  · **身上有任何 `data-prose` 祖先的都不是一件东西**(测量坑 2);
 *  · 每件记 `k`(节奏档,LCS 对齐认的就是它)、`d`(真身:块 kind / 工具状态 /
 *    tool-group)、`n`(文本长度)、`h`(头 40 字,只用来在报错里指认,不作身份);
 *  · **`id` 是 DOM 节点身份**:第一次见到就在节点上盖一个号,换了节点就是换了号
 *    —— F 条(零重挂)靠它,别的判据都看不出「同一个位置换了个节点」。
 *
 * 可见文本(`full`)由这几件拼,**不取整条消息的 textContent**:消息尾那行
 * `Generating · N.Ns` 在跳秒,拿整条量出来的非前缀率 98% 是它(测量坑 1)。
 */
function installSampler(page, tokens, geometry = false, countExisting = false) {
  return page.evaluate(({ marks, geometry, countExisting }) => {
    /*
     * `baseline` 的本意是「这一格开始之前就在的那些 assistant 消息不算」——
     * 同一台应用连着跑好几格,上一格的消息还在屏上。
     *
     * **晚进场那一格反过来**(`countExisting`):要量的那条消息在装采样器之前就
     * 已经在流了,把它排除掉等于一帧都采不到。所以那时基线要退一格,把**最后
     * 那一条**算进来。
     */
    const rows = document.querySelectorAll('[data-message-id][data-role="assistant"]').length
    const baseline = countExisting ? Math.max(0, rows - 1) : rows
    window.__struct = { frames: [], done: false, baseline, seenReadout: false }
    /**
     * 一帧里每个记号出现了几次(H 条:零双画)。
     *
     * 数的是**整条消息的 textContent**,不是采到的那几件东西 —— 双画的两份可能
     * 一份在块里、一份在别处,按件数会漏。读数行(`Generating · N.Ns`)里不含记号,
     * 所以那条跳秒的读数在这一路上无害(测量坑 1 只针对前缀比对)。
     */
    const countMarks = text => {
      const out = []
      for (const mark of marks) {
        let n = 0
        let at = text.indexOf(mark)
        while (at >= 0) { n += 1; at = text.indexOf(mark, at + mark.length) }
        out.push(n)
      }
      return out
    }
    let nodeSeq = 0
    /*
     * ── P 条要的两个数:**块顶**与**块高**(R4b)────────────────────────
     *
     * 「数据首行上下抖」这类报障禁纸上诊断,所以先把它变成两条可以逐帧比的数:
     *  · `bt` = 这件东西的顶边**相对这条消息**的偏移 —— 用消息自己的矩形做基准,
     *    把整页滚动、读数行跳秒这些无关的位移全部约掉;
     *  · `bh` = 它自己的高度。
     *
     * 两个数各钉一半:`bh` 抖 = 它自己在长短之间来回;`bt` 抖 = 它上面某件东西
     * 在长短之间来回(把它踹上踹下)。只有 `monster` 那一格开这个口 —— 逐帧读
     * 矩形会强制一次 layout,别的素材的既有读数不该为此变形。
     */
    const shapeOf = el => {
      const out = []
      const base = geometry ? el.getBoundingClientRect().top : 0
      for (const node of el.querySelectorAll('[data-prose],[data-tool-status],[data-tool-group]')) {
        if (node.parentElement?.closest('[data-prose]')) continue
        if (node.parentElement?.closest('[data-testid="chat-thought"]')) continue
        if (node.parentElement?.closest('[data-block-kind]')) continue
        if (node.parentElement?.closest('[data-tool-group]')) continue
        const toolStatus = node.getAttribute('data-tool-status')
        const isTool = Boolean(toolStatus) || node.hasAttribute('data-tool-group')
        if (!node.__structId) node.__structId = ++nodeSeq
        const text = node.textContent ?? ''
        out.push({
          // 节奏档:工具那两种形(单卡 / 组)**归同一档** —— 它们是同一件东西的
          // 两种长相,分档的话「单卡变成组」会被 LCS 当成一件消失 + 一件插入。
          k: isTool
            ? 'tool'
            : (node.getAttribute('data-testid') === 'chat-thought' ? 'think' : node.getAttribute('data-prose')),
          // 思考块此刻是展开还是收起 —— R3 浸泡首单量的就是这一格(读数,不进断言)。
          ex: node.getAttribute('aria-expanded') ?? undefined,
          d: node.getAttribute('data-block-kind')
            ?? (node.hasAttribute('data-tool-group') ? 'tool-group' : undefined)
            ?? toolStatus
            ?? node.tagName.toLowerCase(),
          // 组里那几行各自的状态 —— G 条(参数流式期有呈现)读它。
          st: isTool
            ? Array.from(node.querySelectorAll('[data-tool-status]'))
                .map(row => row.getAttribute('data-tool-status'))
                .concat(toolStatus ? [toolStatus] : [])
                .join(',')
            : '',
          n: text.length,
          h: text.slice(0, 40).replace(/\s+/g, ' '),
          id: node.__structId,
          // 这件东西身上带着哪几个记号 —— I 条问的是「记号此刻住在哪一种块里」。
          mk: marks.flatMap((mark, index) => (text.includes(mark) ? [index] : [])),
          ...(geometry
            ? (() => {
                const r = node.getBoundingClientRect()
                return { bt: Math.round(r.top - base), bh: Math.round(r.height) }
              })()
            : {}),
        })
      }
      return out
    }
    const tick = () => {
      const rows = document.querySelectorAll('[data-message-id][data-role="assistant"]')
      const art = rows.length > baseline ? rows[rows.length - 1] : undefined
      if (document.querySelector('[data-testid="chat-readout"]')) window.__struct.seenReadout = true
      if (art) {
        window.__struct.frames.push({
          t: Math.round(performance.now()),
          s: shapeOf(art),
          m: countMarks(art.textContent ?? ''),
          // 这一帧还在直播吗 —— 读数行在场就是在场。P 条只量直播期,理由与 O 条同一条:
          // 收尾那一刻是**整条消息换渲染**(读数行退场 / 动作行进场),不属流式追加。
          lv: Boolean(document.querySelector('[data-testid="chat-readout"]')),
        })
      }
      if (!window.__struct.done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, { marks: tokens, geometry, countExisting })
}

/** 屏幕上那条消息里每张表各画了几列(Q 条的读数:削列到底削没削)。 */
function readTableCols(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('[data-message-id][data-role="assistant"]')
    const art = rows[rows.length - 1]
    if (!art) return []
    return Array.from(art.querySelectorAll('table')).map(table => ({
      th: table.querySelectorAll('thead th').length,
      // 削掉的那一格自报家门(产品侧挂 data-col-overflow),没有就是没削。
      more: table.querySelector('[data-col-overflow]')?.getAttribute('data-col-overflow') ?? null,
    }))
  })
}

/** 屏幕上那条消息此刻的块序(冷加载对照用,与采样器同一套判据)。 */
function readShape(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('[data-message-id][data-role="assistant"]')
    const art = rows[rows.length - 1]
    if (!art) return '(没有 assistant 消息)'
    const out = []
    for (const node of art.querySelectorAll('[data-prose],[data-tool-status],[data-tool-group]')) {
      if (node.parentElement?.closest('[data-prose]')) continue
      if (node.parentElement?.closest('[data-testid="chat-thought"]')) continue
      if (node.parentElement?.closest('[data-block-kind]')) continue
      if (node.parentElement?.closest('[data-tool-group]')) continue
      const status = node.getAttribute('data-tool-status')
      const isTool = Boolean(status) || node.hasAttribute('data-tool-group')
      const k = isTool
        ? 'tool'
        : (node.getAttribute('data-testid') === 'chat-thought' ? 'think' : node.getAttribute('data-prose'))
      const d = node.getAttribute('data-block-kind')
        ?? (node.hasAttribute('data-tool-group') ? 'tool-group' : undefined)
        ?? status
        ?? node.tagName.toLowerCase()
      out.push(`${k}:${d}`)
    }
    return out.join(' | ')
  })
}

/* ── 分析器 ────────────────────────────────────────────────────────────
 *
 * 帧间身份靠**对齐**,不靠头字(测量坑 3)。流是只追加的,所以"同一件东西"= 同一个
 * 节奏档;LCS 对齐之后,插入不再被误判成搬家、成长不再被误判成消失。
 */

function alignByKind(A, B) {
  const n = A.length
  const m = B.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i].k === B[j].k ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs = []
  const delA = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i].k === B[j].k) { pairs.push([i, j]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) delA.push(i++)
    else j++
  }
  while (i < n) delA.push(i++)
  return { pairs, delA }
}

/** 一件东西前面有几个工具容器 —— E 条(正文不许跨过工具)的坐标。 */
const toolsBefore = (frame, index) => frame.slice(0, index).filter(item => item.k === 'tool').length

function analyse(frames) {
  const out = { vanishText: [], crossed: [], toolRemount: [], sawInputStreaming: false, toolFrames: 0 }
  for (let f = 1; f < frames.length; f++) {
    const A = frames[f - 1].s
    const B = frames[f].s
    const { pairs, delA } = alignByKind(A, B)
    for (const i of delA) {
      if (A[i].k === 'text' && A[i].n > 0) {
        out.vanishText.push({ t: frames[f].t, d: A[i].d, n: A[i].n, h: A[i].h.slice(0, 22) })
      }
    }
    for (const [i, j] of pairs) {
      if (A[i].k !== 'text') continue
      const was = toolsBefore(A, i)
      const now = toolsBefore(B, j)
      if (was !== now) out.crossed.push({ t: frames[f].t, was, now, h: A[i].h.slice(0, 22) })
    }
    // F:同一位次的工具容器换了 DOM 节点 = 那一行被卸载重挂。
    const toolsA = A.filter(item => item.k === 'tool')
    const toolsB = B.filter(item => item.k === 'tool')
    for (let x = 0; x < Math.min(toolsA.length, toolsB.length); x++) {
      if (toolsA[x].id !== toolsB[x].id) {
        out.toolRemount.push({ t: frames[f].t, at: x, was: toolsA[x].d, now: toolsB[x].d })
      }
    }
  }
  for (const frame of frames) {
    const tools = frame.s.filter(item => item.k === 'tool')
    if (tools.length > 0) out.toolFrames += 1
    if (tools.some(item => (item.st ?? '').includes('input-streaming'))) out.sawInputStreaming = true
  }
  return out
}

/**
 * H:**零双画** —— 同一截源文本任一时刻只被画一次。
 *
 * 09-01 用户真机证词:「markdown 的渲染很奇怪,它会显示原始字符串,其实 table 已经
 * 画出来了」。那是同一截内容被画了两遍(一份成了表,一份还是原始 markdown),
 * 病灶落在交接线上:账本画了一份、尾巴又画了一份,而两条车道的记账对不上。
 *
 * 判据不看形态、只数记号:素材里每个 `TK*` 只出现一次,屏幕上它就只许出现一次。
 * 一帧里数到 2 就是双画 —— 不管那两份长成表还是长成原文。
 */
function findDoubleDrawn(frames, tokens) {
  const out = []
  for (const frame of frames) {
    (frame.m ?? []).forEach((count, index) => {
      if (count > 1) out.push({ t: frame.t, token: tokens[index], count })
    })
  }
  return out
}

/**
 * 一个记号这一路住过哪些块型,各住了几帧。
 *
 * 「住在哪」= 屏幕上包着它的那件东西的真身(`d`):`p` 是裸段落(表还没成形)、
 * `code` 是源码、`table` 是表。I 条读的就是这张账。
 */
function hostTrail(frames, tokenIndex) {
  const counts = new Map()
  const order = []
  let firstAt
  let lastKind
  for (const frame of frames) {
    const host = frame.s.find(item => (item.mk ?? []).includes(tokenIndex))
    if (!host) continue
    if (firstAt === undefined) firstAt = frame.t
    counts.set(host.d, (counts.get(host.d) ?? 0) + 1)
    if (host.d !== lastKind) {
      order.push({ d: host.d, t: frame.t })
      lastKind = host.d
    }
  }
  return { counts, order, firstAt, last: lastKind }
}

/**
 * **P:零竖向抖动**(R4b)。
 *
 * 判据按**每一件东西自己的一条时间线**走(键是 DOM 节点身份 `id`,重挂就是新的一条线):
 *  · `bh` 只增不减 —— 它自己不许在长短之间来回;
 *  · `bt` 只增不减 —— 它上面的东西也不许把它踹上踹下。
 *
 * 为什么按 id 分线而不是按位次:一次**合法的换装**(承诺落空,表降回段落)会让高度
 * 一次性变小,而那是拍板过的行为,不是抖动 —— 换装换号、换号换 DOM 节点,新的一条线
 * 从头起算,这条法因此不必给那次降级开豁免口。
 *
 * `slack` 是一格容差:子像素与滚动条出没会让读数在 1px 上下晃,那不是抖动。
 */
function findVerticalJitter(frames, slack = 1) {
  const seen = new Map()
  const out = []
  for (const frame of frames) {
    // 收尾那一帧起不再量(读数行退场把整条消息的几何重排一次,与 O 条同一条豁免)。
    if (frame.lv === false) break
    for (const item of frame.s) {
      if (item.bh === undefined) continue
      const prev = seen.get(item.id)
      if (prev) {
        if (item.bh < prev.bh - slack) {
          out.push({ t: frame.t, why: 'h', d: item.d, from: prev.bh, to: item.bh, h: item.h })
        } else if (item.bt < prev.bt - slack) {
          out.push({ t: frame.t, why: 't', d: item.d, from: prev.bt, to: item.bt, h: item.h })
        }
      }
      // 与**相邻的上一次**比,不与跑动最大值比:一次性的塌陷该记 1 笔,不是记到收尾
      // (修前基线上那一塌被记了 832 笔,数的是「塌完之后还剩几帧」,不是「抖了几次」)。
      seen.set(item.id, { bh: item.bh, bt: item.bt })
    }
  }
  return out
}

/**
 * **一个记号此刻穿的是哪件衣服**(R3 浸泡首单的取证判据)。
 *
 * `hostTrail` 读的是块的真身(`d`:p / table / code),回答「它被画成哪一种块」;
 * 这里读的是**件的档**(`k`:think / text / tool),回答「它住在思考件里还是正文件里」。
 * 用户报的那一形——推理以斜体正文摊在消息里——两种可能的分水岭正是这一格:
 * 住在 `think` 里 = 穿着思考块的衣服(斜体灰是它的定稿形),住在 `text` 里 = 呈现回归。
 */
function markCoats(frames, tokenIndex) {
  const counts = new Map()
  for (const frame of frames) {
    const host = frame.s.find(item => (item.mk ?? []).includes(tokenIndex))
    if (!host) continue
    counts.set(host.k, (counts.get(host.k) ?? 0) + 1)
  }
  return counts
}

/**
 * **并存窗口**:一帧里既有工具件、又有思考件。
 *
 * 用户报的现场就是这个窗口(「think 还在,但是下面有一个工具调用」)。这里把它
 * 变成一个可以数的东西:窗口有多少帧、窗口里思考块是展开还是收起。
 */
function coexistWindow(frames) {
  const rows = frames.filter(f => f.s.some(b => b.k === 'tool') && f.s.some(b => b.k === 'think'))
  const expanded = new Map()
  for (const frame of rows) {
    for (const item of frame.s) {
      if (item.k !== 'think') continue
      expanded.set(item.ex ?? '(无)', (expanded.get(item.ex ?? '(无)') ?? 0) + 1)
    }
  }
  return { frames: rows.length, expanded }
}

/**
 * **一个记号此刻的文档序位置,以及它前面有几件工具**(R3 第二轮取证)。
 *
 * `markCoats` 只答「穿的哪件衣服」,答不了「站在哪儿」——而这一单要分的恰恰是站位:
 * 新推理**开在工具行之后**(对),还是被并进消息顶那个既有思考段(错,那样它永远
 * 排在所有工具之前)。判据因此是**它的宿主前面有没有工具件**。
 */
function markPlace(frames, tokenIndex) {
  const rows = []
  for (const frame of frames) {
    const at = frame.s.findIndex(item => (item.mk ?? []).includes(tokenIndex))
    if (at < 0) continue
    const toolsBefore = frame.s.slice(0, at).filter(b => b.k === 'tool').length
    rows.push({ t: frame.t, at, toolsBefore, id: frame.s[at].id, k: frame.s[at].k, n: frame.s[at].n })
  }
  return rows
}

/** A:思考块的条数只增不减。 */
function findThinkVanished(frames) {
  const out = []
  for (let i = 1; i < frames.length; i += 1) {
    const before = frames[i - 1].s.filter(b => b.k === 'think').length
    const after = frames[i].s.filter(b => b.k === 'think').length
    if (after < before) out.push({ i, t: frames[i].t, before, after })
  }
  return out
}

/** B:同一块思考(按头 40 字认)在相邻两帧里的位置序号不许变。 */
function findThinkMoved(frames) {
  const out = []
  let prev
  for (const frame of frames) {
    const pos = new Map()
    frame.s.forEach((block, index) => { if (block.k === 'think') pos.set(block.h, index) })
    if (prev) {
      for (const [head, index] of pos) {
        const was = prev.get(head)
        if (was !== undefined && was !== index) out.push({ t: frame.t, head, was, now: index })
      }
    }
    prev = pos
  }
  return out
}

/**
 * C:表格成形之后不再降级回 code。
 *
 * 判据读**块的檐**:表格檐是「Copy Markdown / Copy CSV」,代码檐是「Copy source」
 * —— 两者都是块壳画上去的第一段文字,所以块的 textContent 开头就说得出它此刻是谁。
 */
function findTableDowngrades(frames) {
  const out = []
  let formed = false
  for (const frame of frames) {
    for (const block of frame.s) {
      if (block.k !== 'object') continue
      if (block.h.startsWith('Copy Markdown')) formed = true
      else if (formed && block.h.startsWith('Copy source')) out.push({ t: frame.t, head: block.h })
    }
  }
  return out
}

/* ── 一格 ──────────────────────────────────────────────────────────────── */

async function runCell({ record, page, kind, piece, index }) {
  mockState.piece = piece
  console.log(`\n── ${kind} @ ${piece} 字/帧 ────────────────────────────────`)
  const made = await rpc(record, 'sessions', 'create', { name: `结构门 ${kind}-${piece}` })
  const sessionId = made?.session?.id
  if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
  /*
   * **壳来晚**(`lateOpen`):先开流、隔 `LATE_OPEN_MS` 再开会话。
   * 中途入场的定义就是这一下 —— 壳订上推送时,这一轮已经流了一半,
   * 第一条 delta 的偏移不为 0,按连续前缀律被水位表丢掉。
   */
  const lateOpen = CASES[kind]?.lateOpen === true
  const sendTrigger = () => rpc(record, 'session-command', 'emit', {
    sessionId,
    command: { type: 'command:send-message', content: `${TRIGGER} 请开始`, suppressTitleGeneration: true },
  })
  if (lateOpen) {
    await sendTrigger()
    await delay(LATE_OPEN_MS)
  }
  await clickTestId(page, 'dock-tile-sessions')
  await waitFor('总览画出那张卡', () =>
    page.evaluate(id => Boolean(document.querySelector(`[data-testid="card-${id}"]`)), sessionId),
  )
  await clickTestId(page, `card-${sessionId}`)
  await waitFor('聊天区就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))),
  )

  await installSampler(page, TOKENS[kind] ?? [], CASES[kind]?.geometry === true, lateOpen)
  /*
   * 诊断口:`STRUCT_SHOTS=<dir>` 时直播期每 `SHOT_INTERVAL_MS` 抓一张图。
   * 门自己不写文件(跑完即走);修前 / 修后的视觉对照要的就是这几张。
   */
  let shots
  if (process.env.STRUCT_SHOTS) {
    /*
     * 留账:隔离 store 起来时 Dock 上那块 Files 面默认开着,**正好盖住聊天区** ——
     * 所以这个诊断口今天抓出来的图看不见表。试过点 Dock 瓦收它(只出了个 Tooltip,
     * 面没收),再往下就是替门造一份「关掉默认面」的起手状态,那是另一件事。
     * R4b 的验收因此走**读数**不走图:R 条(裸挂多少毫秒)与 P 条(抖动几处)
     * 本来就是那两张截图要说的话的机器版。
     */
    let n = 0
    let stop = false
    const dir = process.env.STRUCT_SHOTS
    const loop = (async () => {
      while (!stop) {
        await page
          .screenshot({ path: path.join(dir, `${kind}-${piece}-${String(n).padStart(2, '0')}.png`) })
          .catch(() => {})
        n += 1
        await delay(SHOT_INTERVAL_MS)
      }
    })()
    shots = async () => { stop = true; await loop }
  }
  // 帧读数用 `performance.now()`(页面时间轴),账本用 epoch —— 换算要这一个数。
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  /*
   * ── O:**流式追加不许打飞用户已选中的文字**(R2 审查条 9)────────────────
   *
   * 直播期每一帧都在改文本节点。选区是浏览器挂在**具体那个文本节点**上的,节点一
   * 被换掉(而不是就地加长),选区当场没了 —— 用户正想复制一段话,字还在长,选区
   * 却每秒被打飞几十次。
   *
   * 量法:等第一段正文上屏之后选中它,然后**照常流到底**,最后问选区还在不在。
   * 只在正文素材上做(工具素材的第一件东西可能是工具行,选不到字)。
   */
  const watchSelection = kind === 'think' || kind === 'pack' || kind === 'table'
  let selectionSeeded = false
  if (!lateOpen) await sendTrigger()
  /*
   * **重连补齐**:进场之后再退回总览、再点回来 —— 壳重新 `open`,水位整份丢,
   * 而那一轮还在流。与断线重连是同一形,所以这一下就是那条素材的第二段。
   * 记一个时刻,断言只看这之后的帧。
   */
  let reopened = false
  const reopenIfNeeded = async () => {
    if (!lateOpen || reopened) return
    reopened = true
    await page.evaluate(() => { window.__reopenAt = performance.now() })
    await clickTestId(page, 'dock-tile-sessions')
    await delay(300)
    await clickTestId(page, `card-${sessionId}`)
    await page.evaluate(() => { window.__reopenDoneAt = performance.now() })
  }
  await waitFor('assistant 完稿', async () => {
    // 第一段正文一上屏就把选区种下去,然后让它在整条流里活着。
    if (watchSelection && !selectionSeeded) {
      selectionSeeded = await page.evaluate(() => {
        const rows = document.querySelectorAll('[data-message-id][data-role="assistant"]')
        const art = rows[rows.length - 1]
        const target = art?.querySelector('p')
        if (!target || (target.textContent ?? '').length < 8) return false
        const range = document.createRange()
        range.selectNodeContents(target)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        window.__selSeed = selection?.toString() ?? ''
        /*
         * 逐帧盯着它:**直播期**任何一帧掉了都算打飞(审查条 9 说的就是「流式追加」)。
         * 收尾那一刻是另一件事(整条消息换渲染:读数行退场、动作行进场),
         * 单独记读数不进断言 —— 见 O 的报文。
         */
        window.__selAlive = { streaming: [], settled: -1 }
        const tick = () => {
          const len = window.getSelection()?.toString().length ?? 0
          if (window.__struct?.done) window.__selAlive.settled = len
          else window.__selAlive.streaming.push(len)
          if (window.__selAlive.streaming.length < 4000) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        return (window.__selSeed?.length ?? 0) >= 8
      })
    }
    const state = await page.evaluate(() => ({
      readout: Boolean(document.querySelector('[data-testid="chat-readout"]')),
      seen: window.__struct?.seenReadout ?? false,
      n: window.__struct?.frames.length ?? 0,
    }))
    // 进场之后采到一批帧了、而且还在直播 —— 这一刻做那一次重连。
    if (lateOpen && !reopened && state.readout && state.n > 60) await reopenIfNeeded()
    return state.seen && !state.readout && state.n > 50 ? state : undefined
  }, 180_000)
  if (watchSelection) {
    const selection = await page.evaluate(() => ({
      seed: window.__selSeed ?? '',
      alive: window.__selAlive ?? { streaming: [], settled: -1 },
    }))
    assert(selection.seed.length >= 8, `O 选区种下去了(${selection.seed.length} 字)`)
    const frames0 = selection.alive.streaming
    const dropped = frames0.filter(len => len === 0).length
    const ratio = frames0.length > 0 ? dropped / frames0.length : 0
    /*
     * ── O 是**棘轮**,不是零基线(读数与理由都写在这儿)──────────────────
     *
     * 09-01 R2 第一次量它:新路 6/434 帧(1.4%)、旧路 7/435 帧(1.6%)——
     * 两条路读数一样,所以这是**既有病,不是 R2 引入的**(R2 只是第一次把它量出来)。
     * 病灶在 markdown 那一层:某些帧里段落的行内结构被重建,文本节点被换掉,
     * 选区跟着没。根治要动行内节点的身份(R4「行级提交流」那一批的活儿)。
     *
     * 所以门守的是**量级**:选区每帧都被打飞(≈100%)与偶尔掉一帧(≈1.5%)是两回事,
     * 前者是灾难,后者是留账。阈值 3% 给了一倍余量;它一红,说明有人把「偶尔」
     * 变回了「每帧」。留账:R4 之后这条应当收到 0。
     */
    const SELECTION_DROP_BUDGET = 0.03
    if (ratio > SELECTION_DROP_BUDGET) {
      throw new Error(
        `断言失败:O 直播期 ${dropped}/${frames0.length} 帧(${(ratio * 100).toFixed(1)}%)选区被打飞,` +
        `超过 ${(SELECTION_DROP_BUDGET * 100).toFixed(0)}% 棘轮(审查条 9;既有基线 1.4–1.6%)`,
      )
    }
    assert(
      true,
      `O 直播期选区掉 ${dropped}/${frames0.length} 帧(${(ratio * 100).toFixed(1)}% ≤ 3% 棘轮;既有病,R2 第一次量到)`,
    )
    // 收尾那一刻是整条消息换渲染(读数行退场 / 动作行进场),不属「流式追加」——
    // 只记读数不进断言,留账在回报里。
    console.log(`  收尾之后选区:${selection.alive.settled} 字(留账,不进断言)`)
  }
  await delay(400)
  if (shots) await shots()
  const frames = await page.evaluate(() => { window.__struct.done = true; return window.__struct.frames })
  const reopenAt = await page.evaluate(() => window.__reopenDoneAt ?? null)
  const liveShape = await readShape(page)

  /*
   * **流式落定 vs 冷加载**:同一条消息,刷一次页面再读一遍结构。流式那条路
   * (账本 + 活尾巴 + 增量解析)与冷加载那条路(全量 parseFrame)如果给出不同的
   * 块序,那就是「屏幕上看到的」与「刷新后看到的」分叉。
   */
  await page.reload()
  await waitFor('刷新后 Dock 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
  )
  await clickTestId(page, 'dock-tile-sessions')
  await waitFor('刷新后总览画出那张卡', () =>
    page.evaluate(id => Boolean(document.querySelector(`[data-testid="card-${id}"]`)), sessionId),
  )
  await clickTestId(page, `card-${sessionId}`)
  await waitFor('刷新后那条 assistant 消息回来', () =>
    page.evaluate(() => document.querySelectorAll('[data-message-id][data-role="assistant"]').length > 0),
  )
  await delay(2500)
  const coldShape = await readShape(page)

  console.log(`  采到 ${frames.length} 帧`)
  console.log(`  流式末帧 : ${liveShape}`)
  console.log(`  冷加载   : ${coldShape}`)
  assert(frames.length > 100, `采到 ${frames.length} 帧结构读数`)
  assert(liveShape === coldShape, '流式末帧与冷加载逐格相同')

  const marks = TOKENS[kind] ?? []
  const doubled = findDoubleDrawn(frames, marks)
  if (doubled.length > 0) {
    const shown = doubled.slice(0, 5).map(d => `t=${d.t}ms「${d.token}」×${d.count}`).join(' · ')
    throw new Error(
      `断言失败:H 同一截源文本被画了两遍,共 ${doubled.length} 帧(${shown})` +
      '\n  —— 用户证词的形:「显示原始字符串,其实 table 已经画出来了」',
    )
  }
  const seen = marks.filter((_, index) => frames.some(frame => (frame.m ?? [])[index] > 0)).length
  assert(
    seen === marks.length,
    `H 零双画(${marks.length} 个记号全程各只画一次;${seen}/${marks.length} 个真的上过屏)`,
  )

  // 诊断口:`STRUCT_DUMP=<dir>` 时把逐帧读数落盘 —— 门自己不写文件(跑完即走),
  // 但排一条真机病时,那几百帧的逐件读数就是全部证据。
  if (process.env.STRUCT_DUMP) {
    const dumpPath = path.join(process.env.STRUCT_DUMP, `frames-${kind}-${piece}.json`)
    writeFileSync(dumpPath, JSON.stringify(frames))
    console.log(`  逐帧读数 → ${dumpPath}`)
  }

  const stat = analyse(frames)
  if (kind === 'think') {
    const finalThinks = frames[frames.length - 1].s.filter(b => b.k === 'think').length
    assert(finalThinks >= 3, `完稿时屏幕上有 ${finalThinks} 个思考块(素材给了 3 段)`)
    assert(frames[frames.length - 1].s.some(b => b.k === 'object'), '完稿时那张表在屏幕上')

    const vanished = findThinkVanished(frames)
    if (vanished.length > 0) {
      const shown = vanished.slice(0, 5).map(v => `t=${v.t}ms ${v.before}→${v.after}`).join(' · ')
      throw new Error(`断言失败:A 思考块消失了 ${vanished.length} 次(${shown})`)
    }
    assert(true, `A 思考块全程只增不减(${frames.length} 帧零消失)`)

    const moved = findThinkMoved(frames)
    if (moved.length > 0) {
      const shown = moved.slice(0, 5).map(m => `t=${m.t}ms「${m.head}」${m.was}→${m.now}`).join(' · ')
      throw new Error(`断言失败:B 思考块搬家 ${moved.length} 次(${shown})`)
    }
    assert(true, 'B 思考块全程不搬家(位置序号一帧都没变过)')

    const downgrades = findTableDowngrades(frames)
    if (downgrades.length > 0) {
      throw new Error(
        `断言失败:C 表格成形后又降级回 code,共 ${downgrades.length} 帧(首次 t=${downgrades[0].t}ms)`,
      )
    }
    /*
     * C 的第二半(09-01 加严):从前只钉「成形之后不许再降级」,而真机上那张表
     * **从头到尾就没成形过**,一路是源码 —— 「成形后」那个前提根本没兑现,断言
     * 于是恒真。现在连「有没有当过源码」一起钉:表里的记号住在哪一种块里,一帧都
     * 不许是 code(与素材三的 I 条同一条法)。
     */
    const inTable = hostTrail(frames, 0)
    if ((inTable.counts.get('code') ?? 0) > 0) {
      throw new Error(
        `断言失败:C 那张表被当成源码画了 ${inTable.counts.get('code')} 帧` +
        `(${inTable.order.map(step => `${step.d}@${step.t}ms`).join(' → ')})`,
      )
    }
    assert(
      true,
      `C 表一帧都没被当成源码画过,收尾是 ${inTable.last}(住过 ${[...inTable.counts.keys()].join('/')})`,
    )
    return
  }

  if (kind === 'pack') {
    /*
     * ── N:**打包行到达那一帧,屏幕零像素变化**(R2 第六不变式)────────────
     *
     * 两条读数各证一半:
     *  · **同长不同形 = 0**:相邻两帧总字数相同、画面却不同 —— 那只可能是重画
     *    (delta 在长的时候总字数一定在涨)。整条流都成立。
     *  · **静默窗逐帧同**:素材里那 2.6 秒一条 delta 都没有,而 2s 打包闸必然在
     *    窗内响过一次。那几百帧一模一样,就是打包行没动过屏幕的直证。
     */
    const shapeOf = frame => frame.s.map(item => `${item.k}:${item.d}:${item.n}:${item.h}`).join('|')
    const lengthOf = frame => frame.s.reduce((sum, item) => sum + item.n, 0)
    const repaints = []
    for (let i = 1; i < frames.length; i += 1) {
      if (lengthOf(frames[i]) !== lengthOf(frames[i - 1])) continue
      if (shapeOf(frames[i]) !== shapeOf(frames[i - 1])) {
        repaints.push({ t: frames[i].t, was: shapeOf(frames[i - 1]).slice(0, 60), now: shapeOf(frames[i]).slice(0, 60) })
      }
    }
    if (repaints.length > 0) {
      throw new Error(
        `断言失败:N 有 ${repaints.length} 帧「总字数没变、画面却变了」(${repaints.slice(0, 3).map(r => `t=${r.t}ms`).join(' · ')})` +
        '\n  —— 第六不变式:存储节拍(2s 打包)不许进显示路径',
      )
    }
    assert(true, `N 同长不同形 0 帧(${frames.length} 帧全程)`)

    /*
     * 静默窗 = 「第一段正文已经在屏、第二段还没来」那一段连续帧。
     *
     * 判据必须**咬住素材**(shape 里有 TKP1 而没有 TKP2),不能只找「最长的一段
     * 总字数不变」—— 思考块在屏幕上是**定长预览**(61 字),整段推理流下来那一段
     * 的可见字数一直不变,长度足足 2s,会把窗口找到那边去(第一版就栽在这儿:
     * 量到 2025ms 的那个「静默」其实是推理期)。
     */
    let best = { from: 0, to: 0 }
    let runStart = 0
    const inWindowShape = frame => shapeOf(frame).includes('TKP1') && !shapeOf(frame).includes('TKP2')
    for (let i = 1; i <= frames.length; i += 1) {
      const broke = i === frames.length || lengthOf(frames[i]) !== lengthOf(frames[runStart])
      if (!broke) continue
      const span = frames[i - 1].t - frames[runStart].t
      if (span > best.to - best.from && inWindowShape(frames[runStart])) {
        best = { from: frames[runStart].t, to: frames[i - 1].t }
      }
      runStart = i
    }
    const quietMs = best.to - best.from
    const inWindow = frames.filter(frame => frame.t >= best.from && frame.t <= best.to)
    const shapes = new Set(inWindow.map(shapeOf))
    if (shapes.size !== 1) {
      throw new Error(`断言失败:N 静默窗里 ${inWindow.length} 帧出现了 ${shapes.size} 种画面 —— 打包行动了屏幕`)
    }
    /*
     * 「窗里真的落过打包行吗」**问账本,不靠窗口有多长**。
     *
     * 第一版按「窗口 > 2s 打包闸」推断,而那是个会漂的量:思考块在屏幕上是定长
     * 预览,推理期的可见字数也一直不变,窗口找错地方就得出 2025ms 的假读数。
     * 现在直接把账本上那几行的时刻换算到页面时间轴上比一比 —— 落在窗里,
     * 而窗里逐帧一模一样,「打包行到达零像素变化」就是**证**,不是推断。
     */
    const raw = await rpc(record, 'sessionEvents', 'listRaw', { sessionId })
    const packed = (raw?.events ?? [])
      .filter(event => event.type === 'assistant/chunks' && typeof event.time === 'number')
      .map(event => event.time - timeOrigin)
    const inside = packed.filter(at => at >= best.from && at <= best.to)
    if (inside.length === 0) {
      throw new Error(
        `断言失败:N 静默窗(${best.from}–${best.to}ms,${quietMs}ms)里一条打包行都没落过 —— 这一格什么都没证到`
        + `\n  账本上的打包行落在:${packed.map(at => Math.round(at)).join(' / ')}ms`,
      )
    }
    assert(
      true,
      `N 静默窗 ${inWindow.length} 帧逐帧一模一样,窗内落了 ${inside.length} 条打包行(${quietMs}ms 窗)`,
    )
    return
  }

  if (kind === 'mixed') {
    /*
     * ── L / M:真机节奏下的两条(09-01 自查帧证)────────────────────────
     *  L **块不许整批消失**:自查 `t=3659` 一帧里块数 2→0、正文 786→371,
     *    下一帧原样回来(~17ms 肉眼难见,但它是数据层真丢了一次)。
     *  M **表成形之后不许退回裸文本**:那一帧之后表没了,`| 宿主 | 工具档 |…`
     *    明文在屏上挂了 433ms 才重新成表。
     */
    const objectsOf = frame => frame.s.filter(item => item.k === 'object').length
    const wipes = []
    for (let i = 1; i < frames.length; i += 1) {
      const was = objectsOf(frames[i - 1])
      const now = objectsOf(frames[i])
      if (now < was) wipes.push({ t: frames[i].t, was, now })
    }
    const trail = hostTrail(frames, 0)
    console.log(`  表记号住过:${trail.order.map(s => `${s.d}@${s.t}ms`).join(' → ')}`)
    console.log(`  块件数下降 ${wipes.length} 次${wipes.length ? `(${wipes.slice(0, 4).map(w => `t=${w.t} ${w.was}→${w.now}`).join(' · ')})` : ''}`)
    if (wipes.length > 0) {
      throw new Error(
        `断言失败:L 块整批消失 ${wipes.length} 次(${wipes.slice(0, 4).map(w => `t=${w.t}ms ${w.was}→${w.now}`).join(' · ')})` +
        '\n  —— 自查帧证的形:t=3659 块数 2→0、正文 786→371,下一帧原样回来',
      )
    }
    assert(true, `L 块一次都没整批消失(${frames.length} 帧)`)

    const backToNaked = trail.order.filter((step, index) =>
      index > 0 && step.d !== 'table' && trail.order.slice(0, index).some(s => s.d === 'table'),
    )
    if (backToNaked.length > 0) {
      throw new Error(
        `断言失败:M 表成形之后又退回裸文本 ${backToNaked.length} 次` +
        `(${trail.order.map(s => `${s.d}@${s.t}ms`).join(' → ')})`,
      )
    }
    assert(true, `M 表成形之后再没退回裸文本(收尾是 ${trail.last})`)
    return
  }

  if (kind === 'reasontool' || kind === 'reasonbare') {
    /*
     * ── U:**工具结果之后新到的推理,必须开在工具行之后** ────────────────────
     *
     * 用户反证词的那一格。两条断言从两侧夹同一件事:
     *  U1 站位:推理(2) 的宿主前面**必须**至少有一件工具(它是第二个请求的东西,
     *     而第一个请求的工具调用早就落地了);
     *  U2 旧段零增长:推理(2) 一上屏,推理(1) 那个 DOM 节点的文本长度**一个字都不许再涨**
     *     —— 涨了就说明新推理被并进了旧段(顶部推理字段那条路)。
     */
    const one = markPlace(frames, 0)
    const two = markPlace(frames, 1)
    console.log(`  【U】推理(1) TKR1:${one.length} 帧,位次 ${[...new Set(one.map(r => r.at))].join('/')},前置工具 ${[...new Set(one.map(r => r.toolsBefore))].join('/')}`)
    console.log(`  【U】推理(2) TKR2:${two.length} 帧,位次 ${[...new Set(two.map(r => r.at))].join('/')},前置工具 ${[...new Set(two.map(r => r.toolsBefore))].join('/')}`)
    const win = coexistWindow(frames)
    console.log(`  【U】并存窗口 ${win.frames} 帧;思考块 aria-expanded:${[...win.expanded].map(([k, n]) => `${k}×${n}`).join(' / ')}`)

    assert(two.length > 0, `U 推理(2) 上过屏(${two.length} 帧)`)
    assert(one.length > 0, `U 推理(1) 上过屏(${one.length} 帧)`)

    const sameHost = two.filter(r => one.some(o => o.id === r.id && o.t === r.t))
    if (sameHost.length > 0) {
      throw new Error(
        `断言失败:U 推理(2) 与推理(1) 住在**同一个**思考件里 ${sameHost.length} 帧` +
        '\n  —— 病的形:工具结果之后新到的推理被并进了消息顶那个既有思考段' +
        '(message.reasoning 是顶部推理字段,永远画在消息顶),于是屏幕上「think 还在,' +
        '下面有一个工具调用」——而它本该开在工具行之后',
      )
    }
    assert(true, 'U 推理(2) 与推理(1) 不是同一个思考件(新推理另开了一段)')

    const noToolBefore = two.filter(r => r.toolsBefore === 0)
    if (noToolBefore.length > 0) {
      const f = noToolBefore[0]
      throw new Error(
        `断言失败:U1 推理(2) 有 ${noToolBefore.length} 帧排在所有工具**之前**` +
        `(首帧 t=${f.t}ms 位次 ${f.at},前置工具 0)` +
        '\n  —— 它是第二个请求的东西,第一个请求的工具调用早该在它上面',
      )
    }
    assert(true, `U1 推理(2) 全程开在工具行之后(${two.length} 帧,前置工具 ≥1)`)

    const firstTwo = two[0].t
    const oneAfter = one.filter(r => r.t >= firstTwo)
    const grew = oneAfter.length > 1 && oneAfter[oneAfter.length - 1].n > oneAfter[0].n
    if (grew) {
      throw new Error(
        `断言失败:U2 推理(2) 上屏之后,推理(1) 那一段还在涨(${oneAfter[0].n} → ${oneAfter[oneAfter.length - 1].n} 字)` +
        '\n  —— 新推理被追加进了旧段',
      )
    }
    assert(true, `U2 推理(2) 上屏后推理(1) 零增长(${oneAfter.length} 帧,恒 ${oneAfter[0]?.n} 字)`)
    return
  }

  if (kind === 'midjoin') {
    /*
     * ── V:**中途入场 / 重连时,当前请求已经流出来的正文必须可见** ────────────
     *
     * 判据是二值的,所以不设阈值:在**直播期**(读数行还在)那个记号有没有上过屏。
     * 修前它一帧都不上 —— 那一段既不在水位(第一条 delta 偏移不为 0 被丢)、也不在
     * parts(所属请求还没结算),要等 `run/end` 才整段冒出来。
     */
    const liveFrames = frames.filter(f => f.lv !== false)
    const seenLive = (tokenIndex, from = 0) =>
      liveFrames.filter(f => f.t >= from && f.s.some(b => (b.mk ?? []).includes(tokenIndex))).length

    const settledSeen = seenLive(0)
    const inflightSeen = seenLive(1)
    const firstAt = liveFrames.find(f => f.s.some(b => (b.mk ?? []).includes(1)))?.t
    const sampleStart = frames[0]?.t
    console.log(`  【V】直播帧 ${liveFrames.length} / 采到 ${frames.length}`)
    console.log(`  【V】已结算那一段 TKJ0 直播期可见 ${settledSeen} 帧(复现条件:前面确实有结算过的请求)`)
    console.log(
      `  【V】在飞那一段 TKJ1 直播期可见 ${inflightSeen} 帧`
      + (firstAt !== undefined && sampleStart !== undefined ? `,进场后 ${firstAt - sampleStart}ms 就上屏` : ''),
    )
    console.log(`  【V】重连时刻 ${reopenAt === null ? '(没做)' : `${Math.round(reopenAt)}ms`}`)

    assert(liveFrames.length > 20, `V 采到了直播期的帧(${liveFrames.length} 帧,读数行还在)`)
    assert(
      settledSeen > 0,
      `V 复现条件成立:前一个请求已经结算(TKJ0 在屏 ${settledSeen} 帧,parts 不是空的)`,
    )
    if (inflightSeen === 0) {
      throw new Error(
        '断言失败:V 中途入场时当前请求的正文一帧都没上屏 —— 直到 run/end 才出现'
        + '\n  —— 链:contentParts 只在 requestSettled 后物化 / anchorMessage 只在 parts 全空时才回落 content'
        + ' / 水位按连续前缀律丢掉了偏移不为 0 的第一条;三段各自都对,合起来就是这条回归',
      )
    }
    assert(true, `V1 中途入场:当前请求的正文在直播期就可见(${inflightSeen} 帧)`)

    if (reopenAt !== null) {
      const afterReopen = seenLive(1, reopenAt)
      if (afterReopen === 0) {
        throw new Error(
          `断言失败:V2 重连之后当前请求的正文又不见了(重连时刻 ${Math.round(reopenAt)}ms 之后 0 帧)`,
        )
      }
      assert(true, `V2 重连补齐:退回总览再点回来之后照样可见(${afterReopen} 帧)`)
    }
    return
  }

  if (kind === 'nested') {
    /*
     * 嵌套这一格没有自己的病可钉 —— 它守的是**通用的两条**(上面已经跑过):
     * 「流式末帧 == 冷加载」与「零双画」。这里只补一条完稿形:三形嵌套都得在。
     */
    const last = frames[frames.length - 1].s
    const kinds = last.map(b => b.d).join(' | ')
    console.log(`  【嵌套】完稿形:${kinds}`)
    assert(last.some(b => b.d === 'blockquote'), `完稿时引用块在屏幕上(${kinds})`)
    assert(last.some(b => b.d === 'ul' || b.d === 'ol'), `完稿时清单在屏幕上(${kinds})`)
    assert(
      last.some(b => b.mk?.includes(1)),
      '清单项里那段围栏的记号在屏幕上(TKN2)',
    )
    return
  }

  if (kind === 'monster') {
    /*
     * ── R:117 列的表**从第一个 `|` 起就是表**(R4b 的承诺政策)────────────
     * 修前(R4a 的 earlyForm):要等到「表头 + 半截分隔行」才认,117 列的表头
     * 700 字符往上,那一整段都是裸文本。修后承诺在行首 `|` 就做出。
     */
    const wide = hostTrail(frames, 0)
    const trail = wide.order.map(step => `${step.d}@${step.t}ms`).join(' → ')
    console.log(`  【R】117 列宽表记号住过:${trail}`)
    console.log(
      `  【R】裸段落 ${wide.counts.get('p') ?? 0} 帧 · 源码 ${wide.counts.get('code') ?? 0} 帧 · 表 ${wide.counts.get('table') ?? 0} 帧`,
    )

    /* ── S:分隔行写错的那张,收尾照实画成段落;流式期翻面**不许来回** ────── */
    const broken = hostTrail(frames, 2)
    console.log(`  【S】分隔行写错那张住过:${broken.order.map(s => `${s.d}@${s.t}ms`).join(' → ')}`)

    /* ── P:零竖向抖动 ─────────────────────────────────────────────────── */
    const liveFrames = frames.filter(f => f.lv !== false).length
    const jitter = findVerticalJitter(frames)
    // 收尾那一刻的重排只记读数不进断言(留账),与 O 条同款。
    const settleJitter = findVerticalJitter(frames.map(f => ({ ...f, lv: true })))
    console.log(`  【P】直播期竖向抖动 ${jitter.length} 处 / ${liveFrames} 帧(含收尾重排:${settleJitter.length} 处,留账不进断言)`)
    for (const j of jitter.slice(0, 6)) {
      console.log(`      t=${j.t}ms ${j.d} ${j.why === 'h' ? '高' : '顶'} ${j.from}→${j.to}px 「${j.h}」`)
    }

    /* ── Q:削列读数(收尾那一帧屏幕上真的画了几列)─────────────────────── */
    console.log(`  【Q】收尾表列数:${JSON.stringify(await readTableCols(page))}`)

    const nakedMs = wide.order[0]?.d === 'table'
      ? 0
      : (wide.order.find(s => s.d === 'table')?.t ?? Infinity) - (wide.firstAt ?? 0)
    assert(
      (wide.counts.get('code') ?? 0) === 0,
      `R 117 列宽表全程没被当成源码画过(${wide.counts.get('table') ?? 0} 帧是表)`,
    )
    if (!(nakedMs <= MONSTER_NAKED_BUDGET_MS)) {
      throw new Error(
        `断言失败:R 117 列表头裸挂了 ${nakedMs}ms(> ${MONSTER_NAKED_BUDGET_MS}ms 预算)—— ${trail}` +
        '\n  —— 用户截图的形:一百多列的表头以裸文本挂在屏上,分隔行流完才成表',
      )
    }
    assert(true, `R 117 列表从行首 \`|\` 起就是表(裸段落 ${nakedMs}ms ≤ ${MONSTER_NAKED_BUDGET_MS}ms)`)
    assert(wide.last === 'table', '完稿时那张 117 列宽表是表')

    assert(broken.last === 'p', `S 分隔行写错那张收尾照实画成段落(住过 ${[...broken.counts.keys()].join('/')})`)
    const flips = broken.order.length
    assert(flips <= 2, `S 翻面 ${flips} 次(≤2:一次上、一次下,不许来回)`)

    if (jitter.length > 0) {
      throw new Error(
        `断言失败:P 竖向抖动 ${jitter.length} 处(首处 t=${jitter[0].t}ms ${jitter[0].d} ` +
        `${jitter[0].why === 'h' ? '高' : '顶'} ${jitter[0].from}→${jitter[0].to}px)` +
        '\n  —— 用户报障的形:数据首行到达时整块上下抖',
      )
    }
    assert(true, `P 零竖向抖动(${frames.length} 帧逐帧量块顶与块高,按 DOM 身份分线)`)
    return
  }

  if (kind === 'table') {
    /*
     * ── I:一张表,从头到尾不许以**源码**示人 ──────────────────────────
     *
     * 修前真机录屏(七列八行,10fps 抽帧):
     *   Generating 1.6s  表头 + 半截分隔行,**裸段落**挂在屏幕上
     *   Generating 2.3s  分隔行到齐 → 我们把它降级成**代码块**(Copy source 檐)
     *   Generating 3.1s  还是代码块,已经五行数据
     *   收尾              才换成表
     * 那条降级的退出条件是 `text.endsWith('\n')` —— 一帧的文本结不结束在换行上是
     * 偶然,真机上一次都没赶上。本条素材的分片**永不落在换行上**(rowSafe),
     * 把那份偶然去掉,门才照见真机。
     */
    const wide = hostTrail(frames, 0)
    const trail = wide.order.map(step => `${step.d}@${step.t}ms`).join(' → ')
    console.log(`  宽表记号住过:${trail}`)
    console.log(
      `  裸段落 ${wide.counts.get('p') ?? 0} 帧 · 源码 ${wide.counts.get('code') ?? 0} 帧 · 表 ${wide.counts.get('table') ?? 0} 帧`,
    )
    if ((wide.counts.get('code') ?? 0) > 0) {
      throw new Error(
        `断言失败:I 那张表被当成源码画了 ${wide.counts.get('code')} 帧(${trail})` +
        '\n  —— 用户录屏的形:整张表以代码块摆着,直到收尾才变成表',
      )
    }
    assert(true, `I 宽表全程没被当成源码画过(${wide.counts.get('table') ?? 0} 帧是表)`)
    assert(wide.last === 'table', '完稿时那张十三列宽表是表')

    /*
     * ── J:表在**分隔行流完之前**就成形 ────────────────────────────────
     *
     * 判据不是拍脑袋的阈值,是**素材自己算得出来的那个数**:分隔行 106 个字符,
     * 按这一格的粒度流完要 `ceil(106/piece) × 45ms`。补齐规则的全部作用就是"不等
     * 它流完" —— 所以「裸段落挂了多久」必须短于「分隔行流完要多久」。
     *
     * 真机对照(6 字/帧):补齐后裸 555ms、拆掉补齐 1243ms、分隔行 810ms —— 一条
     * 判据同时把两边分开。列越多这条差距越大,而列多正是用户报障的那一形
     * (13 列的截图裸了 3.5s+)。
     */
    const formedAt = wide.order.find(step => step.d === 'table')?.t
    const nakedMs = formedAt !== undefined && wide.firstAt !== undefined ? formedAt - wide.firstAt : Infinity
    const separatorMs = Math.ceil(TABLE_SEP.length / piece) * PIECE_DELAY_MS
    if (!(nakedMs < separatorMs)) {
      throw new Error(
        `断言失败:J 表等到分隔行流完才成形 —— 裸段落 ${nakedMs}ms ≥ 分隔行流完所需 ${separatorMs}ms` +
        '\n  —— 用户报障的形:表头 + 分隔行以裸文本挂在屏上 3.5s+(列越多挂越久)',
      )
    }
    assert(
      true,
      `J 表在分隔行流完之前就成形(裸段落 ${nakedMs}ms < 分隔行流完 ${separatorMs}ms)`,
    )

    /*
     * ── K:缩进四格的表**不许**被我们改成表 ────────────────────────────
     * 它在 CommonMark 里就是缩进代码块。剥缩进等于把真正的缩进代码块一起改了 ——
     * 那是可感知的行为裁定,不在本批。诊断里它是嫌疑 B,取证结论:**是解析器的
     * 正解,不是病**。
     */
    const indented = hostTrail(frames, 2)
    assert(
      indented.last === 'code',
      `K 缩进四格的表仍是代码块(CommonMark 正解,我们不乱改;住过 ${[...indented.counts.keys()].join('/')})`,
    )
    return
  }

  // ── 工具那一路(D/E/F/G)────────────────────────────────────────────
  const finalTools = frames[frames.length - 1].s.filter(b => b.k === 'tool').length
  assert(finalTools >= 2, `完稿时屏幕上有 ${finalTools} 件工具(素材给了两组:两连发 + 一次)`)
  assert(
    frames[frames.length - 1].s.filter(b => b.k === 'text').length >= 3,
    '完稿时三轮正文都在屏幕上',
  )

  /*
   * ── T:**推理与工具并存的那一窗**(R3 浸泡首单,用户真机截图)────────────
   *
   * 用户原话:「不知道为什么,think 还在,但是下面有一个工具调用」,附图里推理内容
   * 以斜体灰字摊在消息里。要分的是两件事:
   *  · 推理**穿的是哪件衣服** —— 思考件(斜体灰是它的定稿形,六轮比稿 S2:没有秒数、
   *    没有圆点、没有左竖线,也没有檐)还是正文件(那才是呈现回归);
   *  · 并存**合不合法** —— 行内推理紧接着一次工具调用,是 agent 一轮里的常态。
   * 这条只钉第一件;第二件是读数,交给拍板。
   */
  /*
   * A / B 两条**在工具素材上也跑一遍**(R3 浸泡首单第 3 问:工具行出现时,上方那段
   * 推理的块结构有没有异动)。它们本来只长在 think 素材上,而那条素材**没有工具**——
   * 「工具边界」正是要问的那个现场,所以搬一份过来。判据函数是同两个,不另写。
   */
  const thinkVanished = findThinkVanished(frames)
  if (thinkVanished.length > 0) {
    const shown = thinkVanished.slice(0, 5).map(v => `t=${v.t}ms ${v.before}→${v.after}`).join(' · ')
    throw new Error(`断言失败:A(工具素材)思考块消失了 ${thinkVanished.length} 次(${shown})`)
  }
  assert(true, `A 工具边界上思考块只增不减(${frames.length} 帧零消失)`)
  const thinkMoved = findThinkMoved(frames)
  if (thinkMoved.length > 0) {
    const shown = thinkMoved.slice(0, 5).map(m => `t=${m.t}ms「${m.head}」${m.was}→${m.now}`).join(' · ')
    throw new Error(`断言失败:B(工具素材)思考块搬家 ${thinkMoved.length} 次(${shown})`)
  }
  assert(true, 'B 工具边界上思考块不搬家(位置序号一帧都没变过)')

  const coats2 = markCoats(frames, 1)
  const coats3 = markCoats(frames, 2)
  const win = coexistWindow(frames)
  console.log(`  【T】行内推理 TKT2 住过:${[...coats2].map(([k, n]) => `${k}×${n}`).join(' / ') || '(没上过屏)'}`)
  console.log(`  【T】顶部推理 TKT3 住过:${[...coats3].map(([k, n]) => `${k}×${n}`).join(' / ') || '(没上过屏)'}`)
  console.log(
    `  【T】并存窗口(工具件与思考件同帧)${win.frames} 帧;窗口里思考块 aria-expanded:`
    + `${[...win.expanded].map(([k, n]) => `${k}×${n}`).join(' / ') || '(无)'}`,
  )
  assert(win.frames > 0, `T 采到了「推理在场 + 工具已开」的并存窗口(${win.frames} 帧)`)
  for (const [label, coats] of [['行内推理 TKT2', coats2], ['顶部推理 TKT3', coats3]]) {
    const wrong = [...coats.keys()].filter(k => k !== 'think')
    if (wrong.length > 0) {
      throw new Error(
        `断言失败:T ${label} 有 ${wrong.map(k => `${k}×${coats.get(k)}`).join('/')} 帧没穿思考件的衣服` +
        '\n  —— 呈现回归的形:推理被当成正文画(那才是「斜体正文摊在消息里」的病;' +
        '斜体灰字本身是思考块的定稿形,不是病)',
      )
    }
    assert(coats.get('think') > 0, `T ${label} 全程住在思考件里(${coats.get('think')} 帧)`)
  }

  if (stat.vanishText.length > 0) {
    const shown = stat.vanishText.slice(0, 5).map(v => `t=${v.t}ms 「${v.h}」(${v.n} 字)`).join(' · ')
    throw new Error(`断言失败:D 工具边界上有正文整块消失 ${stat.vanishText.length} 次(${shown})`)
  }
  assert(true, `D 工具边界正文零消失(${frames.length} 帧,LCS 对齐后)`)

  if (stat.crossed.length > 0) {
    const shown = stat.crossed.slice(0, 5).map(c => `t=${c.t}ms 「${c.h}」工具数 ${c.was}→${c.now}`).join(' · ')
    throw new Error(`断言失败:E 正文跨过了工具 ${stat.crossed.length} 次(${shown})`)
  }
  assert(true, 'E 正文一次都没跨过工具(它前面有几件工具,逐帧不变)')

  if (stat.toolRemount.length > 0) {
    const shown = stat.toolRemount.slice(0, 5).map(r => `t=${r.t}ms 第${r.at + 1}件 ${r.was}→${r.now}`).join(' · ')
    throw new Error(`断言失败:F 工具那一件东西被卸载重挂 ${stat.toolRemount.length} 次(${shown})`)
  }
  assert(true, `F 工具零重挂(${stat.toolFrames} 帧里工具容器始终是同一个 DOM 节点)`)

  assert(stat.sawInputStreaming, 'G 参数逐片到达的那一段时间里,屏幕上有一行在等(input-streaming)')
  void index
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

async function runCase(kind) {
  const spec = CASES[kind]
  const store = await mkdtemp(path.join(tmpdir(), `structure-gate-${kind}-`))
  const mockPort = 18800 + Math.floor(Math.random() * 200)
  let mock
  let server
  let app
  try {
    mockState.tools = spec.tools
    mockState.script = spec.script
    mockState.rowSafe = spec.rowSafe === true
    mockState.delay = spec.delayMs ?? PIECE_DELAY_MS
    mockState.turns = spec.turns
    mock = await startMockProvider(mockPort)
    // 钥匙走环境变量(headless core 没有 safeStorage,理由见 gate-stream-monotone.mjs)。
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: {
        provider: 'deepseek',
        temperature: 0.6,
        providers: {
          deepseek: {
            baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            model: 'deepseek-reasoner',
            selectedModels: ['deepseek-reasoner'],
            enabled: true,
            modelCapabilitiesByModel: {
              'deepseek-reasoner': { tools: spec.tools, reasoning: true, vision: false },
            },
          },
        },
        customProviders: [],
        modelCatalog: {},
      },
      tools: { enableToolCalls: spec.tools },
    }))

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store, DEEPSEEK_API_KEY: 'sk-structure-gate' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', chunk => serverErr.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch(error => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    assert(await portConnects(record.host, record.port), `[${kind}] core 端口 ${record.port} 可连`)

    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    /*
     * `--r2=off` 把壳切回**拼装机器**那条旧路(R3 之前一直留着的回滚口)。
     * 档位在模块初始化时读一次,所以要先写 localStorage 再重载。
     * 门自己永远跑新路(不传参);这个口是给**反证**与 R3 回滚演练用的。
     */
    /*
     * **档位每次都显式写一遍,不许继承上一次**。
     *
     * 学费:`ONETHING_STORE_PATH` 换的是账本,**换不掉 Electron 的 userData** ——
     * localStorage 活在那儿,跨门跑存活。跑过一次 `--r2=off` 之后,后面每一次
     * 都在旧路上跑而门自己浑然不觉(真的发生了:D 条突然红,查了两轮才发现
     * 那几次根本没走新路)。所以这里不是「要关才写」,是**每次都写**。
     */
    /*
     * `--blockstream=off` 把壳切回 R4a 之前那条:每帧一份新的块列表,身份由渲染侧
     * 按源偏移现算。同一条学费,同一条写法 —— **每次都显式写一遍并打印**。
     */
    const r2 = process.argv.includes('--r2=off') ? 'off' : 'on'
    const blockStream = process.argv.includes('--blockstream=off') ? 'off' : 'on'
    await page.evaluate(
      value => {
        window.localStorage.setItem('onething.streamR2', value.r2)
        window.localStorage.setItem('onething.blockStream', value.blockStream)
      },
      { r2, blockStream },
    )
    await page.reload()
    console.log(`  [档位] onething.streamR2 = ${r2} / onething.blockStream = ${blockStream}`)
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )

    // 同一台应用跑完这条素材的全部粒度 —— 每格一条新会话,省掉冷启的那几秒。
    for (const [index, piece] of spec.pieces.entries()) {
      await runCell({ record, page, kind, piece, index })
    }

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    if (mock) mock.close()
    await delay(600)
    await rm(store, { recursive: true, force: true })
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[structure-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[structure-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }
  const only = process.argv.find(a => a.startsWith('--only='))?.slice(7)
  // `--pieces=6` 只跑矩阵的一列。**门自己永远跑满矩阵**(CI 不传参),这个口是给
  // 反证用的:拆掉一条修法之后要快速看它红在哪一格,不必等满矩阵跑完。
  const pieces = process.argv.find(a => a.startsWith('--pieces='))?.slice(9)
  const kinds = only ? only.split(',') : Object.keys(CASES)
  for (const kind of kinds) {
    if (!CASES[kind]) throw new Error(`没有这条素材:${kind}(有的是 ${Object.keys(CASES).join(' / ')})`)
    if (pieces) CASES[kind].pieces = pieces.split(',').map(Number)
    await runCase(kind)
  }
  console.log('\n[structure-gate] ok —— 思考块不消失不搬家、表格不回退;工具边界正文不消失不跨界、工具行不重挂、参数流式期有呈现')
}

main().catch(error => {
  console.error('\n[structure-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
