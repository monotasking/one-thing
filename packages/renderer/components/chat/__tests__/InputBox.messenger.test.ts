// @vitest-environment happy-dom
/**
 * InputBox 形态分装(docs/design/agent-im-chat-ui.md §2 C1/P1)。
 *
 * 一个输入框两种形态:直聊(kind='chat')是工程驾驶舱,房会话(群房 / 单成员
 * dm 房 / 双成员 dm 房,全是 kind='room')是 IM 场。这里钉三件事:
 *   1. 形态分流本身(三种房 → messenger,直聊 → engineering);
 *   2. messenger 的移除清单逐项(§2.2 右列);
 *   3. 直聊零变化 —— 本期最高验收项,全量控件快照。
 */
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import InputBox from "../InputBox.vue";
import { createDefaultSettings } from "@shared/defaults/settings";
import { executeCommand, findCommand } from "@/services/commands";

const mocks = vi.hoisted(() => ({
	settingsStore: null as any,
	sessionsStore: null as any,
	chatStore: null as any,
	voiceStore: null as any,
	promptsStore: null as any,
	musicStore: null as any,
	agentsStore: null as any,
	/** 房里的"在跑"只由 collab:turn-active 说了算(W18 之后房会话本身没有流)。 */
	roomTurnActive: false,
}));

// 结果提示走全局 ToastHost;这里不需要真的挂 overlay 宿主(它还带深链确认卡,
// 要 Pinia),只要 toasts 队列可断言。
vi.mock("@/services/ui-overlay-host", () => ({
	ensureUiOverlayHost: vi.fn(),
	destroyUiOverlayHost: vi.fn(),
}));

vi.mock("@/stores/settings", () => ({
	useSettingsStore: () => mocks.settingsStore,
}));

vi.mock("@/stores/sessions", () => ({
	useSessionsStore: () => mocks.sessionsStore,
}));

vi.mock("@/stores/chat", () => ({
	useChatStore: () => mocks.chatStore,
}));

vi.mock("@/stores/voice", () => ({
	useVoiceStore: () => mocks.voiceStore,
}));

vi.mock("@/stores/prompts", () => ({
	usePromptsStore: () => mocks.promptsStore,
}));

vi.mock("@/stores/music", () => ({
	useMusicStore: () => mocks.musicStore,
}));

vi.mock("@/stores/agents", () => ({
	useAgentsStore: () => mocks.agentsStore,
}));

// 草稿纸:messenger 形态本来就没有草稿纸(开关钮不渲染),这里给一个只读空壳,把"房面零变化"这条也钉住。
vi.mock("@/stores/scratchpad", () => ({
	useScratchpadStore: () => ({
		getRecord: () => null,
		setContent: vi.fn(),
		load: vi.fn().mockResolvedValue(undefined),
		flushNow: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
		adopt: vi.fn().mockResolvedValue(undefined),
		noteConsumed: vi.fn(),
		consumedOffset: () => null,
		pendingText: () => "",
	}),
}));

vi.mock("@/stores/collabBoard", () => ({
	useCollabBoardStore: () => ({
		isRoomTurnActive: () => mocks.roomTurnActive,
	}),
}));

vi.mock("@/stores/browser", () => ({
	useBrowserStore: () => ({
		tabs: [],
		activeTabId: null,
		activeTab: null,
		ensureLoaded: vi.fn().mockResolvedValue(undefined),
	}),
}));

vi.mock("@/services/commands", () => ({
	findCommand: vi.fn(() => undefined),
	getCommands: vi.fn(() => [
		{
			id: "compact",
			name: "Compact Context",
			description: "Compact context",
			usage: "/compact",
			execute: vi.fn(),
		},
	]),
	refreshPluginCommands: vi.fn().mockResolvedValue([]),
	executeCommand: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/editor/TextEditor.vue", () => ({
	default: {
		name: "TextEditor",
		props: ["modelValue", "placeholder"],
		emits: [
			"update:modelValue",
			"paste",
			"keydown",
			"focus",
			"blur",
			"heightChange",
			"selectionChange",
			"transaction",
			"compositionstart",
			"compositionend",
		],
		template:
			'<textarea class="composer-input" :value="modelValue" :data-placeholder="placeholder" @input="onInput" @keydown="$emit(\'keydown\', $event)" />',
		methods: {
			onInput(this: any, event: Event) {
				this.$emit(
					"update:modelValue",
					(event.target as HTMLTextAreaElement).value,
				);
			},
			focus() {},
			scrollToTop() {},
			getSelection(this: any) {
				const length = String(this.modelValue ?? "").length;
				return { from: length, to: length };
			},
			replaceRange() {},
			setValue(this: any, value: string) {
				this.$emit("update:modelValue", value);
			},
		},
	},
}));

