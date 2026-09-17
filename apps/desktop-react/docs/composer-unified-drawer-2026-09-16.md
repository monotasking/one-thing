# Composer 抽屉并入面板:一块面板往上展开(2026-09-16,方案)

## 0. 起因

用户 09-16 原话大意:点模型选择时,弹出来的抽屉应该和 Composer 是一体的,而不是一个独立的外层;现在展开后焦点只画在 Composer 上,而且 Composer 的焦点形状变了,上沿像被磨平;希望是 Composer 自己展开,而不是冒出一块新面板。`@` 文件、`/` 命令也是同一个问题。

## 1. 今天为什么是两块

三处代码合起来造成了用户看到的样子:

1. **抽屉是面板外面的另一个盒子。** `.drawer` 是 `position: absolute; bottom: 100%`,贴在 `.panel` 上沿之外,自带描边、上两角圆角、实底和阴影(`Composer.module.css` `.drawer`)。
2. **面板为了接住抽屉改了自己的样子。** `.panel:has(.drawerOpen)` 把面板上两角改成直角、玻璃底换成实底、描边换一档、`overflow` 改成 `visible`。所以一开抽屉,Composer 本身就变了形。
3. **焦点环只围面板。** 面板带 `data-focus-ring="text"`,环画在 `.panel` 这个盒子上,抽屉在盒子外面,不在环里;面板上两角又是直角,于是环的上沿是平的——这就是「磨平」。模型抽屉的搜索框还自带一格 `data-focus-ring="text"`,按「里层赢」规则,焦点在搜索框时环画在搜索框上,外框反而不亮。

抽屉在 09-12 被搬到面板外面,是为了治两个病:抽屉一开 `--composer-h` 跟着变大、贴底时把正文往上推;以及抽屉「先很短再慢慢长出来」。这两条治法本方案**全部保留**,只换掉「搬到外面」这个手段。

## 2. 目标形

**一块面板,一个外框。** 抽屉住进面板里面,排在最上面;面板往上长,下面的输入区和工具行一个像素不动。

```
┌──────────────────────── .panel(唯一的外框)────────────────────────┐
│ .drawer        [开着才占高;@ / / 固定高,模型 / 状态按内容]          │
│ ─────────────── 一条内分隔线(抽屉区的下边线)─────────────────────── │
│ .rest  data-composer-rest                                            │
│   状态条(有执行时)                                                  │
│   本体行:输入区 + 工具行 / ask 形态                                  │
└──────────────────────────────────────────────────────────────────────┘
```

- 外框的圆角、描边、阴影、焦点环**只有一份**,都在 `.panel` 上,开不开抽屉都一样。`.panel:has(.drawerOpen)` 里改圆角、改描边、改 `overflow` 的三句删掉。
- 抽屉区自己不再有描边、圆角、阴影、底色;它和下面的部分只用一条内分隔线分开。
- `.panel` 恢复常态的 `overflow: hidden`,抽屉内容被裁进同一个圆角里。

## 3. 四个细节的裁定

### 3.1 几何:正文照旧不被推

抽屉进了面板的流,`.composerDock` 会变高。消息流让出的底部空间不能跟着变,所以把 `--composer-h` 的含义说清楚:它是**面板静止部分的高**,不是整个落位带的高。

- Composer 在静止部分的根上标 `data-composer-rest`(它自己知道哪一块是静止的)。
- `content/kinds/session.tsx` 的 `useComposerGeometry` 改为:`--composer-h = dock 的下边缘 − [data-composer-rest] 的上边缘`,量的是「从静止部分顶端到窗底」。找不到这个标记时退回今天的 `dock.height`。观察者多观察一个 `rest` 元素(输入区长高时它会变)。
- 抽屉开合只改变 `rest` 上方的东西,这个差值不变,`--composer-h` 零变化。面板本来就是贴底的绝对定位浮层,往上长就是盖住正文,不推正文——与 09-12 的行为一致。

### 3.2 出现方式:照旧即显

保持 09-12 用户定的「直接看到固定长度、固定宽度的最终结果」:抽屉区没有高度过渡,开的那一帧就是最终高度;抽屉内容照旧 80ms 淡入,关是立即的。`@` / `/` 固定高、模型和状态按内容定高、上限夹 `--center-h` 的规则全部不变。

### 3.3 底:整块一起换

