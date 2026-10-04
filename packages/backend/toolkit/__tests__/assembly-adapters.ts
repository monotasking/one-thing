/**
 * 测试夹具:`backend.ts` 造工具目录时递进来的那三只适配器(D191 之后 goal / practice / task 的适配器住在
 * 各自功能里,目录自己造不出它们)。goal 与 practice 用生产同一套工厂(经各自入口);task 的真工厂
 * 不经 task 入口交出(只许装配处深层引它),这些测试只数目录里有哪些工具、从不派工,所以给一只调了就报错的端口。
 */
import { goalToolAdapters } from '@onething/backend/goal'
import { practiceToolAdapters } from '@onething/backend/practice'
import type { TaskToolPorts } from '@onething/backend/toolkit'

const taskPortNotWired: TaskToolPorts = {
  dispatch: () => { throw new Error('task dispatch is not wired in this test') },
}

export function assemblyToolAdapters() {
  return { goal: goalToolAdapters(), practice: practiceToolAdapters(), task: taskPortNotWired }
}
