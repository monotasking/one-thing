# 宠物系统（第一只：黑豆）

2026-09-17 立。样例：<https://claude.ai/artifact/WTQK7gQcGDp4TBraw4D55Q>（黑豆电台）。

用户原话：「可以把黑豆捞出来单独做，为后续的宠物系统留下扩展，整体我挺满意的」。

## 0. 一句话

宠物是**住在应用里的一个角色**，不是某个应用的一块界面。应用只管发出自己本来就有的事实（放了哪首歌、跳过了、任务完成了）；宠物自己决定看到这些事实后是开口、嘀咕、换个姿势，还是什么都不做。电台只是黑豆住的第一个地方。

## 1. 为什么要从音乐里拆出来

样例里黑豆的一切都写在音乐面板里：姿势、气泡、戳和撸、换片空档开口。如果照这个形状落地，会出三个问题：

1. **换一只宠物要改音乐面板。** 角色的形象、口吻、台词和电台的播放逻辑搅在一起。
2. **黑豆去不了别的地方。** 以后想让它在待办完成时夸一句、在聊天输入框旁边打盹，只能在每个面板里再抄一份。
3. **开口的规矩会分散。** 「多久最多开口一次」「嘀咕不出声」这种规矩必须只有一个地方管，否则电台和待办会同时抢着说话。

所以拆成：**宠物（谁）/ 时刻（发生了什么）/ 栖位（它在哪儿露面）** 三件事，各管各的。

## 2. 五个对象

### 2.1 宠物 `PetManifest`（数据，产品层）

一只宠物就是一份自述，纯数据：

| 字段 | 含义 | 黑豆 |
| --- | --- | --- |
| `id` / `name` | 标识与名字 | `heidou` / 黑豆 |
| `rig` | 形象用哪一套绘制（壳侧按这个 id 查表） | `heidou-svg` |
| `voice` | TTS 音色与语速 | 偏高、偏软、语速稍快 |
| `persona` | 开口时交给模型的口吻说明 | 一次最多两句；用「我」；说具体细节；记得你做过的事；不每句加「喵」 |
| `mutters` | 嘀咕台词表，按**通用反应**分组（`poked` / `stroked` / `liked` / `woke` / `error` / `annoyed`…），不按应用分 | 「别闹，快到副歌了」「呼噜……再来一下也行」 |
| `poses` | 这只宠物能演哪些姿势（§2.4 的词表子集） | 全部 |

放在 `packages/onething-runtime/src/pets/`。内置宠物与以后插件交来的宠物用**同一个类型**（插件那一格是 `contributes.pet`，见 §6 P5）。

### 2.2 时刻 `Moment`（事实，不新开通道）

时刻就是资源事件，外加少量宠物自己产生的事件。**不新开任何推送通道**：应用已经通过资源自述的 `events` 发事实，这些事实已经走 `resource:event` 出到 SSE（原子 K2a′）。

要加的只有一格：`EventSpec` 上一个可选的 `moment` 声明，表示「这条事实值得主持人知道」：

```ts
interface EventSpec {
  readonly title: string
  readonly payload: JsonSchema
  /** 这条事实值得宠物知道。缺省 = 宠物看不见它。内核不解释，只透传。 */
  readonly moment?: {
    /** 打断你的价值：high 可以开口，normal 只在空闲时开口，low 最多嘀咕 */
    readonly weight: 'high' | 'normal' | 'low'
    /** 给模型看的一句话，说明这条事实在人话里是什么意思 */
    readonly gist: string
  }
}
```

应用**不知道有宠物**。音乐在自己的 `resource-spec.ts` 里给「换到下一张」「连跳」标上 `moment`；待办给「任务完成」标上。宠物系统只读这张表。

宠物自己产生的事件（戳、撸、醒来）是 `pet:` 资源的事件，同样走这条路。

### 2.3 主持人 `PetHost`（大脑，产品层纯类 + 装配层接线）

一个 `PetHost` 实例对应当前那只宠物。输入是时刻，输出是**话语**（一条带时间的事实）：

```ts
interface Utterance {
  id: string
  petId: string
  mode: 'speak' | 'mutter'      // 开口 = 有声、亮 ON AIR、压低音乐；嘀咕 = 只冒字
  text: string
  about?: { scheme: string; event: string }   // 因为哪条时刻
  at: number
  duck: boolean                 // 需不需要让出声的应用把音量压低
}
```

它负责三件别处不该管的事：

1. **注意力预算。** 开口有冷却（默认 4 分钟一次，`high` 可以插队）；同一时间只有一句话在说；嘀咕不占预算。
2. **记忆。** 一份按宠物分的互动账本：跳过、喜欢、点过的歌、被戳了几次。存在 `<store>/pets/<id>/ledger.jsonl`，开口时把最近几条交给模型。
3. **决定说什么。** 开口：persona + 时刻的 `gist` + 事实本身 + 记忆 → 模型生成（走 `toolCallModel`）。嘀咕：直接从 `mutters` 表里挑，本地完成、零延迟、不经过 TTS。

装配层 `packages/backend/wiring/pets/` 只做接线：订阅事件总线上的资源事件，喂给 `PetHost`；把话语作为 `pet:` 资源事件发出去；开口时调主进程语音（与 M3 同一条路）。

