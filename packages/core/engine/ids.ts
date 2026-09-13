/**
 * id 生成走 Web Crypto(`globalThis.crypto`)而不是 `node:crypto`。
 *
 * 不是风格偏好:core/actors 的纯层(envelope/lease)经 `@onething/runtime/collab/actors`
 * 被 renderer 引用,顶层 `import 'node:crypto'` 会被 vite 外部化成「访问即抛错」的
 * 占位 —— 真机首启当场炸在 ids.ts:1(2026-08-03)。Web Crypto 在浏览器/Node≥19/bun/
 * Electron 全平台原生,产物同样是 UUID v4,消费者零差异。
 */
export function createCoreId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * 一个**客户端预铸**的消息 id 认不认(`SendMessageCommand.messageId`)。
 *
 * 只判**形**,不判来历:形与 `createCoreId()` 的产物同族(UUID v4 是 36 个
 * `[0-9a-f-]`,落在这条里),再宽一点收下别的壳惯用的 id 工具(`nanoid`、
 * `crypto.randomUUID` 去掉横杠的写法)。上限 64 是因为这个字符串会进账本的
 * 每一行、进 DOM 的 `data-message-id`、进事件的 `messageId` —— 它是一个**地址**,
 * 不是一格自由文本;下限 8 挡的是 `'1'` 这种一按就撞的东西。
 *
 * 判**形**够不够:不够,所以调用点还要再判一次**会话内唯一**(形对了但撞上
 * 已有消息的,一样不认)。两道判分开写是因为它们说的是两件事:这一句说
 * 「这像不像一个 id」,那一句说「这个位置有没有人」。
 */
const CLIENT_MINTED_ID = /^[0-9a-zA-Z_-]{8,64}$/

export function isClientMintedId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_MINTED_ID.test(value)
}
