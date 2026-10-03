/**
 * 会话授权的**动词表**(工单 5 §6,triage C1)。
 *
 * 它从 `packages/backend/session/access.ts` 搬到契约层,理由只有一个:**契约要说得出
 * 这句话**。`defineRouter` 的每个方法从此可以自述「我要拿 payload 的哪一格当会话 id、
 * 对它做哪种操作」,而执法在 `dispatchRpc` 一处 —— 加一个域接授权 = 契约里一格,
 * `registry.ts` 零改动。动词表是纯数据(一串字面量),放在契约层不带来任何反向依赖。
 */
export type SessionAccessOperation =
  | 'read' | 'write' | 'delete' | 'abort' | 'permission' | 'subscribe' | 'draft' | 'draft-read'