抽屉里的清单要读,不能叠在磨砂玻璃后面的正文上,所以抽屉开着时底仍然要是实底。裁定:**整块面板一起**从玻璃换成实底,关掉整块一起回玻璃;换底不带过渡,与抽屉出现在同一帧。外形、描边、阴影、焦点环都不变,变的只有材质,而且是整块统一的,不会出现上半截实、下半截玻璃。

### 3.4 焦点环:围住整块

- 面板仍是 `data-focus-ring="text"` 载体。
- 模型抽屉搜索行上那格 `data-focus-ring="text"` 删掉。于是焦点在搜索框里时,全局规则 `[data-focus-ring='text']:has(input:focus)` 命中的是 `.panel`,环围住包括抽屉在内的整块。
- `@` / `/` 抽屉打开时焦点本来就在输入区,环照旧在 `.panel` 上,现在它的范围包含抽屉。
- ask 形态「其他」那一行的内层载体不在抽屉里,不动。

### 3.5 面板外的两个浮物

读数卡和附件摞挂在 `.anchor` 上沿之外(`bottom: calc(100% + …)`)。`.anchor` 的高现在包含抽屉,所以抽屉开着时它们浮在整块面板的上方,不会压在清单上。

## 4. 三张状态表

### 4.1 抽屉状态 × 面板外观

| 抽屉 | 面板高 | 圆角 / 描边 / 阴影 | 底 | 内分隔线 | `--composer-h` |
| --- | --- | --- | --- | --- | --- |
| 关 | 静止高 | 常态 | 玻璃 | 无 | 静止高 |
| `@` / `/` | 静止高 + 固定抽屉高 | 常态(不变) | 实底 | 有 | 静止高(不变) |
| 模型 | 静止高 + 内容高(列表封顶) | 常态(不变) | 实底 | 有 | 静止高(不变) |
| 执行状态 | 静止高 + 内容高 | 常态(不变) | 实底 | 有 | 静止高(不变) |
| 任意 + 拖入文件 | 同上 | 整块虚线强调边 | 拖放底 | 有 | 不变 |

### 4.2 焦点位置 × 环

| 焦点在 | 环画在 | 环的形状 |
| --- | --- | --- |
| 输入区(抽屉关) | `.panel` | 静止高的圆角矩形 |
| 输入区(`@` / `/` 抽屉开) | `.panel` | 含抽屉的圆角矩形 |
| 模型搜索框 | `.panel` | 含抽屉的圆角矩形 |
| 模型列表行 / 思考阶梯单选 | 各自控件的环(非文本载体) | 控件自身 |
| ask「其他」行 | 那一行(里层赢,不变) | 行自身 |
| 焦点不在 composer 内 | 无 | — |

### 4.3 抽屉开合 × 周边

| 事件 | 输入区 / 工具行位置 | 消息流 `scrollTop` / 末条消息位置 | 读数卡、附件摞 |
| --- | --- | --- | --- |
| 打开(贴底跟随中) | 不动 | 不动 | 移到整块上方 |
| 打开(上翻浏览中) | 不动 | 不动 | 移到整块上方 |
| 抽屉内容由 loading 变 ready | 不动 | 不动 | 不动 |
| 关闭 | 不动 | 不动 | 回到静止部分上方 |

## 5. 组件树(改后)

```
.wrap
└─ .anchor
   ├─ MeterCard(浮在 .anchor 上方)
   ├─ AttachmentStack(浮在 .anchor 上方)
   └─ .panel  data-focus-ring="text"  ← FocusScope 根、useFloatDismiss 的「里面」,不变
      ├─ .drawer(流内;开着才占高;下边线 = 内分隔线)
      │  └─ .drawerBody → DrawerPickList | DrawerModelPicker | DrawerStatus
      └─ .rest  data-composer-rest
         ├─ StatusBar
         └─ .bodyRow(write / ask)
```

DOM 顺序从「状态条 → 抽屉 → 本体行」改为「抽屉 → 状态条 → 本体行」,并用 `.rest` 把后两者包起来。抽屉和 FocusScope 根、点外关的判据的父子关系不变,那两处一行都不用改。

## 6. 陌生能力演练

「输入框上方再加一种抽屉住户,比如 Agent 选择」:写它自己的组件,在抽屉槽里登记一行。外框、底、焦点环、几何这四件事由 `.panel` / `.drawer` / `data-composer-rest` 统一负责,**不认识任何住户**,零改动。

