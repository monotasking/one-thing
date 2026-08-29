import { useEffect, useState } from 'react'

/**
 * 「真的等久了才承认在等」—— 载入骨架的防闪闸。
 *
 * flag 为真且持续超过 delay 才回真;flag 一落假立刻回假。
 * 判据放在一个 hook 里而不是各组件各写一个 setTimeout,是因为「多久算久」
 * 是一条**规范**(SKELETON_DELAY_MS),不是每处自己拍的数。
 */
export function useDelayedFlag(flag: boolean, delay: number): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!flag) {
      setOn(false)
      return
    }
    const timer = setTimeout(() => setOn(true), delay)
    return () => clearTimeout(timer)
  }, [flag, delay])
  return on
}
