// @vitest-environment happy-dom
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import InputBox from "../InputBox.vue";
import { toasts } from "@/composables/useToast";
import Tooltip from "@/components/common/Tooltip.vue";
import { createDefaultSettings } from "@shared/defaults/settings";
import { executeCommand, findCommand } from "@/services/commands";
import { createFileToken } from "@shared/prompt-references";

// skills 域已迁到通用 RPC 通道(结构债 P4c 第二批):取技能表走壳外客户端。
vi.mock('@/platform/skills-client', () => ({
  skillsApi: { getAll: vi.fn().mockResolvedValue({ success: true, skills: [] }) },
}))


const mocks = vi.hoisted(() => ({
	settingsStore: null as any,
	sessionsStore: null as any,
	chatStore: null as any,
	voiceStore: null as any,
	promptsStore: null as any,
	musicStore: null as any,
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

vi.mock("@/stores/collabBoard", () => ({
	useCollabBoardStore: () => ({
		// collab-team-v2 §5.1 入口①:群聊房间的"在跑"由 collab:turn-active 说了算,
		// 普通聊天里恒为 false。
		isRoomTurnActive: () => false,
	}),
}));

// 草稿纸(scratchpad):这些用例走的全是**经典输入框**那一半,所以给一个
// 只读空壳 —— 纸住在 Todo 窗里,
// composer 只在发送时窥视一眼它的目录,行为与草稿纸落地前逐字相同。
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

vi.mock("@/stores/agents", () => ({
	useAgentsStore: () => ({ getAgent: () => null }),
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
	findCommand: vi.fn(() => null),
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
		props: ["modelValue"],
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
			'<textarea class="composer-input" :value="modelValue" @input="onInput" @paste="$emit(\'paste\', $event)" @keydown="$emit(\'keydown\', $event)" />',
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

function makePasteEvent(files: File[]): ClipboardEvent {
	const event = new Event("paste", {
		bubbles: true,
		cancelable: true,
	}) as ClipboardEvent;
	Object.defineProperty(event, "clipboardData", {
		value: {
			files,
			items: files.map((file) => ({
				kind: "file",
				type: file.type,
				getAsFile: () => file,
			})),
		},
	});
	return event;
}

async function settle() {
	await nextTick();
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await nextTick();
}

async function waitFor(predicate: () => boolean) {
	for (let i = 0; i < 25; i += 1) {
		await settle();
		if (predicate()) return;
	}
	throw new Error("Timed out waiting for condition");
}

function dispatchKeydown(element: Element, key: string) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
	});
	element.dispatchEvent(event);
	return event;
}

function mountInputBox(props: Record<string, unknown> = {}) {
	return mount(InputBox, {
		attachTo: document.body,
		props: {
			sessionId: "session-1",
			...props,
		},
		global: {
			stubs: {
				QuotedContext: { template: "<div />" },
				CommandPicker: { template: "<div />" },
				SkillPicker: { template: "<div />" },
				FilePicker: { template: "<div />" },
				PathPicker: { template: "<div />" },
				ModelSelector: { template: "<div />" },
				ThinkToggle: { template: "<div />" },
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

describe("InputBox paste attachments", () => {
	beforeEach(() => {
	  // 空间层(批 B9)从 ModelSelector / ThinkToggle / InputBox 一路读到这里,
	  // 它住在 pinia 里 —— 独立挂载的组件测试也得有一个 pinia。
	  setActivePinia(createPinia());
		vi.mocked(findCommand).mockReturnValue(undefined);
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
			currentSessionId: "session-1",
			sessionVariables: new Map(),
			sessions: [{ id: "session-1", workingDirectory: "/repo" }],
			getSessionItem: vi.fn((sessionId: string) =>
				mocks.sessionsStore.sessions.find((item: any) => item.id === sessionId),
			),
			updateSessionPermissionMode: vi.fn(async (sessionId: string, permissionMode: string) => {
				const session = mocks.sessionsStore.sessions.find((item: any) => item.id === sessionId);
				if (session) session.permissionMode = permissionMode;
				return { success: true };
			}),
		});
		const composerDrafts = new Map<string, any>();
		mocks.chatStore = reactive({
			sessionMessages: new Map(),
			isSessionGenerating: vi.fn(() => false),
			setComposerDraft: vi.fn((sessionId: string, draft: any) => {
				if (
					!draft.messageInput?.trim() &&
					!draft.quotedText?.trim() &&
					!draft.attachments?.length
				) {
					composerDrafts.delete(sessionId);
				} else {
					composerDrafts.set(sessionId, {
						...draft,
						attachments: [...(draft.attachments || [])],
					});
				}
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

		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.stubGlobal(
			"Image",
			class {
				width = 320;
				height = 180;
				onload: (() => void) | null = null;
				set src(_value: string) {
					queueMicrotask(() => this.onload?.());
				}
			},
		);
		vi.stubGlobal(
			"window",
			Object.assign(window, {
				electronAPI: {
					listVariables: vi
						.fn()
						.mockResolvedValue({ success: true, variables: [] }),
					listFiles: vi
						.fn()
						.mockResolvedValue({ success: true, files: ["/repo/src/main.ts"] }),
					listDirs: vi
						.fn()
						.mockResolvedValue({ success: true, dirs: ["/repo/src"] }),
					// A1-a:开设置窗走宿主壳路由,桩里这条 dispatcher 是它的替身。
					shellInvoke: vi.fn(async () => ({ ok: true, data: { success: true } })),
				},
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		document.body.textContent = "";
	});

	it("does not render an empty queued activity stack", () => {
		const wrapper = mountInputBox();

		expect(wrapper.find(".queued-messages").exists()).toBe(false);
	});

	it("shows the context meter even when the session has no usage yet", async () => {
		const wrapper = mountInputBox();
		await settle();

		// Resident gauge: always present in the toolbar, regardless of usage.
		const meter = wrapper.find(".context-meter");
		expect(meter.exists()).toBe(true);
		expect(meter.text()).toContain("CTX");
	});

	it("shows the context meter below the attention threshold", async () => {
		Object.assign(mocks.sessionsStore.sessions[0], {
			lastProvider: "openai",
			lastModel: "gpt-vision",
			contextSize: 8000,
			lastInputTokens: 8000,
			totalInputTokens: 12000,
			totalOutputTokens: 3000,
			totalTokens: 15000,
		});

		const wrapper = mountInputBox();
		await settle();

		// The gauge is persistent telemetry: it stays visible even while context pressure is low.
		const meter = wrapper.find(".context-meter");
		expect(meter.exists()).toBe(true);
		expect(meter.text()).toContain("25%");
	});

	it("shows the context meter with exact token values once usage crosses the threshold", async () => {
		Object.assign(mocks.sessionsStore.sessions[0], {
			lastProvider: "openai",
			lastModel: "gpt-vision",
			contextSize: 24000,
			lastInputTokens: 24000,
			totalInputTokens: 28000,
			totalOutputTokens: 3000,
			totalTokens: 31000,
		});

		const wrapper = mountInputBox();
		await settle();

		const meter = wrapper.find(".context-meter");
		expect(meter.exists()).toBe(true);
		expect(meter.text()).toContain("75%");
		// The breakdown lives on the wrapping <Tooltip> (no native title=).
		const meterTooltip = wrapper
			.findAllComponents(Tooltip)
			.find((tip) => tip.find(".context-meter").exists());
		expect(meterTooltip).toBeDefined();
		const tooltipText = meterTooltip?.props("text") as string;
		expect(tooltipText).toContain("Context: 24,000 / 32,000 tokens (75%)");
		expect(tooltipText).toContain("Total output: 3,000 tokens");
	});

	it("restores composer text when switching back to a draft session", async () => {
		const wrapper = mountInputBox({ sessionId: "draft:one" });

		await setComposerValue(wrapper, "unfinished draft");
		await wrapper.setProps({ sessionId: "session-2" });
		await settle();
		expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("");

		await wrapper.setProps({ sessionId: "draft:one" });
		await settle();

		expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("unfinished draft");
	});

	it("cycles permission mode for a draft session without a persisted chat", async () => {
		const draft = reactive({
			id: "draft:one",
			permissionMode: "normal",
			workingDirectory: "/repo",
		});
		mocks.sessionsStore.getSessionItem.mockImplementation((sessionId: string) =>
			sessionId === draft.id
				? draft
				: mocks.sessionsStore.sessions.find((item: any) => item.id === sessionId),
		);
		mocks.sessionsStore.updateSessionPermissionMode.mockImplementation(
			async (sessionId: string, permissionMode: string) => {
				if (sessionId === draft.id) draft.permissionMode = permissionMode;
				return { success: true };
			},
		);

		const wrapper = mountInputBox({ sessionId: draft.id });

		// Status-line cell: mode is spelled out as mono text ("guard:ask").
		expect(wrapper.find(".permission-mode-select").classes()).toContain("mode-normal");
		expect(wrapper.find(".guard-label").text()).toBe("guard:ask");

		await wrapper.find(".permission-mode-select .app-select-control").trigger("click");
		await settle();
		const autoEditsOption = Array.from(
			document.body.querySelectorAll<HTMLButtonElement>(".app-select-option"),
		).find((option) => option.textContent?.includes("Auto-accept edits"));
		expect(autoEditsOption).toBeTruthy();
		autoEditsOption?.click();
		await settle();

		expect(mocks.sessionsStore.updateSessionPermissionMode).toHaveBeenCalledWith(
			draft.id,
			"auto-accept-edits",
		);
		expect(wrapper.find(".permission-mode-select").classes()).toContain("mode-auto-accept-edits");
		expect(wrapper.find(".guard-label").text()).toBe("guard:edits");
	});

	it("shows an attachment tray after pasting a file", async () => {
		const wrapper = mountInputBox();
		const file = new File(["hello"], "notes.txt", { type: "text/plain" });

		wrapper.find("textarea").element.dispatchEvent(makePasteEvent([file]));
		await waitFor(() => wrapper.text().includes("notes.txt"));

		expect(wrapper.find(".attachment-tray").exists()).toBe(true);
		expect(wrapper.text()).toContain("notes.txt");
		expect(wrapper.find(".send-btn").attributes("disabled")).toBeUndefined();
	});

	it("allows sending an attachment-only message", async () => {
		const wrapper = mountInputBox();
		const file = new File(["pdf"], "brief.pdf", { type: "application/pdf" });

		wrapper.find("textarea").element.dispatchEvent(makePasteEvent([file]));
		await waitFor(() => wrapper.text().includes("brief.pdf"));
		await wrapper.find(".send-btn").trigger("click");
		await settle();

		const emitted = wrapper.emitted("sendMessage")?.[0];
		expect(emitted?.[0]).toBe("");
		expect(emitted?.[1]).toBe("send");
		expect(emitted?.[2]).toMatchObject([
			{
				fileName: "brief.pdf",
				mimeType: "application/pdf",
				mediaType: "document",
			},
		]);
		expect(wrapper.find(".attachment-tray").exists()).toBe(false);
	});

	it("docks an @ pick as a reference chip instead of inlining its path", async () => {
		const wrapper = mountInputBox();

		await setComposerValue(
			wrapper,
			`explain ${createFileToken("/repo/src/a.ts")} please`,
		);

		expect(wrapper.find(".attachment-tray").exists()).toBe(true);
		expect(wrapper.text()).toContain("src/a.ts");
	});

	it("expands docked references back to @path in place when sending", async () => {
		const wrapper = mountInputBox();

		await setComposerValue(
			wrapper,
			`explain ${createFileToken("/repo/src/a.ts")} please`,
		);
		await wrapper.find(".send-btn").trigger("click");
		await settle();

		expect(wrapper.emitted("sendMessage")?.[0]?.[0]).toBe(
			"explain @/repo/src/a.ts please",
		);
		expect(wrapper.find(".attachment-tray").exists()).toBe(false);
	});

	it("removes a pasted attachment from the tray", async () => {
		const wrapper = mountInputBox();
		const file = new File(["hello"], "remove-me.txt", { type: "text/plain" });

		wrapper.find("textarea").element.dispatchEvent(makePasteEvent([file]));
		await waitFor(() => wrapper.text().includes("remove-me.txt"));
		await wrapper.find(".attachment-remove").trigger("click");
		await settle();

		expect(wrapper.find(".attachment-tray").exists()).toBe(false);
		expect(wrapper.find(".send-btn").attributes("disabled")).toBeDefined();
	});

	it("queues attachment messages during generation and flushes them afterwards", async () => {
		const wrapper = mountInputBox({ isLoading: true });
		const file = new File(["hello"], "queued.txt", { type: "text/plain" });

		wrapper.find("textarea").element.dispatchEvent(makePasteEvent([file]));
		await waitFor(() => wrapper.text().includes("queued.txt"));
		await wrapper.find(".send-btn").trigger("click");
		await settle();

		expect(wrapper.emitted("sendMessage")).toBeUndefined();
		expect(wrapper.text()).toContain("1 file attached");

		await wrapper.setProps({ isLoading: false });
		await settle();

		const emitted = wrapper.emitted("sendMessage")?.[0];
		expect(emitted?.[0]).toBe("");
		expect(emitted?.[1]).toBe("send");
		expect(emitted?.[2]).toMatchObject([{ fileName: "queued.txt" }]);
		await waitFor(() => !wrapper.find(".queued-messages").exists());
	});

	it("steers text messages straight away instead of queueing them locally", async () => {
		const wrapper = mountInputBox({ isLoading: true });

		await setComposerValue(wrapper, "hi");
		await wrapper.find(".send-btn").trigger("click");
		await settle();

		expect(wrapper.emitted("sendMessage")?.[0]).toEqual(["hi", "steer"]);
		expect(wrapper.find(".queued-message-card").exists()).toBe(false);
		expect(wrapper.text()).not.toContain("Message queued");
	});

	it("shows a file changes summary above queued insert messages", async () => {
		mocks.chatStore.sessionMessages.set("session-1", [
			{
				id: "assistant-1",
				role: "assistant",
				content: "",
				timestamp: Date.now(),
				steps: [
					{
						id: "diff-step-1",
						toolCall: {
							changes: {
								diff: "diff --git a/a.ts b/a.ts\n+added\n-removed",
								filePath: "/repo/a.ts",
								additions: 88,
								deletions: 656,
							},
						},
					},
				],
			},
		]);
		const wrapper = mountInputBox({ isLoading: true });
		const file = new File(["hello"], "queued.txt", { type: "text/plain" });

		wrapper.find("textarea").element.dispatchEvent(makePasteEvent([file]));
		await waitFor(() => wrapper.text().includes("queued.txt"));
		await setComposerValue(wrapper, "hi");
		await wrapper.find(".send-btn").trigger("click");
		await settle();

		expect(wrapper.find(".queued-file-changes-row").text()).toContain("1 file changed");
		expect(wrapper.find(".queued-file-changes-row").text()).toContain("+88");
		expect(wrapper.find(".queued-file-changes-row").text()).toContain("-656");
	});

	it("keeps Enter inside the active palette instead of sending the draft", async () => {
		const wrapper = mountInputBox();

		await setComposerValue(wrapper, "/c");
		dispatchKeydown(wrapper.find("textarea").element, "Enter");
		await settle();

		expect(wrapper.emitted("sendMessage")).toBeUndefined();
	});

	it("keeps Enter inside the active file picker instead of sending the draft", async () => {
		const wrapper = mountInputBox();

		await setComposerValue(wrapper, "@");
		dispatchKeydown(wrapper.find("textarea").element, "Enter");
		await settle();

		expect(wrapper.emitted("sendMessage")).toBeUndefined();
	});

	it("lets /cd Enter flow through as the path confirmation action", async () => {
		const wrapper = mountInputBox();

		await setComposerValue(wrapper, "/cd /repo");
		dispatchKeydown(wrapper.find("textarea").element, "Enter");
		await settle();

		expect(wrapper.emitted("sendMessage")?.[0]?.[0]).toBe("/cd /repo");
	});

	it("emits the target session when a slash command creates a new session", async () => {
		vi.mocked(findCommand).mockReturnValue({
			id: "new",
			name: "New Session",
			description: "Start a new chat session",
			usage: "/new",
			execute: vi.fn(),
		});
		vi.mocked(executeCommand).mockResolvedValue({
			success: true,
			message: "New session opened",
			switchToSessionId: "session-new",
		});
		const wrapper = mountInputBox();

		await setComposerValue(wrapper, "/new");
		await wrapper.find(".send-btn").trigger("click");
		await settle();

		expect(wrapper.emitted("switchSession")?.[0]).toEqual(["session-new"]);
		expect(wrapper.find("textarea").element).toHaveProperty("value", "");
	});

	it("keeps the voice button clickable and repairs an incomplete advanced ASR choice", async () => {
		mocks.settingsStore.settings.voice.enabled = true;
		mocks.settingsStore.settings.voice.asr.provider = "openai-transcribe";
		mocks.settingsStore.settings.voice.asr.openai.apiKey = "";
		mocks.settingsStore.settings.ai.providers.openai.apiKey = "";
		mocks.settingsStore.settings.ai.providers.openrouter.apiKey = "";

		const wrapper = mountInputBox();
		const voiceButton = wrapper.find(".voice-btn");

		expect(voiceButton.attributes("disabled")).toBeUndefined();

		await voiceButton.trigger("click");
		await settle();

		const savedSettings =
			mocks.settingsStore.saveSettings.mock.calls.at(-1)?.[0];
		expect(savedSettings.voice.asr.provider).toBe("funasr-stream");
		expect((window.electronAPI as any).shellInvoke).toHaveBeenCalledWith(
			expect.objectContaining({ domain: "settings-window", method: "open" }),
		);
		expect(mocks.voiceStore.startListening).not.toHaveBeenCalled();
		// 结果提示走全局 ToastHost(与系统通知同一个组件),不再画在 InputBox 里。
		expect(toasts.value.map((item) => item.message).join("\n")).toContain("Voice was reset to streaming ASR");
	});

	it("enables the recommended voice path from the mic button when FunASR streaming is configured", async () => {
		mocks.settingsStore.settings.voice.enabled = false;
		mocks.settingsStore.settings.voice.asr.provider = "funasr-stream";
		mocks.settingsStore.settings.voice.asr.funasr.url = "ws://127.0.0.1:10095";

		const wrapper = mountInputBox();

		await wrapper.find(".voice-btn").trigger("click");
		await settle();

		const savedSettings =
			mocks.settingsStore.saveSettings.mock.calls.at(-1)?.[0];
		expect(savedSettings.voice.enabled).toBe(true);
		expect(savedSettings.voice.asr.provider).toBe("funasr-stream");
		expect((window.electronAPI as any).shellInvoke).not.toHaveBeenCalledWith(
			expect.objectContaining({ domain: "settings-window", method: "open" }),
		);
		expect(mocks.voiceStore.startListening).toHaveBeenCalledWith("session-1");
	});

	it("submits the current recording when the mic button is clicked again", async () => {
		mocks.voiceStore.isRecording = true;

		const wrapper = mountInputBox();

		await wrapper.find(".voice-btn").trigger("click");
		await settle();

		expect(mocks.voiceStore.stop).toHaveBeenCalledWith("mic-button", true);
		expect(mocks.voiceStore.startListening).not.toHaveBeenCalled();
	});

	it("turns the composer frame into the listening state with an esc cancel", async () => {
		mocks.voiceStore.isRecording = true;
		mocks.voiceStore.status = "recording";

		const wrapper = mountInputBox();
		await settle();

		const frameLabel = wrapper.find(".composer-frame-label");
		expect(frameLabel.text()).toContain("LISTENING");
		expect(frameLabel.text()).toContain("0:00");
		expect(frameLabel.classes()).toContain("listening");
		expect(wrapper.find(".composer").classes()).toContain("listening");

		const cancel = wrapper.find(".composer-voice-cancel");
		expect(cancel.exists()).toBe(true);
		await cancel.trigger("click");
		await settle();
		expect(mocks.voiceStore.stop).toHaveBeenCalledWith("cancel", false);
	});

	it("marks the composer frame while speech is sent to ASR", async () => {
		mocks.voiceStore.isRecording = true;
		mocks.voiceStore.status = "transcribing";

		const wrapper = mountInputBox();
		await settle();

		const frameLabel = wrapper.find(".composer-frame-label");
		expect(frameLabel.text()).toContain("TRANSCRIBING");
		expect(wrapper.find(".composer").classes()).toContain("transcribing");
		expect(wrapper.find(".composer-voice-cancel").exists()).toBe(false);
		expect(wrapper.find(".voice-btn").classes()).toContain("transcribing");
	});
});