/** 弹层桩:只有 visible 才落 DOM,标题带出来区分 files/pages/members 三份。 */
const pickerStub = (marker: string) => ({
	props: ["visible", "title"],
	template: `<div v-if="visible" class="${marker}" :data-title="title" />`,
});

async function settle() {
	await nextTick();
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await nextTick();
}

function dispatchKeydown(element: Element, key: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});
	element.dispatchEvent(event);
	return event;
}

function mountInputBox(sessionId: string, extraProps: Record<string, unknown> = {}) {
	return mount(InputBox, {
		attachTo: document.body,
		props: { sessionId, ...extraProps },
		global: {
			stubs: {
				QuotedContext: { template: "<div />" },
				CommandPicker: pickerStub("mock-command-picker"),
				FilePicker: pickerStub("mock-file-picker"),
				PathPicker: pickerStub("mock-path-picker"),
				ModelSelector: { template: '<div class="mock-model-selector" />' },
				ThinkToggle: { template: '<div class="mock-think-toggle" />' },
				MusicStatusBar: { template: "<div />" },
				Transition: false,
				TransitionGroup: false,
			},
		},
	});
}

async function setComposerValue(wrapper: VueWrapper, value: string) {
	await wrapper.find("textarea").setValue(value);
	wrapper.findComponent({ name: "TextEditor" }).vm.$emit("transaction", {
		value,
		selection: { from: value.length, to: value.length },
		docChanged: true,
		selectionChanged: true,
	});
	await settle();
}

/** §2.2 移除清单在 DOM 上的落点。 */
const ENGINEERING_ONLY_SELECTORS = [
	".mock-model-selector",
	".context-meter",
	".mock-think-toggle",
	".permission-mode-select",
	".tts-toggle-btn",
	".call-btn",
];

/** messenger 保留清单在 DOM 上的落点(文本框/附件/speak/发送)。 */
const ALWAYS_PRESENT_SELECTORS = [
	"textarea.composer-input",
	".attach-btn",
	".voice-btn",
	".send-btn",
];