**电台的旧口播怎么办。** 电台指挥（`radio-conductor.ts`）今天自己生成口播词并调 `dj-voice.ts` 播。迁过来之后，电台只发一条带 `moment` 的事实「下一首的口播词准备好了」，说的人换成宠物。**没有装配宠物宿主的进程（CLI 守护进程）电台照旧自己播**：端口缺席 = 能力不存在，不是替代实现。

### 2.4 姿势 `Pose`（算出来，不存）

宠物现在在干什么不是一格状态，而是从应用的读法**算出来**的。每个应用在自述里声明一条「在场投影」，把自己的状态映射到一张通用的活动词表：

| 活动 | 含义 | 黑豆演成 |
| --- | --- | --- |
| `off` | 这个应用关着 | 耳机滑到脖子上睡觉 |
| `busy` | 正在准备（挑歌、生成中） | 翻唱片堆 |
| `rhythm(bpm)` | 在放、有节奏 | 跟拍子点头、唱片眼睛转 |
| `still` | 停下了 | 看着你，久了打盹 |
| `fault` | 出错 | 蚊香眼 |
| `idle` | 没什么事 | 坐着甩尾巴 |

再叠上宠物自己的瞬时状态：`speaking` / `muttering` / `listening`（你在打字）/ `petted`。优先级是一张表，写在 `pets/pose.ts` 一个纯函数里，壳和测试都调它。

音乐的投影：radio 关 → `off`；brief.starting 或 DJ 在挑 → `busy`；nowPlaying playing → `rhythm(bpm)`；paused → `still`；player error → `fault`。

### 2.5 栖位 `Perch` 与形象 `Rig`（壳侧）

**栖位**是某块界面留给宠物的一个位置，声明自己多大、锚点在哪、关心哪些应用的时刻：

```ts
interface PerchSpec {
  id: string                    // 'music.turntable'
  size: 'stage' | 'corner'      // 大场景 / 角落小图
  follows: readonly string[]    // ['music'] —— 这个栖位演哪些应用的在场投影
}
```

**宠物同一时刻只在一个地方。** 多个栖位同时可见时，它待在最近一条时刻来源的那个栖位里；其他栖位留空（唱机右下角就只是空着的底座）。这是它像「一只动物」而不是「一个到处贴的贴纸」的关键。

**形象**是一个壳侧组件，吃姿势、吐画面：

```ts
interface PetRigProps {
  pose: PoseState               // §2.4 算出来的
  beat?: number                 // rhythm 时的秒/拍
  mouth: 'closed' | 'talking'
  oneShot?: 'squish' | 'startle' | 'wake' | 'love' | 'twitch'
}
```

黑豆的形象是手画的 SVG 组件（样例里那只）。插件宠物的形象不能执行插件代码（插件宿主规矩：壳只吃描述树），所以 P5 另立一种**声明式形象**：分层图 + 每个姿势对应哪几层怎么动。

壳侧放在 `apps/desktop-react/src/pets/`：`PetStage`（栖位容器：气泡定位、戳/撸手势、焦点与键盘）、`rigs/heidou/`、`pose.ts` 的壳侧消费、`pet-source.ts`（`pet:` 资源的数据源，照 `music-source.ts` 的做法）。

## 3. `pet:` 资源自述

| 类 | 名字 | 说明 |
| --- | --- | --- |
| 读 | `roster` | 有哪些宠物（内置 + 插件） |
| 读 | `current` | 当前宠物、它在哪个栖位、瞬时状态、最近 20 条话语 |
| 做 | `adopt` | 换成另一只宠物（`ui_change`） |
| 做 | `poke` / `stroke` | 壳里的手势；只产生嘀咕，不改变任何应用 |
| 做 | `say` | 让它说一句（给模型与调试用；`mode` 必填） |
| 看 | `utterance` | 一条话语 |
| 看 | `moved` | 换了栖位 |
| 看 | `poked` / `stroked` | 带 `moment: { weight: 'low' }`，所以它们本身也是时刻 |

模型因此自动拿到一个 `pet` 工具（`catalog-sync.ts` 的既有机制），不需要手写。

## 4. 陌生能力演练

按根目录 CLAUDE.md 的规矩：拿三件设计时没专门想过的事，列出要改的文件。

**「待办全部完成时，黑豆夸一句」**
- `runtime/src/todo-plan/resource-spec.ts`：给「全部完成」那条事件加 `moment: { weight: 'normal', gist: '用户把今天的待办全做完了' }`。
- 完。宠物侧零改动。

**「加一只鹦鹉，会学你刚点的歌名」**
- `runtime/src/pets/builtin/parrot.ts`：一份 `PetManifest`。
- `apps/desktop-react/src/pets/rigs/parrot/`：形象组件。
- 两张注册表各一行。

**「聊天输入框旁边给宠物留个角落」**
- composer 顶条注册表（待办 T2 立的那张）加一行，内容是 `<PetStage perch={{ id: 'composer.corner', size: 'corner', follows: ['session'] }} />`。
- 会话资源自述里给「回复完成」「出错」标 `moment`，并声明在场投影（生成中 → `busy`）。

三条都是「能力自己的模块 + 壳渲染模块 + 各一行注册」，没有一条要改 `PetHost` 或 `PetStage`。

## 5. 不做的事

