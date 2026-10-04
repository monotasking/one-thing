/**
 * practice —— 练习(提肛 / 番茄钟 / 运动):计时引擎、按天落盘的账本、汇总,以及包着它们的练习服务。
 *
 * 对外交出两类东西:
 * - 练习服务的单槽:装配时装上(`configurePracticeService`)、别处安全地取(`getPracticeServiceSafe`),
 *   连同服务类本身与「服务已关」的错误;
 * - 练习工具写一条记录时用的入参形状 `OnethingPracticeRecordInput`。
 * 计时引擎、账本与汇总只在功能内部用,不交出。不依赖别的功能。
 */

export {
  configurePracticeService,
  getPracticeServiceSafe,
  PracticeService,
  PracticeServiceClosedError,
} from './practice-service-slot.js'

export type { OnethingPracticeRecordInput } from './practice-types.js'
