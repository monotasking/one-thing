/**
 * 命令过桥时 mentions 的拍平(`withPlainCommandMentions`)。
 *
 * 守的命题:拍平只负责「变成普通对象」,**不负责挑字段**。逐字段白名单曾把
 * W14a 之后加的 `kind`/`userHandle` 悄悄剥掉,于是 `@用户` 只在桌面这条通道上
 * 失效(web 走 HTTP 原样透传),而两端跑的是同一份渲染层代码 —— 按传输方式
 * 分叉的 bug 没有任何一个前端测试看得见,只能钉在过桥这一刻。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc.js";
import type { SessionCommand } from "@shared/events/index.js";

const mocks = vi.hoisted(() => ({
	exposed: new Map<string, Record<string, unknown>>(),
	invoke: vi.fn(async (_channel: string, _payload: unknown) => ({
		success: true,
	})),
}));

vi.mock("electron", () => ({
	contextBridge: {
		exposeInMainWorld: (key: string, api: Record<string, unknown>) => {
			mocks.exposed.set(key, api);
		},
	},
	ipcRenderer: {
		invoke: mocks.invoke,
		on: vi.fn(),
		removeListener: vi.fn(),
		send: vi.fn(),
	},
	nativeImage: { createFromDataURL: vi.fn() },
	webUtils: { getPathForFile: vi.fn() },
}));

async function emit(command: SessionCommand): Promise<SessionCommand> {
	const { installOnethingPreloadBridge } = await import("../bridge.js");
	installOnethingPreloadBridge();
	const api = mocks.exposed.get("electronAPI") as {
		emitCommand: (sessionId: string, command: SessionCommand) => Promise<unknown>;
	};
	await api.emitCommand("s1", command);
	const [channel, payload] = mocks.invoke.mock.calls.at(-1) as [
		string,
		{ sessionId: string; command: SessionCommand },
	];
	expect(channel).toBe(IPC_CHANNELS.SESSION_COMMAND);
	return payload.command;
}

describe("withPlainCommandMentions", () => {
	beforeEach(() => {
		mocks.invoke.mockClear();
	});

	it("kind / userHandle 过得了桥", async () => {
		const command = await emit({
			type: "command:send-message",
			content: "@songyitian 你说了算",
			mentions: [
				{ kind: "user", agentId: "", label: "songyitian", userHandle: "3f9c1e2a" },
			],
		});
		expect((command as { mentions: unknown[] }).mentions).toEqual([
			{ kind: "user", agentId: "", label: "songyitian", userHandle: "3f9c1e2a" },
		]);
	});

	it("缺省的 kind 不被物化 —— 老转录里没有这个键,拍平不该凭空造一批", async () => {
		const command = await emit({
			type: "command:send-message",
			content: "@小李 看一下",
			mentions: [{ agentId: "fe", label: "小李" }],
		});
		const [mention] = (command as unknown as { mentions: Record<string, unknown>[] }).mentions;
		expect(mention).toEqual({ agentId: "fe", label: "小李" });
		expect("kind" in mention).toBe(false);
		expect("userHandle" in mention).toBe(false);
	});

	it("句柄缺席的用户 mention 不长出一个空 userHandle", async () => {
		const command = await emit({
			type: "command:send-message",
			content: "@我 看下",
			mentions: [{ kind: "user", agentId: "", label: "songyitian" }],
		});
		const [mention] = (command as unknown as { mentions: Record<string, unknown>[] }).mentions;
		expect(mention).toEqual({ kind: "user", agentId: "", label: "songyitian" });
		expect("userHandle" in mention).toBe(false);
	});

	it("拍平出来的是可 structuredClone 的普通对象(这个函数存在的理由)", async () => {
		const reactive = new Proxy(
			{ agentId: "fe", label: "小李" },
			{ get: (target, prop) => Reflect.get(target, prop) },
		);
		const command = await emit({
			type: "command:send-message",
			content: "@小李",
			mentions: [reactive],
		});
		const { mentions } = command as { mentions: unknown[] };
		expect(() => structuredClone(mentions)).not.toThrow();
	});

	it("没有 mentions 的命令原样通过", async () => {
		const command = await emit({
			type: "command:inject-steering",
			content: "换个方向",
			source: "user",
		});
		expect(command).toEqual({
			type: "command:inject-steering",
			content: "换个方向",
			source: "user",
		});
	});
});