- **不做养成数值**（饥饿、亲密度、等级）。用户要的是主持人，不是电子宠物；记忆账本足够让它「记得你」。
- **不让宠物改变应用状态。** 戳、撸永远不会暂停或切歌；宠物能做的最大动作是开口和请求压低音量。点歌、换方向这类操作仍然走应用自己的做法（气泡里的选项按钮调的是 `music:radio` 的做法，不是宠物的）。
- **不做多宠物同屏。** 一次一只；换宠物走 `adopt`。

## 6. 分期

| 期 | 内容 | 改哪儿 | 门 |
| --- | --- | --- | --- |
| **P0 形象独立** | 把黑豆从样例搬成 `src/pets/`：`HeidouRig`、`PetStage`（气泡/戳/撸/键盘）、`pose.ts` 纯函数、嘀咕台词表；`?pet-lab` 开发页（所有姿势 × 栖位尺寸 × 中英）；先不接后端，状态由 lab 喂 | 只动壳 | 三张状态表先行；vitest（pose 优先级表、手势判定 8px/90px 阈值）；ui:consume；gate:a11y 加 lab 屏；reduced-motion |
| **P1 唱机成为第一个栖位** | 音乐面板按样例重做唱机场景（惯性转盘、先转后落针、封套换片），右下角放 `PetStage perch=music.turntable`；姿势从 `music:` 读法算；戳/撸本地嘀咕 | 壳 | music-lab 七宽 × 状态截图量；gate:squeeze |
| **P2 宠物宿主** | `runtime/src/pets/`（manifest、`PetHost` 纯类：预算/记忆/决策）+ `wiring/pets/` + `pet:` 资源；`EventSpec.moment` 一格；话语事件上 SSE；壳订阅 `current` | 后端 + 壳数据源 | PetHost 单测（冷却、插队、同时只一句、嘀咕不占预算）；资源门 |
| **P3 电台交给宠物说** | 电台口播改成发时刻；开口走主进程语音（M3 并入这一期）+ 压低音量；CLI 守护进程无宿主时电台照旧自己播 | runtime music + wiring | 真机：换片空档开口、压音量恢复、无宿主降级 |
| **P4 更多时刻** | 间奏（歌词时间轴找 ≥6s 空白）、连跳三首、深夜、暂停后回来；开口由模型按 persona 生成，嘀咕仍本地 | music 自述 + pets | 时刻回放测试（喂一段事件流，断言话语序列） |
| **P5 宠物可扩展** | 声明式形象格式；插件 `contributes.pet`；设置里「宠物」一页（换宠物、音色试听、开口频率三档：安静 / 适中 / 话多） | pets + 插件 + 设置 | 用鹦鹉走一遍 §4 演练 |

P0、P1 只动壳，不依赖后端任何一期，可以先做；P2 起才碰后端。M2（brief 补当前口播与阶段）并入 P2/P3，不再单独排。

## 7. 状态表（P0）

P0 不接后端：壳里的 `PetStage` 吃三样输入 —— 活动（由栖位的宿主算好传进来，lab 里由开关喂）、话语（同样由外部喂：`{ mode, text, choices?, sticky? }`）、以及它自己产生的手势状态。

### 7.1 生命周期

| 事件 | PetStage 做什么 | 保留什么 |
| --- | --- | --- |
| 挂载 | 按当前活动直接摆到对应姿势，不播 `wake`；气泡为空 | — |
| 活动变化 | 姿势过渡 450ms；`off → 任何` 播一次 `wake`；`still` 持续 9s 进 `dozing`；从 `dozing` 回 `rhythm` 播一次 `startle` 并嘀咕 `woke` 组 | 正在显示的气泡不打断 |
| 新话语进来 | 替换当前气泡（同一时刻只有一句）；开口逐字出现，嘀咕整句出现 | 撸的状态保留，但撸时来的开口会结束撸（松手前也结束） |
| 栖位尺寸变化 | 形象按栖位缩放；气泡重新定位（ResizeObserver 回调只读，定位在下一帧写，遵守 RO 律） | 气泡内容与剩余停留时间 |
| 隐藏（架子收起 / inert） | 暂停所有动画（`animation-play-state: paused`），计时器照走 | 气泡、姿势 |
| 卸载 | 清全部计时器与指针捕获 | — |

### 7.2 姿势（优先级从上到下，第一条命中即用）

| # | 判据 | 黑豆演成 | 一次性动画 |
| --- | --- | --- | --- |
| 1 | 正在被撸 | 闭眼、脸红、呼噜线抖、头歪、尾巴快甩 | — |
| 2 | 活动 = `fault` | 蚊香眼、头左右晃 | — |
| 3 | 活动 = `off` | 耳机滑到脖子、闭眼、蜷低、呼吸起伏、冒 z | 离开时 `wake` |
| 4 | 开口中（字还在出） | 坐直、耳朵外张、嘴一张一合；栖位里的 ON AIR 由宿主看 `speaking` 回调点亮 | — |
| 5 | 活动 = `busy` | 扭头看向身侧唱片堆（堆由栖位宿主画，PetStage 只给 `busy` 标记） | — |
| 6 | 你在打字（宿主传 `listening`） | 歪头、右耳抖 | — |
| 7 | 活动 = `still` 且已满 9s | 打盹：闭眼、呼吸起伏、冒 z，耳机不摘 | 离开时 `startle` |
| 8 | 活动 = `rhythm(bpm)` | 点头与右爪按 60/bpm 秒一拍、唱片眼睛转、尾巴按两拍甩 | — |
| 9 | 活动 = `still`（未满 9s）或 `idle` | 坐着看你，尾巴慢甩 | — |

