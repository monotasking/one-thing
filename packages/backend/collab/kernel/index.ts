/**
 * Actor 内核(`@onething/backend/collab/kernel`)—— Collab v3 的骨架层。
 *
 * 这一层只有四件东西:信封、邮箱、租约、循环。它不认识房间、不认识 agent、
 * 更不认识狼人杀 —— 产品语境全在 `@onething/backend/collab/actors`。
 * 设计见 docs/design/collab-actor-v3.md §1-§3。
 */
export {
  ACTOR_EVENT_ID_PREFIX,
  DEFAULT_SEEN_ACTOR_EVENT_WINDOW,
  actorRefEquals,
  createActorEvent,
  createActorEventId,
  createSeenActorEventWindow,
  formatActorRef,
  parseActorRef,
} from './envelope.js'
export type {
  ActorEvent,
  ActorRef,
  CreateActorEventOptions,
  SeenActorEventWindow,
} from './envelope.js'

export {
  ACTOR_MAILBOX_CURSOR_VERSION,
  DEFAULT_ACTOR_MAILBOX_NAME,
  DurableMailbox,
  InMemoryMailbox,
  decodeActorMailboxLine,
  readActorMailboxLog,
} from './mailbox.js'
export type {
  ActorMailboxBatch,
  ActorMailboxCursorRecord,
  ActorMailboxSource,
  DurableMailboxOptions,
} from './mailbox.js'

export {
  FLOOR_LEASE_INITIAL_EPOCH,
  FLOOR_LEASE_REVOKED_HISTORY,
  activeFloorLeases,
  bumpFloorEpoch,
  canIssueFloorLease,
  createFloorLeaseLedger,
  floorLeaseExpiresAt,
  isFloorLeaseExpired,
  issueFloorLease,
  pruneFloorLeases,
  revokeFloorLease,
  validateFloorLease,
  validateFloorLeaseId,
} from './lease.js'
export type {
  FloorLease,
  FloorLeaseCheck,
  FloorLeaseInvalidReason,
  FloorLeaseLedger,
  IssueFloorLeaseRequest,
  IssueFloorLeaseResult,
} from './lease.js'

export {
  ActorBase,
  CallbackActor,
  DEFAULT_ACTOR_DEAD_LETTER_CAPACITY,
} from './actor.js'
export type {
  ActorBaseOptions,
  ActorDeadLetter,
} from './actor.js'
