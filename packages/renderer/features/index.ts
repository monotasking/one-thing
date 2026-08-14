/**
 * renderer 侧的 feature 名册（C2，`docs/design/cordis-adoption-2026-08.md` §2）。
 *
 * **这份文件的全部内容就是一列 import**，一行一个 feature。它是数据形状的，
 * 不是逻辑：加一个 feature = 加一行；顺序 = 注册顺序 = 面板呈现顺序。
 * 对齐 C5 的收口方向（"feature 名册 = 一个显式数组"），后端那半的
 * `BUILTIN_FEATURES` 是同一件事的另一种写法。
 *
 * ── 为什么需要它（K1 留下的第一个真问题）─────────────────────────────
 *
 * renderer 没有装配序列，feature 模块必须被某处静态 import 才会求值。三个
 * 候选被逐个否掉：
 *  - **panel-registry 自己 import 各 feature**：注册表反过来依赖注册者，
 *    等于把"清单"重新写死进注册表 —— 那正是 K1 拆掉的东西；
 *  - **各消费方（App / Sidebar / 工作台）各 import 各的**：又一份手抄清单，
 *    漏一处的症状是"某个面板在某个入口不见了"，正是注册表要根治的失效模式；
 *  - **`import.meta.glob` 自动收集**：目录即名册看似更省，但它把"有哪些
 *    feature"变成打包器的运行期发现 —— 想知道装了什么只能跑一遍，
 *    并且删一个文件就静默少一件功能。名册要的恰恰是可读、可 diff。
 *
 * 剩下的就是这份显式名册，由**启动入口** `main.ts` import 一次。
 *
 * **测试要自己 import 它**：`main.ts` 不参与单测，所以任何断言"某个 feature
 * 的面板在场"的用例（panel-registry / Sidebar 工作区菜单 / App 容器布局）
 * 都要在文件头补一行 `import '@/features'` —— 这是"renderer 没有装配序列"
 * 的账单，如实记在差距清单 §6。
 */
import './trajectory'

export {}