嘀咕中不改变姿势（嘀咕只是冒字）。`prefers-reduced-motion`：去掉点头、打拍子、尾巴、z 上浮与唱片眼睛转动，保留姿势本身（眼睛开闭、耳机位置、头的角度）。

### 7.3 手势

| 手势 | 判据 | 前置 | 结果 | 焦点 | 影响应用 |
| --- | --- | --- | --- | --- | --- |
| 点 | pointerdown→up 累计水平位移 < 8px | 非开口中 | `squish` + 嘀咕：按活动选组（off→`sleepy`，fault→`dizzy`，busy→`busy`，rhythm→`poked`，其余→`waiting`） | 不移动 | 否 |
| 点（开口中） | 同上 | 开口中 | 只抖一下左耳，不换气泡 | 不移动 | 否 |
| 连戳 | 4s 内第 5 次点 | — | 嘀咕 `annoyed` 组，计数清零 | 不移动 | 否 |
| 撸 | 按住后累计水平位移 > 90px | 任意 | 进入撸姿势；当前嘀咕气泡收起 | 不移动 | 否 |
| 撸完松手 | 撸姿势中 pointerup / cancel | — | 退出撸；嘀咕 `stroked` 组（off 时用 `strokedAsleep`） | 不移动 | 否 |
| 8–90px 之间松手 | — | — | 什么都不发生 | — | 否 |
| 键盘 Enter / Space | 宠物按钮聚焦 | — | 等同点 | 留在宠物 | 否 |
| 点气泡里的选项 | 话语带 `choices` | — | 回调宿主 `onChoice(value)`，气泡收起 | 宿主决定；缺省回到宠物按钮 | 由宿主做 |

每个手势都通过 `onGesture({ kind: 'poke' | 'stroke' })` 通知宿主（P2 起宿主转成 `pet:` 的做法），P0 宿主可以不接。

### 7.4 气泡

| 种类 | 出现 | 停留 | 谁能关 | 定位 |
| --- | --- | --- | --- | --- |
| 开口 | 红色声波 + 逐字（中文标点处停 260ms，其余 95ms/字） | 字出完后 1.5s；声波变灰 | 新话语替换；宿主 `clear()` | 尾巴指向宠物头顶；左右夹在栖位内侧 12px；上边不出栖位，放不下时贴栖位顶 |
| 嘀咕 | 整句淡入，字号小一档、底色半透明、无声波 | 1.4–1.8s（台词表可指定） | 同上 | 同上 |
| 带选项 | 开口出完字后出现选项按钮，第一个按钮获得焦点 | 直到选择或被新话语替换 | 选择 / 新话语 / Esc（Esc 等于不选，回调 `onChoice(null)`） | 同上 |
| 常驻（`sticky`） | 同嘀咕，可带动作按钮 | 一直在 | 宿主清掉 / 动作按钮 | 同上 |

气泡是 `role="status"` + `aria-live="polite"`；选项按钮是真按钮，可 Tab。

## 8. P1：唱机成为第一个栖位

M1 的 `TurntableDeck`（CSS 唱片 + 唱臂）与 `HostLine`（主持人一行字）换成一块 **唱机场景** `content/music/TurntableScene.tsx`，照黑豆电台样例：房间墙与窗外雨、左侧封套、木底座、带频闪点的转盘、印弧形歌名的唱片与不随转的反光、唱臂（拖唱头 = seek）、右侧唱片堆、右下角 `PetStage perch=music.turntable`。电台条、控制条、节目单、歌词不动；样例 v7 的整面布局（播放列表抽屉、宽屏歌词右栏）是另一单，不在 P1。

场景是 640×420 的设计画布，按场景容器宽度等比缩放；容器 < 520px 时裁掉左侧窗户与半张封套（视口从 x=118 起，宽 522）。

### 8.1 活动从 `music:` 读法算（`content/music/pet-activity.ts`，纯函数）

| # | 判据 | 活动 |
| --- | --- | --- |
| 1 | `nowPlaying` 读法报错，或 `state.lastError` 在 | `fault` |
| 2 | 后端没配好（`setupStage !== 'ready'`） | `off` |
| 3 | 电台关着且没在放 | `off` |
| 4 | `brief.starting` 在，或电台开着、节目单读到了且为空、没在放 | `busy` |
| 5 | `playing` | `rhythm`（读数里没有 bpm，用 token 里的默认拍速 90） |
| 6 | `status === 'paused'` | `still` |
| 7 | 其余 | `idle` |

### 8.2 场景生命周期

