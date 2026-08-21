import { RingBuffer as CoreRingBuffer } from '@onething/core/events'
import type { SessionBusMessage } from '@shared/events/index.js'

/**
 * 缓冲的是**总线载荷**,不是纯事件:命令与事件走同一条 `emit()`,提交阶段一视
 * 同仁地拿序号进缓冲,`?after=` 重放因此照样吐得出命令(见 `SessionBusMessage`)。
 */
export class RingBuffer extends CoreRingBuffer<SessionBusMessage> {}
