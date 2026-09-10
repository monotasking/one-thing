import { Brain, Image, ImagePlus, Mic, Paperclip, Wrench } from '../../components/icons'
import type { LucideIcon } from '../../components/icons'
import type { MessageKey } from '../../i18n'
import type { ModelCap } from '../types'

/**
 * 六枚能力的**图标与名字**,一张表两处读(09-10 出文件)。
 *
 * 从前它只长在 `ModelCatalogRow.tsx` 里,因为只有目录行那一串图标要用。
 * 覆盖浮层开出「能力」五行之后就有了第二个读者 —— 而这两处说的必须是**同一枚
 * 图标、同一个名字**:行上画一把扳手、浮层里那一行却叫别的名字,用户就得自己
 * 在两套语汇之间做映射,而这正是 08-31「V T R 谁都读不懂」那次报障的同一个病根。
 * 所以不是「抄一份过去」,是出文件成为单产地。
 *
 * **字母缩写已退役**:名字给读屏的人(`aria-label`)与用眼睛的人(`Tooltip` /
 * 浮层里那一行的可见文字)是同一句,两路同源。
 */
export const CAP_ICONS: Record<ModelCap, LucideIcon> = {
  vision: Image,
  tools: Wrench,
  reasoning: Brain,
  imageOut: ImagePlus,
  /*
   * 文件输入用回形针而不是一张纸(`FileText`):这一格说的是**能不能把附件递给
   * 它**,而输入框那颗「加附件」钮用的正是回形针 —— 同一件事在两处得是同一个形。
   */
  fileIn: Paperclip,
  audioIn: Mic,
}

export const CAP_LABELS: Record<ModelCap, MessageKey> = {
  vision: 'providers.capVision',
  tools: 'providers.capTools',
  reasoning: 'providers.capReasoning',
  imageOut: 'providers.capImageOut',
  fileIn: 'providers.capFileIn',
  audioIn: 'providers.capAudioIn',
}