| 事件 | 唱机做什么 | 黑豆 |
| --- | --- | --- |
| 挂载 | 直接摆到当前状态：在放 → 转盘满速、唱臂落在当前位置；暂停 → 唱臂抬在当前位置、不转；没歌 → 唱片收在封套里、唱臂归位、转盘空 | 直接摆姿势，不播 wake |
| 开始放（paused/stopped → playing，同一首） | 转盘先起转（0.9s 到满速），450ms 后唱臂抬着移到当前位置（900ms），落下 | 活动变 rhythm |
| 暂停 | 唱臂原地抬起；转盘靠惯性 1.6s 停 | still，9s 后打盹 |
| **换歌**（`title` 从一个非空值变成另一个非空值） | 唱臂抬起归位（900ms）同时转盘减速 → 唱片抬起收进封套（680ms）→ 封套换成新歌（600ms）→ 唱片滑出落回（680ms）→ 若在放：起转 + 落针到**此刻的播放位置**。整段约 3.3s，音乐不等动画；期间唱臂不可拖 | 不变（活动仍是 rhythm） |
| 换歌时恰好有口播 | `brief.starting` 出现时，取节目单里标题匹配那条（找不到取第一条）的 `say`，交给 PetStage 作一句**开口**话语 | 开口姿势 + 逐字气泡 |
| 播放器停了（有歌 → 无歌） | 唱臂归位，转盘停，唱片收进封套，封套变素面 | 按 8.1 |
| 电台关台 | 同上，房间灯暗一半（墙面 filter） | 睡 |
| 进度被别处 seek | 唱臂 300ms 过渡到新位置（不走换歌动画） | 不变 |
| 面板隐藏（架子收起 inert）或 `document.hidden` | 停掉转盘的 rAF；恢复时按当前状态直接摆，不补播动画 | PetStage 自己暂停动画 |
| 卸载 | 取消 rAF、在飞的动画计时器、唱臂指针跟踪 | PetStage 自己清 |

转盘角速度只在 rAF 里改 `transform`（唱片与频闪环两个元素），不进 React 状态；唱臂角度在播放中每帧按「读数位置 + 墙钟推进」算，与进度条、歌词高亮用同一个数（`usePlaybackPosition`）。

### 8.3 交互

| 手势 | 前置 | 结果 | 发什么 |
| --- | --- | --- | --- |
| 按住唱头拖 | 有总长、不在换歌动画中 | 唱臂抬起跟手（夹在唱片外圈到内圈之间），唱头旁显示时间；转盘照转 | 什么都不发 |
| 松手 | 同上 | 唱臂落下 | `seek {position}` 一次 |
| 拖到一半 Esc / 窗口失焦 / 指针被收走 | — | 唱臂回到拖之前的位置 | 什么都不发 |
| 唱头聚焦 ←/→ | 有总长 | 每次 ±10s，唱臂 300ms 过渡 | `seek` |
| 点唱片 / 封套 / 墙 | — | 什么都不发生（不做搓碟、不做点唱片进歌词） | — |
| 点 / 撸黑豆 | — | 本地嘀咕（P0 行为） | 什么都不发 |
| ♥ 成功 | Transport 的 like 做法回来且无错 | 黑豆 `love()`：冒爱心 + 嘀咕「记住了，你好这口。」 | （like 本身由 Transport 发） |

`prefers-reduced-motion`：窗外雨停、唱片摆动去掉、换歌动画变成 150ms 淡入淡出；转盘照转（转不转是信息）。

## 9. P2：宠物宿主（后端）

P2 只立骨架与一条真路：**时刻进来 → 宿主记账、按预算决定 → 话语作为 `pet:` 事件出去 → 壳上的栖位演出来**。开口的文字生成（模型写词）是 P4，出声是 P3；P2 里能开口的只有「时刻自己带着现成台词」的那一类（`payload.say`），以及 `pet:` 的 `say` 做法。

### 9.1 分层与文件

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 内核 | `packages/core/resource/spec.ts` | `EventSpec.moment?: { weight: 'high' \| 'normal' \| 'low'; gist: string }`。内核只透传（`describe` 里带出去），不解释 |
| 产品 | `packages/onething-runtime/src/pets/` | `manifest.ts`（`PetManifest`：id / name / rig / voice / persona，**不含**嘀咕台词 —— 嘀咕是壳本地的）、`builtin/heidou.ts`、`registry.ts`（内置宠物一张表）、`host.ts`（`PetHost` 纯类）、`ledger.ts`（账本行的形与折叠）、`composer.ts`（`MomentComposer` 端口 + P2 缺省实现 `SayPassthroughComposer`）、`resource-spec.ts`（`pet:` 自述，纯数据） |
| 装配 | `packages/backend/wiring/pets/` | `subsystem.ts`（`PetsSubsystem`：建宿主、订资源事件、写账本、`dispose`）、`ledger-store.ts`（`<store>/pets/<id>/ledger.jsonl` 追加写 + 启动读尾部 N 行；`<store>/pets/current.json` 记当前宠物） |
| 装配 | `packages/backend/wiring/resource/pet-provider.ts` | `pet:` 的 provider，读 / 做都转给 `PetsSubsystem` |
| 组合根 | `OnethingBackendOptions.pets?: boolean` | React 壳与 server 传 `true`，CLI 守护进程不传。**缺席 = 这台宿主没有宠物**：不注册 `pet:`、不订事件、电台照旧自己播（P3 用到） |
| 壳 | `apps/desktop-react/src/data/pet-source.ts` | `petCurrentQuery`、订 `resource:event` 前缀 `pet:`、`usePetUtterance()`（最新一条话语，新对象身份 = 新话语）、`petOps.poke / stroke`（发完不等） |

### 9.2 `PetHost` 的规矩（纯类，时钟注入）

