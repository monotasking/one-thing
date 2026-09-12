/**
 * terminal 域的装配接线。今天只有一件:输出广播器(T0)。
 *
 * 服务本身、七条 RPC 的请求面与流控都在产品层
 * (`@onething/runtime/terminal/service.wiring`)—— 这里只放「非产品层能知道的
 * 那一半」,也就是认识 `EventBus` 的那一件。
 */

export { createEventBusTerminalBroadcaster } from './bus-broadcaster.js'
