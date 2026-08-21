/**
 * v3 房间账的落盘面(docs/design/collab-actor-v3.md §3「账」)。
 *
 * **绝不与 v2 抢写同一个文件**。v2 的 `collab/<roomId>/state.json` 归 coordinator,
 * 它到 D6 才删;这一份落在 `collab/<roomId>/actors/room.json`。两份账在同一段时间
 * 里都是活的(v2 跑生产,v3 跑测试与重放),共用一个文件名的代价是**两个进程内
 * 的写者互相覆盖对方的字段** —— 那种事故只在真机上现身,而且长得像"设置没保存"。
 *
 * 写法沿用同一条纪律:`writeJsonFile` = `writeFileSync` + `renameSync`,同步、
 * 原子、不排队、不节流。账必须在下一步动作之前就在盘上 —— 一次 `kill` 不该在
 * 「决定发牌」和「记下发过牌」之间开出一个窗口。转录那侧是异步节流写,所以账
 * 永远跑在转录**前面**,不会落在后面(v2 W23 已经在真机上验过这个次序)。
 *
 * `actors/` 这个子目录是给 D2 留的:agent 的 mailbox 与经历流会挨着它落,
 * 一间房的 v3 家当因此都在一个文件夹里,删房那条既有路径(`removeCollabRoomDirectory`
 * 递归删 `collab/<roomId>`)一行都不用改就把它们一起带走。
 */
import path from 'node:path'

import { readJsonFile, writeJsonFile } from '@onething/core/storage'
import {
  createCollabRoomAccount,
  normalizeCollabRoomAccount,
  type CollabRoomAccount,
} from '@onething/runtime/collab/actors'

import {
  getOnethingStorePath,
} from '@onething/runtime/storage'
/** v3 的一切都落在房间目录的这个子目录下。 */
export const COLLAB_ACTORS_DIR = 'actors'
/** 房间账文件名。 */
export const COLLAB_ROOM_ACCOUNT_FILE = 'room.json'

/** `<store>/collab/<roomId>/actors/`。 */
export function collabRoomActorsDir(roomId: string): string {
  return path.join(getOnethingStorePath(), 'collab', roomId, COLLAB_ACTORS_DIR)
}

/** `<store>/collab/<roomId>/actors/room.json`。 */
export function collabRoomAccountPath(roomId: string): string {
  return path.join(collabRoomActorsDir(roomId), COLLAB_ROOM_ACCOUNT_FILE)
}

/**
 * 账的存取面。
 *
 * 之所以是接口而不是直接调 fs:金重放要在**没有磁盘**的前提下跑同一个 RoomActor
 * ——「重放与真机走同一条代码」这条承诺,如果落盘是硬编码的就只能兑现一半。
 */
export interface CollabRoomAccountStore {
  load(roomId: string): CollabRoomAccount
  save(account: CollabRoomAccount): void
}

/** 真机的那一个:同步原子写。 */
export function createCollabRoomAccountFileStore(): CollabRoomAccountStore {
  return {
    load(roomId: string): CollabRoomAccount {
      const raw = readJsonFile<unknown>(collabRoomAccountPath(roomId), null)
      // 认不出形状就当新账(`normalizeCollabRoomAccount` 的既定行为):半份账会在
      // 第一次发牌时炸在离成因很远的地方。
      return raw === null ? createCollabRoomAccount(roomId) : normalizeCollabRoomAccount(raw, roomId)
    },
    save(account: CollabRoomAccount): void {
      writeJsonFile(collabRoomAccountPath(account.roomId), account)
    },
  }
}

/** 测试与重放的那一个。语义相同,只是重启之后一切归零。 */
export function createCollabRoomAccountMemoryStore(
  seed: Iterable<CollabRoomAccount> = [],
): CollabRoomAccountStore {
  const accounts = new Map<string, CollabRoomAccount>()
  for (const account of seed) accounts.set(account.roomId, account)
  return {
    load(roomId: string): CollabRoomAccount {
      return accounts.get(roomId) ?? createCollabRoomAccount(roomId)
    },
    save(account: CollabRoomAccount): void {
      // 深拷贝一次:调用方拿走的是账的引用,不拷的话"落盘"与"内存态"是同一个
      // 对象,任何一处就地改写都会让"重新 load 一次"这件事失去意义 —— 而崩溃
      // 恢复测试问的恰恰是这个。
      accounts.set(account.roomId, JSON.parse(JSON.stringify(account)) as CollabRoomAccount)
    },
  }
}