| 规矩 | 细则 |
| --- | --- |
| 同一时刻只有一句开口 | 开口开始后 `speakingUntil = at + estimateSpeechMs(text)`（字数 / 4.2 秒，复用 `music/lyrics.ts` 的 `estimateSpeechSeconds`；P3 换成语音回执）。这段时间里再来的开口请求**丢弃并记账**（`dropped: 'busy'`），不排队 |
| 冷却 | 两次开口之间至少 `cooldownMs`（缺省 240_000）。`normal` 撞冷却 → 丢弃记账（`dropped: 'cooldown'`）；`high` 无视冷却，但仍受「同一时刻一句」约束 |
| `low` 权重 | 永远不开口，只记账 |
| 没台词 | 作曲端口答 `null` → 只记账（`dropped: 'nothing-to-say'`）。P2 缺省作曲器只认 `payload.say`（非空字符串） |
| `say` 做法 | 调用方指定 `mode`。`speak` 走与时刻相同的「一句 + 冷却」规矩但**视为 high**（人或模型明确要它说）；`mutter` 不占预算、不改 `speakingUntil` |
| 记忆 | 每条时刻、每条话语、每次丢弃都进账本；宿主内存里保留最近 50 行，`current` 读法交出最近 20 条话语 |
| 换宠物 | `adopt` 换 manifest、写 `current.json`、清 `speakingUntil`；账本按宠物分目录，不清 |

### 9.3 `pet:` 自述

| 类 | 名字 | 效果 | 说明 |
| --- | --- | --- | --- |
| 读 | `roster` | — | 内置宠物列表 `{ id, name, rig }` |
| 读 | `current` | — | `{ pet: { id, name, rig }, speaking: boolean, speakingUntil?: number, utterances: Utterance[] }`（最近 20 条，新的在后） |
| 做 | `adopt` | `ui_change` | `{ id }`；未知 id 当场拒绝 |
| 做 | `say` | `ui_change` | `{ mode, text }`；被预算挡掉时回执里说原因，不抛 |
| 做 | `poke` / `stroke` | `[]` | 壳的手势。只发对应事件、记账，**不产生话语**（嘀咕在壳本地） |
| 看 | `utterance` | — | `Utterance`（§2.3 的形），无 `moment` 声明（宠物不对自己说的话起反应） |
| 看 | `poked` / `stroked` | — | `{ at }`，`moment: { weight: 'low', gist: '用户戳了 / 撸了宠物' }` |

`pet:` 是单例（与 `music:radio` 同理）：地址 `pet:current`，`ref` 可省。

### 9.4 时刻从哪来

`PetsSubsystem` 挂在事件总线上已经在转发的资源事件上（`forwardResourceEventsToBus` 那一路），对每条事件查 `ResourceRegistry` 里那种资源自述的 `events[name].moment`：没有声明就忽略；有就折成 `Moment { scheme, event, weight, gist, payload, at }` 喂给宿主。**`pet:` 自己的事件同样走这条路**（`poked` / `stroked` 只进账本）。

P2 不给任何应用标 `moment`（音乐的标注是 P3）。验证用测试里的假 provider。

### 9.5 壳侧消费

- `TurntableScene` 的 `PetStage.utterance` 改为「后端最新话语」与 P1 本地 `startingSay` 两路里**更新的那一条**（P3 删本地那路）。
- 戳 / 撸除了 P0 的本地嘀咕，另发 `petOps.poke / stroke`（失败不提示、不重试 —— 手势不该因为后端掉线而有任何可见变化）。
- `pet:` 读法没配（宿主没有宠物子系统）时：`current` 读失败 → 栖位照 P1 行为跑，零提示。

### 9.6 门

- `PetHost` 单测：冷却、high 插队、一句时丢弃、low 只记账、mutter 不占预算、adopt 清 speaking、账本行形。
- provider / 子系统测试：假资源发带 moment 的事件 → `pet:` 发出 `utterance`；不带 moment 的被忽略；`pets` 不开时 `pet:` 不在注册表。
- `bun run boundary:gate`、`bun run assembly:gate`（新状态住实例上，不许新增模块级 `let`）、`bun run transport:gate`、`bun run typecheck`、根 `bun run test` 相关目录、壳 `npm test` / `typecheck` / eslint 本批文件 / `ui:consume`。

## 10. P3：电台交给宠物说，主进程出声

### 10.1 今天的路与它的毛病

电台开口是 `wiring/music/radio.ts` 的 `playProgrammeEntry` 调 `dj-voice.ts` 的 `speakDjPatter(say, title)`：合成（带缓存与预取）→ 把音频经 `broadcastVoiceHostMessage(MUSIC_DJ_SPEAK)` 推给渲染进程播 → 等渲染进程回执（上限 30s）。两条时机：前奏够长就**压着前奏说**（`talkOverIntro`，歌先放、话并行），否则**先停、在静音里说**、与起播命令并行。

React 壳的宿主表里 `voice: null`，没有渲染进程听这条推送：合成成功时电台会**空等 30 秒回执**，口播永远没声音。

### 10.2 改成什么

