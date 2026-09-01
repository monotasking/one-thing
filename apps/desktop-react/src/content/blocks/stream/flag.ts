/**
 * **R4a 开关**:块流内核(新路)还是每帧一份块列表(旧路)。
 *
 * 默认开。旧路保留到 R4a 真机浸泡结束 —— 开关一翻即回,回滚不需要改代码
 * (与 R2 的 `onething.streamR2` 同款,那一批的回滚口证明过这条口是真能回的)。
 *
 * 读一次存起来:它是「这一台跑哪条路」的档位,不是每帧要问的问题。
 *
 * ── 学费判例(R2 批交的,门里必须照抄)────────────────────────────────
 * `ONETHING_STORE_PATH` 换的是账本,**换不掉 Electron 的 userData** —— localStorage
 * 活在那儿,跨门跑存活。跑过一次 `off` 之后,后面每一次都在旧路上跑而门自己浑然
 * 不觉。所以门里不是「要关才写」,是**每次都显式写一遍档位并打印**。
 */
export const BLOCK_STREAM = readBlockStreamFlag()

function readBlockStreamFlag(): boolean {
  try {
    return globalThis.localStorage?.getItem('onething.blockStream') !== 'off'
  } catch {
    return true
  }
}