## 7. 改动清单

- `composer/components/Composer.tsx`:抽屉挪到 `.panel` 第一个子元素;状态条与本体行包进 `<div className={s.rest} data-composer-rest>`。
- `composer/components/Composer.module.css`:
  - `.drawer` 去掉 `position / inset / bottom / border / border-radius / background / box-shadow`,改为流内块;关着时 `display: none`(不占高),开着时显示并带 80ms 内容淡入;下边线用 `--line-1` 画内分隔线。
  - `.panel:has(.drawerOpen)` 只留换实底、撤磨砂两句,且不带过渡;删掉 `overflow: visible`、改圆角、改描边三句。
  - `.drawerFixed` / `.pickScroll` 的高度规则不变。
  - 文件内相关判词改写(09-12 那段「浮在面板上方」的推导改成本文的结论,并指向本文)。
- `composer/components/DrawerModelPicker.tsx`:搜索行去掉 `data-focus-ring="text"`。
- `content/kinds/session.tsx`:`useComposerGeometry` 按 §3.1 改量法,多观察 `[data-composer-rest]`。
- 测试:
  - `composer/components/composer-css.test.ts`、`content/__tests__/floating-composer-css.test.ts` 中断言抽屉绝对定位 / 面板改圆角的用例改为本文的形。
  - `session.tsx` 几何:抽屉开合前后 `--composer-h` 不变的单测。
- 门 `scripts/gate-composer-drawer.mjs`:(a)(b)(c)(d)(e) 不变;(f)「接缝是一条线」换成**一体**四问:抽屉的矩形完全在 `.panel` 的矩形内;开抽屉前后 `.panel` 的四个圆角值相同;焦点在输入区和在模型搜索框时,`outline` 都画在 `.panel` 上且 `.panel` 高度包含抽屉;抽屉开合前后输入区的 `getBoundingClientRect()` 相同。窄 360 / 宽 900 各跑一遍。
- 跑:壳 `typecheck` / `lint` / `vitest`;`ui:consume`、`squeeze-gate`、`motion-gate`;真机门 `gate:composer-drawer`、`gate:composer-leaf`、`gate:chat-follow`、`gate:a11y`、`gate:focus`、`gate:squeeze`。

## 8. 用户可感知的变化

1. 模型、`@` 文件、`/` 命令、执行状态四种抽屉打开时,和输入面板是同一个外框,上沿保持圆角。
2. 焦点环围住整块,包括抽屉;焦点在模型搜索框时也是整块亮,搜索框自己不再单独亮。
3. 抽屉和输入区之间是一条内分隔线,不是两块面板的接缝。
4. 抽屉开着时读数卡和附件摞浮在整块上方。
5. 不变的:抽屉即显、固定高、不推正文、输入区位置不动、点外面只关模型抽屉。

## 9. 施工记录(2026-09-16,主检出本地施工,未提交)

- 改动文件:`composer/components/Composer.tsx`、`Composer.module.css`、`DrawerModelPicker.tsx`、`content/kinds/session.tsx`、`composer/components/composer-css.test.ts`、`content/__tests__/floating-composer-css.test.ts`、`scripts/gate-composer-drawer.mjs`(另加 `900-model` 截图一格)。
- 静态:`vitest`(composer + content/kinds + floating-composer-css,243 条)绿;`tsc` 绿;`eslint` 改动文件零违例;`ui:consume` 31 条在基线内、两条零基线硬闸 0;`motion-gate` / `squeeze-gate` 在基线内。
- 真机 `gate:composer-drawer` 全绿(窄 360 / 宽 900):抽屉首帧即 320px 最终高、首帧 5–6.9ms;开抽屉前后 `scrollTop` / 末条上缘 / `--composer-h`(101px)零变化,贴底与上翻各一遍;(f) 模型抽屉矩形在面板内、面板四角 14px 与 1px 边开合前后不变、输入区矩形 `431,725,438,24` 不变、焦点在搜索框时面板环亮而搜索行不亮。
- 留账:`gate:composer-leaf` / `gate:chat-follow` / `gate:a11y` / `gate:focus` / `gate:squeeze` 本次未跑;执行状态抽屉没有真机场景(闲会话里状态条不出现)。