| 件 | 位置 | 内容 |
| --- | --- | --- |
| 出声端口 `speechOutput` | `OnethingHostPorts` 新键（第十七个）+ `runtime/src/voice/speech-output.ts`（`configureSpeechOutputHost` / `reset…` / `getSpeechOutput`） | `{ play(audio: { base64, mimeType }, signal): Promise<void> }`，播完 resolve，signal 中止即停。React 壳注入实现；server 与 CLI 守护进程传 `null` |
| 壳的实现 | `apps/desktop-react/electron/speech-output.ts` | 写临时文件（`os.tmpdir()`，播完删）→ 子进程播放：`mpv --no-video --really-quiet`（`PATH` 里有就用），否则 macOS `afplay`；都没有 → `play` 立刻 resolve 并记一条 warn。中止 = 杀子进程。同一时刻只播一段：新的一段先停旧的 |
| 主持人声音端口 `hostVoice` | `wiring/music/host-voice.ts` | 电台只认这一个接口：`prefetch(text, title)` / `speak(text, { title, overMusic }): Promise<void>`。**缺省实现**＝今天的 `dj-voice`（合成 → 有 `speechOutput` 就在进程内播、没有且有语音宿主就推渲染进程、两者都没有就立刻 resolve，不再空等） |
| 宠物接管 | `wiring/pets/subsystem.ts` | `pets` 开着时，组合根把 `hostVoice` 换成 `PetsSubsystem.hostVoice`：先让宿主**认领**这句话（§10.3），发 `utterance` 事件（壳上出气泡），再合成 + 播放，播完发 `hushed` 事件并把 `speakingUntil` 改成实际结束时刻。合成走同一份缓存（复用 dj-voice 的缓存函数，不复制） |
| 压低音乐 | `radio.ts` | `overMusic: true`（压着前奏说）时，电台自己在说话前把播放器音量降到当前的 35%，说完恢复原值；恢复失败记 warn、不重试。静音里说不压 |
| 音色 | `PetVoice → VoiceSettings` 映射，`wiring/pets/voice.ts` | 只映射当前语音设置里真有的旋钮（语速；有音调就音调）；没有的旋钮忽略。没配语音 → 合成返回空 → 不出声，但气泡照出 |

音乐域**不 import 宠物**：它只拿 `hostVoice`。

### 10.3 宿主认领电台口播

电台口播不是「宠物想说」，是节目的一部分，**不能被预算丢掉**。`PetHost` 加一条入口 `claim({ source, text })`：

| 情况 | 结果 |
| --- | --- |
| 空闲 | 立刻开口：记账、`lastSpokeAt = now`、`speakingUntil = now + 估计时长`（播完改成实际） |
| 冷却中 | 无视冷却（同 `high`） |
| 正在说别的 | **等**当前那句结束再开口，最多等 10s；超时就直接开口（电台的时机更要紧），并在账本记 `preempted` |
| 换宠物中 / 子系统已 dispose | 返回「不认领」，`hostVoice` 退回缺省实现照播 |

### 10.4 `pet:` 自述增补

| 类 | 名字 | 说明 |
| --- | --- | --- |
| 看 | `hushed` | `{ utteranceId, at }` —— 这一句真的说完了（播完、失败或被中止）。无 `moment` |

`current.speaking` 从「估计时长」改为「认领后到 `hushed` 之前」；没有出声的话语（嘀咕、无语音）仍按估计时长。

### 10.5 壳

- `TurntableScene` 删 P1 的本地 `startingSay` 那一路（后端话语已经覆盖）；`pet:current` 读失败时（宿主没有宠物）气泡就不出。
- **ON AIR 灯**回来：底座上一块灯，`pet:` 最近一条 `speak` 话语到它的 `hushed` 之间亮。它是唱机场景的一件物件，不是文字标签。
- 栖位里开口的逐字速度不变；声音比字先说完时，气泡在 `hushed` 到达后收起（不等字打完就把剩下的字一次出齐）。

### 10.6 状态表

**口播一句话的生命周期**

| 步 | 后端 | 壳 |
| --- | --- | --- |
| 预取 | `hostVoice.prefetch` → 合成进缓存 | — |
| 认领 | `PetHost.claim` 成功 → 账本记 utterance | — |
| 发出 | `utterance` 事件 | 气泡开始逐字，灯亮 |
| 压音量（仅 overMusic） | 播放器音量 → 35% | — |
| 播放 | `speechOutput.play` | — |
| 结束 | 恢复音量；`hushed` 事件；`speakingUntil = now` | 字出齐、灯灭、1.5s 后气泡收 |
| 关台 / 停止电台中途 | signal 中止 → 子进程被杀 → 同「结束」 | 同上 |
| 合成失败 / 没配语音 | 跳过播放，直接「结束」 | 气泡照出、灯亮到 `hushed`（几乎立刻） |

### 10.7 门

- 单测：`PetHost.claim` 四行表；`hostVoice` 缺省实现在「无出声端口、无语音宿主」时立刻 resolve（回归 30s 空等）；`PetsSubsystem.hostVoice` 事件顺序 `utterance → hushed`、中止路径；`radio` 在 overMusic 时降音量并恢复（假播放器）；壳 `speech-output.ts` 选择播放器的判据（注入 `which` 与 spawn）；`TurntableScene` 灯亮灭。
- `bun run typecheck`、`boundary:gate`、`assembly:gate`、`transport:gate`（不许新 IPC 通道）、`log:gate`、`gate:native`（不许引入原生依赖）；`packages/backend/__tests__/host-ports.type.test.ts` 同步第十七键；壳 `npm test` 相关目录、typecheck、eslint、`ui:consume`。
- 不跑桌面真机；出声的真机验收留给用户（换歌时听到黑豆的声音、压着前奏说时音乐变小）。

