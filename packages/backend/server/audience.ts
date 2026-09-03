/**
 * **受众** —— 一条订阅能看哪些会话(批 A,`docs/design/event-subscription-audience-2026-09.md` §3.1)。
 *
 * 从前每推一条流式分片,过滤代码都要重新回答一次「这条连接能不能看这条会话」,
 * 而回答的方法是把整条会话重新组装一遍(`getSession` → `listMessages` 全量物化,
 * 大会话实测 69ms/次)。这里把那个问题从「每条分片」挪回它本来的节拍:**权限是
 * 订阅建立那一刻就定下的事实**,由一个随订阅生命周期自维护的对象记着,失效口是
 * 会话索引的写点。
 *
 * 两件事因此成立:
 *  1. `covers` 是 O(1)、零 I/O、零解析 —— 连接建立之后这条管线上没有一步读盘;
 *  2. **过滤代码不知道自己跑在哪** —— 宿主由装配层选一个实现注进来。新增一种宿主
 *     = 这里多一个类 + 装配层一行注册,订阅代码一个字不改(§5 陌生能力演练)。
 */
import type { RuntimeRequestContext } from "@onething/core";

/** 一条会话的租户归属(两格都可能缺席 —— 缺席 = 无主)。 */
export interface SessionOwner {
	userId?: string;
	workspaceId?: string;
}

/**
 * 归属取材的最小形状。会话对象(`ServerChatSession`)与索引元数据
 * (`ServerSessionIndexMeta`)都结构性满足它 —— 于是「按会话判」与「按索引元数据判」
 * 用的是**同一个谓词**,不是两份各算一遍的规则。
 */
export interface SessionOwnershipRecord {
	/** @deprecated 存量租户 userId(只读兼容)。 */
	userId?: string;
	ownerUserId?: string;
	ownerWorkspaceId?: string;
}

/**
 * 读一条会话/元数据的**租户归属**。
 *
 * 存量兼容只认 `userId` 那一格:老盘上的 `workspaceId` 存的是**产品空间**,把它读成
 * 租户正是要修的那个 bug,所以这里**故意不回落**到它。
 */
export function sessionOwnerOf(record: SessionOwnershipRecord): SessionOwner {
	return {
		userId: record.ownerUserId ?? record.userId,
		workspaceId: record.ownerWorkspaceId,
	};
}

/**
 * 归属判定:**两格都空 = 无主,谁都读得到**(单用户服务端的常态);有值的那格才比。
 * 缺席的一格不参与比较 —— 老会话只盖过 `userId` 的那种,不该因为「没有租户作用域」
 * 就对所有人隐身。
 */
export function ownerMatchesContext(
	owner: SessionOwner,
	context: RuntimeRequestContext,
): boolean {
	if (!owner.userId && !owner.workspaceId) return true;
	return (
		(owner.userId ?? context.userId) === context.userId &&
		(owner.workspaceId ?? context.workspaceId) === context.workspaceId
	);
}

/** 一步到位的归属判定 —— `ownsSession` / `ownsSessionMeta` 共用的那一句。 */
export function ownsSessionRecord(
	record: SessionOwnershipRecord,
	context: RuntimeRequestContext,
): boolean {
	return ownerMatchesContext(sessionOwnerOf(record), context);
}

/** 一条订阅的受众。 */
export interface SessionAudience {
	/** O(1),零 I/O,零解析。 */
	covers(sessionId: string): boolean;
	/** 订阅关闭时调用;把自己挂在生命周期总线上的监听退掉。 */
	dispose(): void;
}

/** 装配层注入的那一格:请求上下文 → 这条订阅的受众。 */
export type SessionAudienceFactory = (
	context: RuntimeRequestContext,
) => SessionAudience;

/**
 * 恒真。**单用户宿主**用它(自装 core 的桌面壳、CLI daemon):那里只有一个人,
 * 会话两格归属本来就都是空的,归属判定恒回 true —— 这个实现只是把那条隐含规则
 * 说出口,顺带把「问一次」也省了。
 */
export class OpenAudience implements SessionAudience {
	covers(_sessionId: string): boolean {
		return true;
	}

	dispose(): void {
		/* 没挂过监听,没什么可退的。 */
	}
}

/**
 * 受众的真相源:**会话索引**。
 *
 * 为什么不是事件总线(初稿如此,09-03 审查改的):`session-event-types.ts` 的 55 条
 * 里只有 `session:removed`,**没有** created、没有归属变更 —— 靠总线维护集合会陈旧。
 * 索引写点则天然覆盖创建 / 删除 / 改归属三种情况(它们都要写索引)。
 */
export interface SessionIndexPort {
	/** 按 id 取一条索引元数据;查无此条 = `undefined`。 */
	findMeta(sessionId: string): SessionOwnershipRecord | undefined;
	/**
	 * 索引写点的通知口;回的是退订函数。
	 *
	 * **契约**:`sessionId` 是被改的那一条;**`undefined` = 整份索引换掉了**
	 * (`saveSessionsIndex` 那一口),听者必须把整本备忘作废,而不是去删一个
	 * 叫 `undefined` 的键。空串不是哨兵值 —— 它是一个合法但不存在的 id。
	 */
	onChanged(listener: (sessionId: string | undefined) => void): () => void;
}

/**
 * 按会话归属判的受众:`covers` 先查自己的备忘;没记过就从**会话索引**判一次并记下。
 *
 * 备忘只在索引写点被通知时删那一格 —— 创建 / 删除 / 改归属都要写索引,所以三种
 * 情况都覆盖得到;整份索引被换掉时(通知带 `undefined`)整本作废。
 * 查无索引条目 = 不覆盖(与今天「取不到会话就丢事件」逐字相同)。
 */
export class TenantAudience implements SessionAudience {
	private readonly memo = new Map<string, boolean>();
	private readonly index: SessionIndexPort;
	private readonly context: RuntimeRequestContext;
	private off: (() => void) | undefined;

	constructor(index: SessionIndexPort, context: RuntimeRequestContext) {
		this.index = index;
		this.context = context;
		this.off = index.onChanged((sessionId) => {
			// `undefined` = 整份索引换掉了(见 `SessionIndexPort.onChanged` 的契约):
			// 每一条的归属都可能变过,按 id 删只会删掉一格,所以整本作废。
			if (sessionId === undefined) this.memo.clear();
			else this.memo.delete(sessionId);
		});
	}

	covers(sessionId: string): boolean {
		const remembered = this.memo.get(sessionId);
		if (remembered !== undefined) return remembered;
		const meta = this.index.findMeta(sessionId);
		const covered = meta ? ownsSessionRecord(meta, this.context) : false;
		this.memo.set(sessionId, covered);
		return covered;
	}

	dispose(): void {
		this.off?.();
		this.off = undefined;
		this.memo.clear();
	}
}

/** 单用户宿主的工厂。 */
export function createOpenAudienceFactory(): SessionAudienceFactory {
	return () => new OpenAudience();
}

/** 按归属判的工厂 —— 缺省档,与批 A 之前的行为逐字相同。 */
export function createTenantAudienceFactory(
	index: SessionIndexPort,
): SessionAudienceFactory {
	return (context) => new TenantAudience(index, context);
}
