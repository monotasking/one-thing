import { registerToolPresenter } from '../presenter'
import { bashPresenter } from './bash'
import { editPresenter } from './edit'
import { readPresenter } from './read'
import { webPresenter } from './web'

/**
 * presenter 的**唯一注册 barrel**(与块注册表 `blocks/index.ts` 同款纪律)。
 *
 * import 这个模块**就是**「这台上认识哪几个工具」。表是有序的、先注册先认领,
 * 所以这个文件里的顺序是有意义的 —— 今天四个 `match` 互斥(各认各的 toolName),
 * 顺序还看不出来;等哪天有人要按**结果形状**分流(同一个 bash,结构化输出与裸文本
 * 两种展示),那个更窄的 presenter 必须排在宽的前面。
 *
 * 兜底不在这里注册:它不是表里的一格,是 `resolveToolPresenter` 查不到时的归宿
 * (§5.1「兜底是合同的一部分」)。
 */
registerToolPresenter(readPresenter)
registerToolPresenter(editPresenter)
registerToolPresenter(bashPresenter)
registerToolPresenter(webPresenter)