## 11. P4：更多时刻，模型写词

P3 之后黑豆只在电台口播时开口（词是电台 DJ 会话写的）。P4 让它**自己**对几件事开口：词由模型按 persona 写，声音走 P3 的同一条出声路。

### 11.1 音乐发出的新事实（`music:` 自述增补）

音乐域只加**音乐自己的事实**，标 `moment`；不知道有宠物。

| 地址 | 事件 | 负载 | 何时发 | moment |
| --- | --- | --- | --- | --- |
| `music:player` | `trackStarted` | `{ title, artist?, encryptedId? }` | 电台确认一首歌真的在放（`onSongStarted`） | `low`「开始放一首歌」 |
| `music:player` | `skipped` | `{ title }` | 电台开着时 `next` 跳过（`recordRadioSkip` 那一处） | `low`「用户跳过了一首歌」 |
| `music:player` | `skipStreak` | `{ count, titles }` | 90s 内第 3 次跳过（发完计数清零） | `high`「用户连着跳过了好几首，可能不喜欢现在的方向」 |
| `music:player` | `liked` | `{ title }` | ♥ 成功 | `low`「用户喜欢了这首歌」 |
| `music:player` | `resumedAfterPause` | `{ pausedMs, title? }` | 暂停 ≥ 5 分钟后继续 | `normal`「用户暂停了一阵又回来继续听」 |
| `music:player` | `interlude` | `{ title, atSeconds, lengthSeconds }` | 播放中到达歌词时间轴里**歌中间**一段 ≥ 12s 的无词空档（不算前奏与尾奏），每首最多一次；没有歌词时间轴不发 | `normal`「这首歌到了一段没有人声的间奏」 |

连跳计数、暂停计时、间奏检测都住在音乐的装配层（`wiring/music/`，音乐自己的状态，放在已有的 music 实例上，不新增模块级 `let`）。

### 11.2 模型作曲器

| 件 | 位置 | 内容 |
| --- | --- | --- |
| 提示词（纯函数） | `runtime/src/pets/prompt.ts` | `buildMomentPrompt({ pet, moment, memory, localTime, locale })` → `{ system, user }`。system = persona + 硬规矩（一次最多两句、不超过 60 字、用「我」、不说「为您播放」、不编造读数里没有的事、没什么值得说就答 `null`）；user = 时刻的 `gist` + 负载的精简 JSON + 最近 10 条账本行的人话摘要 + 本地时间（让「深夜」自然出现，不另立时刻）。要求只回 `{"say": string \| null}` |
| 解析（纯函数） | 同上 `parseMomentReply(text)` | 容忍代码围栏与前后废话；取不到或 `say` 为空 → `null` |
| 模型作曲器 | `wiring/pets/model-composer.ts` | 用 `createUtilityProvider(settings)`（`settings.tools.toolCallModel`，与会话目录同一只小模型）；超时 8s；失败 / 没配小模型 → `null` 并记 warn（没配只记一次）；用量记账照 `toc` 的 `bill-side-line` 做法 |
| 组合 | `wiring/pets/subsystem.ts` | `payload.say` 有值 → 直通（P2 行为）；否则 → 模型作曲器 |

### 11.3 宠物自己开口也要出声、也要压音乐

P3 的出声路只接在电台的 `hostVoice` 上。P4 把「合成 → 出声 → hushed」抽成 `PetsSubsystem` 内部一段 `voiceUtterance(utterance, signal)`，电台认领与宠物自发开口共用。

压音乐从「电台自己在说话前降音量」改成**订一条进程内事件**：出声那一段开始时在事件总线上发 `speech:activity { active: true }`，结束发 `{ active: false }`（仅进程内，不出 SSE）。音乐装配层订它：**播放器正在放**时才压到 35%，结束恢复；电台口播也走这一条（删掉 P3 在 `radio.ts` 里的直接压音量调用，避免两处各压一次）。事件名与负载不含「宠物」「电台」字样。

### 11.4 规矩不变的部分

- 冷却、一句一时、`low` 只记账：P2 的 §9.2 表原样适用。
- 电台口播仍经 `claim`，永远不被预算丢掉；宠物自发开口遇到正在认领的口播 → `busy` 丢弃。
- 模型答 `null` → `nothing-to-say` 进账本，不出气泡。

### 11.5 门

- 纯函数单测：`buildMomentPrompt` 快照（固定时钟 / 记忆）、`parseMomentReply` 各种脏回复。
- **时刻回放测试**：假时钟 + 假作曲器，喂一段事件流（开台 → 3 首歌 → 90s 内连跳 3 次 → 暂停 6 分钟后继续 → 间奏），断言话语与丢弃序列逐条相等。
- 音乐：连跳计数窗口与清零、暂停计时阈值、间奏检测（前奏 / 尾奏不算、每首一次、无时间轴不发）、`speech:activity` 压 / 恢复只在播放中。
- `bun run typecheck`、`boundary:gate`、`assembly:gate`、`transport:gate`、`log:gate`；相关 vitest；壳若有改动跑壳门。