beforeEach(() => {

  // 空间层(批 B9)从 ModelSelector / ThinkToggle / InputBox 一路读到这里,

  // 它住在 pinia 里 —— 独立挂载的组件测试也得有一个 pinia。

  setActivePinia(createPinia());
	mocks.roomTurnActive = false;
	vi.mocked(findCommand).mockReturnValue(undefined as never);
	const baseSettings = createDefaultSettings();
	baseSettings.ai.provider = "openai";
	baseSettings.ai.providers.openai.model = "gpt-vision";

	mocks.settingsStore = reactive({
		settings: baseSettings,
		saveSettings: vi.fn(async (newSettings) => {
			mocks.settingsStore.settings = newSettings;
		}),
		getCachedModels: vi.fn(() => [
			{
				id: "gpt-vision",
				context_length: 32000,
				architecture: { input_modalities: ["text", "image"] },
			},
		]),
	});
	mocks.sessionsStore = reactive({
		currentSessionId: "chat-1",
		sessionVariables: new Map(),
		sessions: [
			{ id: "chat-1", kind: "chat", workingDirectory: "/repo" },
			{
				id: "room-group",
				kind: "room",
				workingDirectory: "/repo",
				room: { memberAgentIds: ["a1", "a2"] },
			},
			{
				id: "room-user-dm",
				kind: "room",
				workingDirectory: "/repo",
				room: { memberAgentIds: ["a1"] },
			},
			{
				id: "room-pair-dm",
				kind: "room",
				workingDirectory: "/repo",
				room: { memberAgentIds: ["a1", "a2"] },
			},
		],
		getSessionItem: vi.fn((sessionId: string) =>
			mocks.sessionsStore.sessions.find((item: any) => item.id === sessionId),
		),
		// 产品层判定的唯一出口(store selector);组件不自写第二份过滤。
		isUserDmRoomSession: vi.fn(
			(sessionId?: string | null) => sessionId === "room-user-dm",
		),
		updateSessionPermissionMode: vi.fn(async () => ({ success: true })),
	});
	const composerDrafts = new Map<string, any>();
	mocks.chatStore = reactive({
		sessionMessages: new Map(),
		isSessionGenerating: vi.fn(() => false),
		pendingSteeringByMessageId: new Map<string, string>(),
		retractSteerMessage: vi.fn().mockResolvedValue(true),
		getGenerationStatus: vi.fn(() => null),
		setComposerDraft: vi.fn((sessionId: string, draft: any) => {
			composerDrafts.set(sessionId, draft);
		}),
		getComposerDraft: vi.fn(
			(sessionId: string) => composerDrafts.get(sessionId) || null,
		),
		clearComposerDraft: vi.fn((sessionId: string) =>
			composerDrafts.delete(sessionId),
		),
		isComposerDraftEmpty: vi.fn(
			(sessionId: string) => !composerDrafts.has(sessionId),
		),
	});
	mocks.voiceStore = reactive({
		isEnabled: false,
		isRecording: false,
		status: "idle",
		startListening: vi.fn().mockResolvedValue({ success: true }),
		stop: vi.fn(),
	});
	mocks.promptsStore = reactive({
		prompts: [],
		loadPrompts: vi.fn().mockResolvedValue([]),
	});
	mocks.musicStore = reactive({
		nowPlaying: null,
		radio: { active: false, intent: "", programmeLength: 0, canResume: false },
		livePosition: 0,
		progressRatio: 0,
		playerBackend: "mpv",
		initialize: vi.fn().mockResolvedValue(undefined),
		useClock: vi.fn(() => () => {}),
		sendCommand: vi.fn().mockResolvedValue({ success: true }),
		setPlayer: vi.fn().mockResolvedValue({ success: true }),
	});
	mocks.agentsStore = reactive({
		agents: [
			{ id: "a1", name: "小明", title: "前端" },
			{ id: "a2", name: "小红", title: "后端" },
		],
		loadAgents: vi.fn().mockResolvedValue(undefined),
	});

	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"window",
		Object.assign(window, {
			electronAPI: {
				getSkills: vi.fn().mockResolvedValue({ success: true, skills: [] }),
				listVariables: vi
					.fn()
					.mockResolvedValue({ success: true, variables: [] }),
				listFiles: vi
					.fn()
					.mockResolvedValue({ success: true, files: ["/repo/src/main.ts"] }),
				listDirs: vi.fn().mockResolvedValue({ success: true, dirs: ["/repo/src"] }),
				openSettingsWindow: vi.fn().mockResolvedValue({ success: true }),
			},
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.textContent = "";
});

/**
 * R3 给 `InputBox` 开的**唯一**新入口:一个可选只读 prop `placeholder`。
 * 样板要房面说「发送到 #浏览器重构」/「给小林发消息」,而占位符是本组件
 * computed 出来的,CSS 够不着 —— 于是开入口,不改任何既有行为。
 */
describe("InputBox placeholder 覆盖入口(R3)", () => {
	it("不传 = 从前那句,直聊逐字节不变", () => {
		expect(
			mountInputBox("chat-1").find(".composer-input").attributes("data-placeholder"),
		).toBe("Ask anything...");
	});

	it("不传 = 从前那句,房面也一样(覆盖是宿主给的,不是形态推的)", () => {
		expect(
			mountInputBox("room-group").find(".composer-input").attributes("data-placeholder"),
		).toBe("Ask anything...");
	});

	it("传了就用宿主那句(群 / 私聊两态)", () => {
		expect(
			mountInputBox("room-group", { placeholder: "发送到 #浏览器重构" })
				.find(".composer-input")
				.attributes("data-placeholder"),
		).toBe("发送到 #浏览器重构");
		expect(
			mountInputBox("room-user-dm", { placeholder: "给小林发消息" })
				.find(".composer-input")
				.attributes("data-placeholder"),
		).toBe("给小林发消息");
	});

	it("空串不算覆盖:退回从前那句,不画一个空占位", () => {
		expect(
			mountInputBox("room-group", { placeholder: "" })
				.find(".composer-input")
				.attributes("data-placeholder"),
		).toBe("Ask anything...");
	});
});

/**
 * 停止态开关(房/私聊新面走查修复)。
 *
 * 直聊的停止钮真的能掐掉这个会话自己的流;房里不能 —— 回合跑在各成员的执行会话
 * 里,房会话本身没有流,按下去没有效果。于是给 `InputBox` 开**第二个**可选只读
 * prop:`allowStopAction`,缺省 `true`(直聊逐字节不变),房面传 `false`。
 *
 * 这一组同时钉两件事:①房面那颗死控件不再出现;②直聊 / 不传的一侧一个字节没变。
 */
describe("InputBox 停止态开关(allowStopAction)", () => {
	it("直聊零变化:生成中且草稿为空 → 照旧是停止态(实心方块 + 可点)", () => {
		const wrapper = mountInputBox("chat-1", { isLoading: true });
		const send = wrapper.find(".send-btn");

		expect(send.classes()).toContain("stop-btn");
		expect(send.attributes("aria-label")).toBe("Stop generation");
		expect(send.attributes("disabled")).toBeUndefined();
		expect(wrapper.find(".send-label").exists()).toBe(false);
	});

	it("直聊零变化:点下去照旧发 stopGeneration", async () => {
		const wrapper = mountInputBox("chat-1", { isLoading: true });
		await wrapper.find(".send-btn").trigger("click");

		expect(wrapper.emitted("stopGeneration")).toHaveLength(1);
	});

	it("不传 = 从前:房面不传时停止态照旧出现(开关是宿主给的,不是形态推的)", () => {
		mocks.roomTurnActive = true;
		expect(
			mountInputBox("room-group").find(".send-btn").classes(),
		).toContain("stop-btn");
	});

	it("房面传 false:回合在跑也不出现停止态,画的是发送态", () => {
		mocks.roomTurnActive = true;
		const wrapper = mountInputBox("room-group", { allowStopAction: false });
		const send = wrapper.find(".send-btn");

		expect(send.classes()).not.toContain("stop-btn");
		expect(wrapper.find(".send-label").exists()).toBe(true);
		// 草稿为空 → 按**既有**规则 disabled(canSend),不是新加的门。
		expect(send.attributes("disabled")).toBeDefined();
	});

	it("房面传 false:isLoading 也罩不住 —— 且点下去永远发不出 stopGeneration", async () => {
		const wrapper = mountInputBox("room-group", {
			isLoading: true,
			allowStopAction: false,
		});
		expect(wrapper.find(".send-btn").classes()).not.toContain("stop-btn");

		await wrapper.find(".send-btn").trigger("click");
		expect(wrapper.emitted("stopGeneration")).toBeUndefined();
	});

	it("房面传 false:有草稿时照旧能发出去(关的只有停止态)", async () => {
		mocks.roomTurnActive = true;
		const wrapper = mountInputBox("room-group", { allowStopAction: false });
		await setComposerValue(wrapper, "先发这条");
		await wrapper.find(".send-btn").trigger("click");

		expect(wrapper.emitted("sendMessage")?.[0]?.[0]).toBe("先发这条");
		expect(wrapper.emitted("stopGeneration")).toBeUndefined();
	});
});

describe("InputBox composer profile", () => {
	it("直聊是 engineering,三种房都是 messenger", () => {
		expect(
			mountInputBox("chat-1").find(".composer-toolbar").attributes("data-profile"),
		).toBe("engineering");
		for (const roomId of ["room-group", "room-user-dm", "room-pair-dm"]) {
			expect(
				mountInputBox(roomId).find(".composer-toolbar").attributes("data-profile"),
			).toBe("messenger");
		}
	});

	it("直聊零变化:工程驾驶舱全量渲染(回归钉)", () => {
		const wrapper = mountInputBox("chat-1");
		for (const selector of [
			...ENGINEERING_ONLY_SELECTORS,
			...ALWAYS_PRESENT_SELECTORS,
		]) {
			expect(
				wrapper.find(selector).exists(),
				`直聊少了 ${selector}`,
			).toBe(true);
		}
	});

	it("messenger 移除清单逐项:三种房都不挂工程控件", () => {
		for (const roomId of ["room-group", "room-user-dm", "room-pair-dm"]) {
			const wrapper = mountInputBox(roomId);
			for (const selector of ENGINEERING_ONLY_SELECTORS) {
				expect(
					wrapper.find(selector).exists(),
					`${roomId} 仍在渲染 ${selector}`,
				).toBe(false);
			}
		}
	});

	it("messenger 保留清单:文本框 / 附件 / speak / 发送照旧", () => {
		for (const roomId of ["room-group", "room-user-dm", "room-pair-dm"]) {
			const wrapper = mountInputBox(roomId);
			for (const selector of ALWAYS_PRESENT_SELECTORS) {
				expect(
					wrapper.find(selector).exists(),
					`${roomId} 少了 ${selector}`,
				).toBe(true);
			}
		}
	});
});

describe("InputBox messenger @ mentions", () => {
	it("群房:输入 @ 照旧弹成员补全", async () => {
		const wrapper = mountInputBox("room-group");
		await setComposerValue(wrapper, "问一下 @");

		const picker = wrapper.find('.mock-file-picker[data-title="成员"]');
		expect(picker.exists()).toBe(true);
	});

	it("双成员 dm 房:@ 照旧(房里还有第二个人)", async () => {
		const wrapper = mountInputBox("room-pair-dm");
		await setComposerValue(wrapper, "问一下 @");

		expect(wrapper.find('.mock-file-picker[data-title="成员"]').exists()).toBe(
			true,
		);
	});

	it("单成员 dm 房:输入 @ 什么都不弹(也不掉进文件选择器)", async () => {
		const wrapper = mountInputBox("room-user-dm");
		await setComposerValue(wrapper, "问一下 @");

		expect(wrapper.find(".mock-file-picker").exists()).toBe(false);
		expect(wrapper.find(".mock-command-picker").exists()).toBe(false);
		expect(wrapper.find(".mock-path-picker").exists()).toBe(false);
	});

	it("直聊:bare @ 照旧弹文件选择器(零变化)", async () => {
		const wrapper = mountInputBox("chat-1");
		await setComposerValue(wrapper, "看看 @");

		expect(wrapper.find(".mock-file-picker").exists()).toBe(true);
	});
});

describe("InputBox messenger slash text", () => {
	it("messenger:`/` 不弹命令面", async () => {
		const wrapper = mountInputBox("room-group");
		await setComposerValue(wrapper, "/comp");

		expect(wrapper.find(".mock-command-picker").exists()).toBe(false);
	});

	it("直聊:`/` 照旧弹命令面(零变化)", async () => {
		const wrapper = mountInputBox("chat-1");
		await setComposerValue(wrapper, "/comp");

		expect(wrapper.find(".mock-command-picker").exists()).toBe(true);
	});

	it("messenger:`/compact` 当普通文本原样发出,一个字不吞", async () => {
		vi.mocked(findCommand).mockReturnValue({
			id: "compact",
			name: "Compact Context",
			description: "Compact context",
			usage: "/compact",
			execute: vi.fn(),
		} as never);
		const wrapper = mountInputBox("room-group");
		await setComposerValue(wrapper, "/compact 这句是说给房里的人听的");
		dispatchKeydown(wrapper.find("textarea").element, "Enter");
		await settle();

		expect(executeCommand).not.toHaveBeenCalled();
		const sent = wrapper.emitted("sendMessage");
		expect(sent).toBeTruthy();
		expect(sent?.[0]?.[0]).toBe("/compact 这句是说给房里的人听的");
	});

	it("直聊:`/compact` 照旧走命令派发(零变化)", async () => {
		vi.mocked(findCommand).mockReturnValue({
			id: "compact",
			name: "Compact Context",
			description: "Compact context",
			usage: "/compact",
			execute: vi.fn(),
		} as never);
		const wrapper = mountInputBox("chat-1");
		// 尾空格让命令面自己关掉(触发器只吃 `/词`),Enter 才落到 sendMessage
		// 的命令派发上而不是"确认补全"。
		await setComposerValue(wrapper, "/compact ");
		dispatchKeydown(wrapper.find("textarea").element, "Enter");
		await settle();

		expect(executeCommand).toHaveBeenCalledWith(
			"compact",
			expect.objectContaining({ sessionId: "chat-1" }),
		);
		expect(wrapper.emitted("sendMessage")).toBeFalsy();
	});

	it("messenger:RUN 标签不出现,SEND 照旧", async () => {
		const wrapper = mountInputBox("room-group");
		await setComposerValue(wrapper, "/compact");

		expect(wrapper.find(".send-label").text()).toBe("SEND ⏎");
	});
});

/**
 * Composer 手势(2026-08-17):
 *   1. 生成中发出的纯文本直接 steer(不再进本地队列);草稿为空时 Esc 把最新一条
 *      仍在引擎队列里的 steer 撤回,原文回到输入框;
 *   2. 生成中 Esc 两下打断回复,第一下只提示;
 *   3. Ctrl+C(无选区)清空草稿。
 */
describe("InputBox composer gestures(steer / esc / ctrl+c)", () => {
	function generating() {
		mocks.chatStore.isSessionGenerating = vi.fn(() => true);
	}

	it("生成中发纯文本 → 直接 steer,不进本地队列", async () => {
		generating();
		const wrapper = mountInputBox("chat-1");
		await setComposerValue(wrapper, "先看 README");
		dispatchKeydown(wrapper.find("textarea").element, "Enter");
		await settle();

		expect(wrapper.emitted("sendMessage")?.[0]).toEqual(["先看 README", "steer"]);
		// 提示走占位符,不走通知条。
		expect(wrapper.find(".composer-input").attributes("data-placeholder")).toContain("esc to take it back");
		expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("");
	});

	it("Esc(草稿为空)撤回最新 pending steer,原文回到输入框", async () => {
		generating();
		const wrapper = mountInputBox("chat-1");
		await setComposerValue(wrapper, "先看 README");
		dispatchKeydown(wrapper.find("textarea").element, "Enter");
		await settle();
		// 引擎回 steering:queued → store 记账(消息体是持久化后的副本)。
		mocks.chatStore.pendingSteeringByMessageId.set("m-steer", "chat-1");
		mocks.chatStore.sessionMessages.set("chat-1", [
			{ id: "m-steer", role: "user", content: "先看 README" },
		]);

		dispatchKeydown(wrapper.find("textarea").element, "Escape");
		await settle();

		expect(mocks.chatStore.retractSteerMessage).toHaveBeenCalledWith("m-steer");
		expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("先看 README");
		expect(wrapper.emitted("stopGeneration")).toBeUndefined();
	});

	it("Esc 有草稿时不撤回、不打断:一下提示,两下清空草稿", async () => {
		generating();
		mocks.chatStore.pendingSteeringByMessageId.set("m-steer", "chat-1");
		const wrapper = mountInputBox("chat-1");
		await setComposerValue(wrapper, "正在写");
		const textarea = wrapper.find("textarea").element;

		dispatchKeydown(textarea, "Escape");
		await settle();
		expect(mocks.chatStore.retractSteerMessage).not.toHaveBeenCalled();
		expect(wrapper.emitted("stopGeneration")).toBeUndefined();
		expect((textarea as HTMLTextAreaElement).value).toBe("正在写");
		// 有草稿时占位符不可见,提示挂在帧右角。
		expect(wrapper.find(".composer-clear-armed").exists()).toBe(false);

		dispatchKeydown(textarea, "Escape");
		await settle();
		expect((textarea as HTMLTextAreaElement).value).toBe("");
		expect(wrapper.emitted("stopGeneration")).toBeUndefined();
		expect(mocks.chatStore.retractSteerMessage).not.toHaveBeenCalled();
	});

	it("生成中 Esc 一下只提示,两下才 stopGeneration", async () => {
		generating();
		const wrapper = mountInputBox("chat-1");
		const textarea = wrapper.find("textarea").element;

		dispatchKeydown(textarea, "Escape");
		await settle();
		expect(wrapper.emitted("stopGeneration")).toBeUndefined();
		expect(wrapper.find(".composer-input").attributes("data-placeholder")).toContain("esc again to stop");

		dispatchKeydown(textarea, "Escape");
		await settle();
		expect(wrapper.emitted("stopGeneration")).toHaveLength(1);
	});

	it("allowStopAction=false:Esc 两下也打不断", async () => {
		generating();
		const wrapper = mountInputBox("chat-1", { allowStopAction: false });
		const textarea = wrapper.find("textarea").element;
		dispatchKeydown(textarea, "Escape");
		dispatchKeydown(textarea, "Escape");
		await settle();
		expect(wrapper.emitted("stopGeneration")).toBeUndefined();
	});

	it("空闲时 Esc 什么都不做", async () => {
		const wrapper = mountInputBox("chat-1");
		dispatchKeydown(wrapper.find("textarea").element, "Escape");
		await settle();
		expect(wrapper.emitted("stopGeneration")).toBeUndefined();
		expect(wrapper.find(".composer-input").attributes("data-placeholder")).toBe("Ask anything...");
	});

	it("Ctrl+C 清空草稿(Cmd+C 不动)", async () => {
		const wrapper = mountInputBox("chat-1");
		await setComposerValue(wrapper, "要清掉的话");
		const textarea = wrapper.find("textarea").element;

		const cmd = dispatchKeydown(textarea, "c", { metaKey: true });
		await settle();
		expect(cmd.defaultPrevented).toBe(false);
		expect((textarea as HTMLTextAreaElement).value).toBe("要清掉的话");

		const ctrl = dispatchKeydown(textarea, "c", { ctrlKey: true });
		await settle();
		expect(ctrl.defaultPrevented).toBe(true);
		expect((textarea as HTMLTextAreaElement).value).toBe("");
	});
});

/**
 * 生成状态读数(2026-08-17):Waiting / Thinking / Running <tool> 从消息里搬到
 * composer 顶沿的帧标签,附阶段用时与 token 数;生成中且草稿为空时右角是
 * "esc esc stop"。store 出快照,组件只是那口 100ms 的钟。
 */
describe("InputBox generation readout", () => {
	function generatingWith(status: Record<string, unknown> | null) {
		mocks.chatStore.isSessionGenerating = vi.fn(() => status !== null);
		mocks.chatStore.getGenerationStatus = vi.fn(() => status);
	}

	it("thinking:标签 THINKING + 用时 + ≈token", async () => {
		const now = Date.now();
		generatingWith({ phase: "thinking", phaseSince: now - 4800, startedAt: now - 5000, outputTokens: 420, outputTokensExact: false, inputTokens: null });
		const wrapper = mountInputBox("chat-1");
		await settle();

		const label = wrapper.find(".composer-frame-label");
		expect(label.exists()).toBe(true);
		expect(label.classes()).toContain("generating");
		expect(label.text()).toContain("THINKING");
		expect(label.text()).toMatch(/4\.[89]s/);
		expect(label.text()).toContain("≈420 tok");
	});

	it("tool:RUNNING + 工具名;精确 token 不带 ≈", async () => {
		const now = Date.now();
		generatingWith({ phase: "tool", toolName: "bash", phaseSince: now - 1000, startedAt: now - 9000, outputTokens: 1250, outputTokensExact: true, inputTokens: 3000 });
		const wrapper = mountInputBox("chat-1");
		await settle();

		const label = wrapper.find(".composer-frame-label");
		expect(label.text()).toContain("RUNNING");
		expect(label.text()).toContain("bash");
		expect(label.text()).toContain("1.3k tok");
		expect(label.text()).not.toContain("≈");
	});

	it("空闲:无标签、无 stop 角标", async () => {
		generatingWith(null);
		const wrapper = mountInputBox("chat-1");
		await settle();
		expect(wrapper.find(".composer-frame-label").exists()).toBe(false);
	});

	it("有草稿时读数照旧,右角不画任何手势标签", async () => {
		const now = Date.now();
		generatingWith({ phase: "responding", phaseSince: now, startedAt: now, outputTokens: 0, outputTokensExact: false, inputTokens: null });
		const wrapper = mountInputBox("chat-1");
		await setComposerValue(wrapper, "写点什么");
		expect(wrapper.find(".composer-frame-label").text()).toContain("RESPONDING");
		expect(wrapper.find(".composer-voice-cancel").exists()).toBe(false);
	});
});
