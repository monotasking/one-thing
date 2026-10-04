/**
 * usage —— 用量账本:每一次调模型花了多少 token、多少钱,按天落进 JSONL 账本,并按日 / 周 / 月汇总。
 *
 * 对外交出三类东西:
 * - 记账:进程级账本单槽(装上、取)、记一条用量、按会话归属、测试用的记账捕获;
 * - 主对话之外那些「顺路的小调用」(起标题、压缩、目录、技能复盘、宠物、协作计划)各自的记账函数;
 * - 账本类与记录、单价、计费方式的形状,以及用量来源的列表。
 * 依赖 provider、credentials(计价与订阅额度)、space、settings、session、logging。
 */

// 记账。
export {
  captureUsageRecorder,
  configureUsageLedger,
  getUsageLedger,
  recordUsage,
  usageAttributionOf,
} from './usage-recorder.js'

// 顺路小调用的记账。
export {
  billCollabPlanUsage,
  billCompactUsage,
  billPetUsage,
  billSkillUsage,
  billTitleUsage,
  billTocUsage,
} from './usage-bill-side-line.js'
export type { SideLineUsage } from './usage-bill-side-line.js'

// 账本与形状。
export { OnethingUsageLedger } from './usage-ledger.js'
export { ONETHING_USAGE_SOURCES } from './usage-types.js'
export type {
  OnethingUsageBillingMode,
  OnethingUsageLedgerRecord,
  OnethingUsageRecordInput,
  OnethingUsageUnitPrice,
} from './usage-types.js'
