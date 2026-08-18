// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import TodoPlanPanel from "../TodoPlanPanel.vue";

const mocks = vi.hoisted(() => {
	const scratchpadRecord = {
		content: "纸上写了一句话",
		version: 3,
		filePath: "/store/scratchpads/session-1.md",
		loaded: true,
		dirty: false,
		consumedVersion: 0,
	};
	/** 水位偏移在用例里现调 —— 「AI 读到第 N 段」这句话就靠它和 watermark 事件。 */
	const consumed: { offset: number | null } = { offset: null };
	return {
		consumed,
		sessionsStore: {
			currentSessionId: "session-1",
			sessions: [{ id: "session-1", workingDirectory: "/repo" }],
			isNewChatDraftId: () => false,
		},
		scratchpadRecord,
		scratchpadStore: {
			records: { "session-1": scratchpadRecord },
			getRecord: (sessionId?: string | null) =>
				sessionId === "session-1" ? scratchpadRecord : null,
			load: vi.fn().mockResolvedValue(undefined),
			setContent: vi.fn(),
			flushNow: vi.fn().mockResolvedValue(undefined),
			consumedOffset: () => consumed.offset,
			pendingText: () => scratchpadRecord.content,
		},
		editorFocus: vi.fn(),
		editorSetSelection: vi.fn(),
		editorSetValue: vi.fn(),
		editorApplyCommand: vi.fn(),
		editorSelectedText: vi.fn(() => ""),
		editorFindTextMatches: vi.fn((_query: string) => [] as Array<{ from: number; to: number }>),
	};
});

vi.mock("@/stores/sessions", () => ({
	useSessionsStore: () => mocks.sessionsStore,
}));

vi.mock("@/stores/settings", () => ({
	useSettingsStore: () => ({
		settings: {
			general: {
				editor: {
					tabSize: 2,
					lineWrapping: true,
					softWrapColumn: 88,
					markdownNoteAttachmentDirectory: "",
					markdownProjectAttachmentDirectory: "",
				},
			},
		},
	}),
}));

vi.mock("@/editor/tiptap/TiptapNoteEditor.vue", () => ({
	default: {
		name: "TiptapNoteEditor",
		props: [
			"features",
			"modelValue",
			"surface",
			"documentId",
			"documentPath",
			"workspaceRoot",
			"placeholder",
			"spellcheck",
			"consumedOffset",
			"sourceToggle",
		],
		emits: [
			"update:modelValue",
			"keydown",
			"paste",
			"openLink",
			"openImage",
			"selectionUpdate",
			"watermark",
		],
		setup(
			_props: unknown,
			{ expose }: { expose: (exposed: Record<string, unknown>) => void },
		) {
			expose({
				focus: mocks.editorFocus,
				setSelection: mocks.editorSetSelection,
				setValue: mocks.editorSetValue,
				getSelection: () => ({ from: 0, to: 0 }),
				getValue: () => "",
				getSelectedText: () => mocks.editorSelectedText(),
				findTextMatches: (query: string) => mocks.editorFindTextMatches(query),
				blur: vi.fn(),
				replaceRange: vi.fn(),
				scrollToTop: vi.fn(),
				getScrollTop: () => 0,
				setScrollTop: vi.fn(),
				getCursorLineInfo: () => ({
					lineNumber: 1,
					totalLines: 1,
					from: 0,
					to: 0,
					text: "",
				}),
				applyCommand: mocks.editorApplyCommand,
				setSourceMode: vi.fn(),
				toggleSourceMode: vi.fn(),
				getSourceMode: () => false,
			});
			return {};
		},
		template: `
      <textarea
        class="mock-editor"
        :value="modelValue"
        @input="$emit('update:modelValue', $event.target.value)"
        @keydown="$emit('keydown', $event)"
      />
    `,
	},
}));

/**
 * 草稿纸的账本是一个真 Pinia store,而这个测试文件不装 Pinia —— 桩掉它,
 * 让面板的模式切换能单独被验证,不把纸的同步链一起拖进来(那条链有自己的
 * 测试:`stores/__tests__/scratchpad.test.ts`)。
 */
vi.mock("@/stores/scratchpad", () => ({
	useScratchpadStore: () => mocks.scratchpadStore,
}));

class ResizeObserverStub {
	observe = vi.fn();
	disconnect = vi.fn();
	unobserve = vi.fn();
}

const snapshot = {
	directory: "/tmp/todo-plan",
	userNotes: [
		{
			id: "user-todo-1",
			scope: "user-note" as const,
			title: "User Todo",
			role: "user" as const,
			filePath: "/tmp/user-todo-1.md",
			content: "# User Todo\n\n- [ ] Write tests",
			updatedAt: 1,
			totalTasks: 1,
		},
	],
	sessionAiTodo: {
		id: "session-ai-todo",
		scope: "session-ai-todo" as const,
		title: "AI Todo",
		role: "assistant" as const,
		filePath: "/tmp/ai-todo.md",
		content: "# AI Todo\n\n## Now\n- [ ] Review work",
		updatedAt: 1,
		totalTasks: 1,
	},
};

let todoPlanChangedHandler: ((data: any) => void) | undefined;

async function settle() {
	await nextTick();
	await Promise.resolve();
	await nextTick();
}

/**
 * todo/plan 的数据面已迁到通用 RPC 通道(todoPlanRouter),preload 不再逐方法暴露。
 * 这个桩因此分两层:数据面的 vi.fn() 仍然在(断言还看它们),但组件是经
 * `rpcInvoke` 到达它们的 —— 桩里这个 dispatcher 就是那条通道在测试里的替身。
 */
const TODO_PLAN_RPC_METHODS: Record<string, string> = {
	get: "getTodoPlan",
	create: "createTodoPlanNote",
	update: "updateTodoPlan",
	rename: "renameTodoPlanNote",
	delete: "deleteTodoPlanNote",
	revealDirectory: "revealTodoPlanDirectory",
};

function installElectronApi() {
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			rpcInvoke: vi.fn(async (request: any) => {
				const name = request?.domain === "todo-plan"
					? TODO_PLAN_RPC_METHODS[request.method]
					: undefined;
				if (!name) {
					return {
						ok: false,
						error: { message: `unstubbed rpc ${request?.domain}.${request?.method}` },
					};
				}
				const handler = (window.electronAPI as any)[name];
				return { ok: true, data: await handler(request.payload) };
			}),
			getTodoPlan: vi.fn().mockResolvedValue({ success: true, snapshot }),
			updateTodoPlan: vi.fn().mockImplementation((request) =>
				Promise.resolve({
					success: true,
					document: {
						...snapshot.userNotes[0],
						scope: request.scope,
						id: request.id || "session-ai-todo",
						content: request.content,
					},
				}),
			),
			createTodoPlanNote: vi.fn().mockResolvedValue({
				success: true,
				document: {
					...snapshot.userNotes[0],
					id: "untitled-note",
					title: "Untitled Note",
					content: "# Untitled Note\n\n",
				},
			}),
			renameTodoPlanNote: vi.fn(),
			deleteTodoPlanNote: vi.fn(),
			revealTodoPlanDirectory: vi.fn(),
			openTodoPlanWindow: vi.fn(),
			hideTodoPlanWindow: vi.fn(),
			toggleTodoPlanWindow: vi.fn(),
			setTodoPlanWindowPinned: vi.fn(),
			minimizeTodoPlanWindow: vi.fn().mockResolvedValue({ success: true }),
			zoomTodoPlanWindow: vi.fn().mockResolvedValue({ success: true }),
			dragTodoPlanWindow: vi.fn().mockResolvedValue({ success: true }),
			setWindowButtonVisibility: vi.fn().mockResolvedValue({ success: true }),
			emitCommand: vi.fn().mockResolvedValue({ success: true }),
			onTodoPlanChanged: vi.fn((callback: (data: any) => void) => {
				todoPlanChangedHandler = callback;
				return vi.fn(() => {
					if (todoPlanChangedHandler === callback)
						todoPlanChangedHandler = undefined;
				});
			}),
		},
	});
}

/**
 * 每条用例结束都把挂过的面板卸掉。这不是洁癖:面板在 `window` 上挂了 keydown /
 * pointerdown / storage 三个监听,不卸载的话上一条用例留下的那一份**照样会收到**
 * 下一条用例派发的事件,然后往已经被 afterEach 清空的 DOM 里渲染
 * (实测:`insertBefore of null`,而且报在无辜的那条用例身上)。
 */
enableAutoUnmount(afterEach);

describe("TodoPlanPanel", () => {
	let storage: Record<string, string>;
	let scrollIntoView: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		mocks.editorFocus.mockClear();
		mocks.editorSetSelection.mockClear();
		mocks.editorSetValue.mockClear();
		mocks.editorApplyCommand.mockClear();
		mocks.editorSelectedText.mockClear();
		mocks.editorSelectedText.mockReturnValue("");
		mocks.editorFindTextMatches.mockClear();
		mocks.scratchpadStore.load.mockClear();
		mocks.scratchpadStore.setContent.mockClear();
		mocks.scratchpadStore.flushNow.mockClear();
		mocks.scratchpadRecord.content = "纸上写了一句话";
		mocks.consumed.offset = null;
		storage = {};
		vi.stubGlobal("localStorage", {
			getItem: vi.fn((key: string) => storage[key] ?? null),
			setItem: vi.fn((key: string, value: string) => {
				storage[key] = value;
			}),
			removeItem: vi.fn((key: string) => {
				delete storage[key];
			}),
			clear: vi.fn(() => {
				storage = {};
			}),
		});
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
		localStorage.clear();
		localStorage.setItem("todoPlanCollapsed", "false");
		todoPlanChangedHandler = undefined;
		installElectronApi();
	});

	afterEach(() => {
		document.body.textContent = "";
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("shows only standalone window controls in standalone mode", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { standalone: true },
		});
		await settle();

		expect(wrapper.find('[aria-label="Keep window on top"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="更多操作"]').exists()).toBe(true);
		expect(
			wrapper.find(".panel-actions .icon-button").attributes("aria-label"),
		).toBe("更多操作");
		// 设计稿头行只有「标题 + 读数 + ⋯」:换笔记 / 新建 / 钉住全部收进 ⌘K 命令面板。
		expect(wrapper.find('[aria-label="Browse notes"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="New note"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Unpin Todo"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Find in note"]').exists()).toBe(false);
		// 自绘红绿灯:系统那组是灰的(non-activating NSPanel 成不了 main window),
		// 主进程已把它收起来,这三枚才是真控件。
		expect(wrapper.find(".window-lights").exists()).toBe(true);
		expect(wrapper.find('.window-light[aria-label="关闭"]').exists()).toBe(true);
		expect(wrapper.find('.window-light[aria-label="最小化"]').exists()).toBe(true);
		expect(wrapper.find('.window-light[aria-label="缩放"]').exists()).toBe(true);
		expect(wrapper.find(".window-title").exists()).toBe(true);
		expect(wrapper.find('[aria-label="Open in window"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Dock card"]').exists()).toBe(false);
		expect(wrapper.find(".resize-handle").exists()).toBe(false);
	});

	/**
	 * 自绘红绿灯与手动拖窗。两件事同一个根因:这扇窗是 non-activating NSPanel,
	 * 系统交通灯恒灰、原生 `-webkit-app-region: drag` 也不生效,所以两样都得自己来。
	 */
	it("wires the three self-drawn window lights", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { standalone: true },
		});
		await settle();

		// 红点是**隐藏**不是销毁 —— 这扇窗从来就是收起来的语义。
		await wrapper.find('.window-light[aria-label="关闭"]').trigger("click");
		expect(window.electronAPI.hideTodoPlanWindow).toHaveBeenCalled();

		await wrapper.find('.window-light[aria-label="最小化"]').trigger("click");
		expect(window.electronAPI.minimizeTodoPlanWindow).toHaveBeenCalled();

		await wrapper.find('.window-light[aria-label="缩放"]').trigger("click");
		expect(window.electronAPI.zoomTodoPlanWindow).toHaveBeenCalled();
	});

	it("drags the window by cumulative screen offset, and buttons never start a drag", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { standalone: true },
		});
		await settle();

		const drag = window.electronAPI.dragTodoPlanWindow as ReturnType<typeof vi.fn>;
		const rail = wrapper.find(".mode-rail").element;
		const nextFrame = () =>
			new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

		rail.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 1,
				screenX: 400,
				screenY: 300,
			}),
		);
		expect(drag).toHaveBeenCalledWith({ phase: "start" });

		rail.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				pointerId: 1,
				screenX: 430,
				screenY: 280,
			}),
		);
		await nextFrame();
		// 相对**按下那一点**的累计位移,不是帧间增量。
		expect(drag).toHaveBeenCalledWith({ phase: "move", dx: 30, dy: -20 });

		rail.dispatchEvent(
			new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }),
		);
		expect(drag).toHaveBeenCalledWith({ phase: "end" });

		// 轨上的形态钮:按下去只是切形态,不该顺手把窗拖走。
		drag.mockClear();
		wrapper
			.find('[aria-label="草稿纸"]')
			.element.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					button: 0,
					pointerId: 2,
					screenX: 400,
					screenY: 300,
				}),
			);
		expect(drag).not.toHaveBeenCalled();
	});

	it("shows chat card controls in chat mode", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(wrapper.find('[aria-label="更多操作"]').exists()).toBe(true);
		expect(wrapper.find('[aria-label="Browse notes"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="New note"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Find in note"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Pin Todo"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Keep card open"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Dock card"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Open in window"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Keep window on top"]').exists()).toBe(false);
	});

	it("uses a shorter default floating card height", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(
			(wrapper.find(".todo-plan-panel").element as HTMLElement).style.height,
		).toBe("320px");
	});

	it("does not restore the removed docked card mode from old storage", async () => {
		localStorage.setItem("todoPlanCardDocked", "true");
		localStorage.setItem("todoPlanDocked", "true");

		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		const panel = wrapper.find(".todo-plan-panel");
		expect(panel.classes()).not.toContain("surface-chat-floating-card");
		expect(panel.classes()).not.toContain("surface-chat-docked-card");
		expect(panel.classes()).not.toContain("docked");
		expect(panel.classes()).not.toContain("collapsed");

		await panel.trigger("mouseleave");
		await settle();

		expect(panel.classes()).toContain("collapsed");
	});

	it("migrates the old floating card default height to the shorter height", async () => {
		localStorage.setItem("todoPlanCardHeight", "360");

		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(
			(wrapper.find(".todo-plan-panel").element as HTMLElement).style.height,
		).toBe("320px");
	});

	it("uses the window-style titlebar without the old two-line card heading", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(wrapper.find(".title-display").exists()).toBe(false);
		expect(wrapper.find(".panel-title").exists()).toBe(false);
		expect(wrapper.find(".window-title").exists()).toBe(true);
		expect(wrapper.find(".window-title").text()).toBe("待做");

		await wrapper.find(".window-title").trigger("click");
		await settle();
		expect(wrapper.find(".note-switcher").exists()).toBe(false);

		// 换笔记的直陈钮收进了命令面板:⌘P 直达切换器。
		wrapper.find(".todo-plan-panel").element.dispatchEvent(
			new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
		);
		await settle();
		expect(wrapper.find(".note-switcher").exists()).toBe(true);
	});

	it("keeps task counts out of the compact titlebar", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(wrapper.find(".window-title").text()).toBe("待做");
		expect(wrapper.text()).not.toContain("1/1 open task");
	});

	it("opens a floating find bar on command-f without rendering the old layout search row", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		wrapper.find(".todo-plan-panel").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "f",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(wrapper.find(".floating-find-bar").exists()).toBe(true);
		expect(wrapper.find(".search-row").exists()).toBe(false);
		expect(wrapper.find(".panel-body").exists()).toBe(true);
	});

	it("opens the note switcher on command-p with user and system notes", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		wrapper.find(".todo-plan-panel").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "p",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(wrapper.find(".note-switcher").exists()).toBe(true);
		expect(wrapper.find(".note-switcher").classes()).toContain("todo-popover");
		expect(wrapper.find(".note-switcher").classes()).toContain("todo-popover-notes");
		expect(wrapper.find(".note-switcher .switcher-search svg").exists()).toBe(
			true,
		);
		expect(wrapper.find(".note-switcher .switcher-search").classes()).toContain(
			"todo-popover-search",
		);
		expect(wrapper.find(".note-switcher .switcher-list").classes()).toContain(
			"todo-popover-list",
		);
		expect(
			wrapper
				.find(".note-switcher .switcher-search input")
				.attributes("placeholder"),
		).toBe("Search for notes...");
		expect(wrapper.find(".switcher-actions").exists()).toBe(false);
		expect(wrapper.text()).toContain("Notes");
		expect(wrapper.text()).toContain("1 Note");
		expect(wrapper.text()).toContain("AI Todo");
	});

	it("moves the note switcher selection with arrow keys and keeps it visible", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		wrapper.find(".todo-plan-panel").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "p",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();
		scrollIntoView.mockClear();

		wrapper.find(".switcher-search input").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "ArrowDown",
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(wrapper.find(".note-option.selected").text()).toContain("AI Todo");
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

		wrapper.find(".switcher-search input").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(wrapper.find(".note-switcher").exists()).toBe(false);
		expect(storage.todoPlanCardActiveId).toBe("session-ai-todo");
		wrapper.unmount();
	});

	it("opens the action panel on command-k and runs markdown commands", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		wrapper.find(".todo-plan-panel").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "k",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(wrapper.find(".todo-notes-action-panel").exists()).toBe(true);
		expect(wrapper.find(".todo-notes-action-panel").classes()).toContain(
			"todo-popover",
		);
		expect(wrapper.find(".todo-notes-action-panel").classes()).toContain(
			"todo-popover-actions",
		);
		expect(
			wrapper.find(".todo-notes-action-panel .action-search svg").exists(),
		).toBe(true);
		expect(
			wrapper.find(".todo-notes-action-panel .action-search").classes(),
		).toContain("todo-popover-search");
		expect(
			wrapper.find(".todo-notes-action-panel .action-list").classes(),
		).toContain("todo-popover-list");
		expect(
			wrapper
				.find(".todo-notes-action-panel .action-search input")
				.attributes("placeholder"),
		).toBe("Search for actions...");
		expect(wrapper.text()).toContain("Create Note");

		await wrapper.find(".todo-notes-action-panel input").setValue("bold");
		await settle();
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(mocks.editorApplyCommand).toHaveBeenCalledWith("bold");
		expect(wrapper.find(".todo-notes-action-panel").exists()).toBe(false);
	});

	it("moves the action panel selection with arrow keys and keeps it visible", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		wrapper.find(".todo-plan-panel").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "k",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();
		scrollIntoView.mockClear();

		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "ArrowDown",
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(wrapper.find(".action-row.selected").text()).toContain(
			"Rename Note",
		);
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
		wrapper.unmount();
	});

	it("opens the command panel from the top-right titlebar button", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { standalone: true },
		});
		await settle();

		await wrapper.find('[aria-label="更多操作"]').trigger("click");
		await settle();

		expect(wrapper.find(".todo-notes-action-panel").exists()).toBe(true);
		expect(
			wrapper.find(".panel-actions .icon-button").attributes("aria-label"),
		).toBe("更多操作");
		wrapper.unmount();
	});

	it("uses the footer type button to show the formatting bar", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(wrapper.find(".format-buffer").exists()).toBe(false);
		await wrapper.find('[aria-label="Show formatting bar"]').trigger("click");
		await settle();

		expect(wrapper.find(".format-buffer").exists()).toBe(true);
		await wrapper.find('.format-buffer [aria-label="Bold"]').trigger("click");
		expect(mocks.editorApplyCommand).toHaveBeenCalledWith("bold");
		await wrapper
			.find('.format-buffer [aria-label="Strikethrough"]')
			.trigger("click");
		expect(mocks.editorApplyCommand).toHaveBeenCalledWith("strikethrough");
		await wrapper.find('.format-buffer [aria-label="Underline"]').trigger("click");
		expect(mocks.editorApplyCommand).toHaveBeenCalledWith("underline");

		await wrapper.find('[aria-label="Hide formatting bar"]').trigger("click");
		await settle();
		expect(wrapper.find(".format-buffer").exists()).toBe(false);
	});

	it("uses the same command panel actions across window and chat surfaces", async () => {
		const standalone = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { standalone: true },
		});
		await settle();

		standalone.find(".todo-plan-panel").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "k",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(standalone.text()).not.toContain("Keep Window on Top");
		expect(standalone.text()).not.toContain("Keep Card Open");
		expect(standalone.text()).not.toContain("Open in Window");
		expect(standalone.text()).not.toContain("Dock Card");
		standalone.unmount();

		const chatCard = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		chatCard.find(".todo-plan-panel").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "k",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(chatCard.text()).not.toContain("Open in Window");
		expect(chatCard.text()).not.toContain("Dock Card");
		expect(chatCard.text()).not.toContain("Keep Window on Top");
		expect(chatCard.text()).not.toContain("Keep Card Open");
	});

	it("always uses the render-first editor without a separate preview mode", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		const editor = wrapper.findComponent({ name: "TiptapNoteEditor" });

		expect(editor.props("surface")).toBe("todo-notes");
		expect(editor.props("features")).toMatchObject({
			tasks: true,
			tables: true,
			images: true,
			math: true,
		});
		// 源码钮是代码工作台那边才打开的能力,笔记面上不出。
		expect(editor.props("sourceToggle")).toBeUndefined();
		expect(wrapper.find('[aria-label="Preview markdown"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Edit markdown"]').exists()).toBe(false);
		expect(wrapper.find(".markdown-preview").exists()).toBe(false);
	});

	it("does not show a workspace AI todo before one exists", async () => {
		(window.electronAPI as any).getTodoPlan = vi.fn().mockResolvedValue({
			success: true,
			snapshot: {
				directory: snapshot.directory,
				userNotes: snapshot.userNotes,
			},
		});
		localStorage.setItem("todoPlanCardActiveId", "session-ai-todo");

		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(wrapper.text()).not.toContain("AI Todo");
		expect(
			wrapper
				.findComponent({ name: "TiptapNoteEditor" })
				.props("modelValue"),
		).toContain("# User Todo");
		expect(storage.todoPlanCardActiveId).toBe("user-todo-1");
	});

	it("keeps standalone window and chat card storage state independent", async () => {
		localStorage.setItem("todoPlanWindowActiveId", "session-ai-todo");
		localStorage.setItem("todoPlanCardActiveId", "user-todo-1");

		const standalone = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { standalone: true },
		});
		await settle();

		expect(
		standalone.findComponent({ name: "TiptapNoteEditor" }).props("modelValue"),
	).toContain("AI Todo");
		expect(
			standalone.findComponent({ name: "TiptapNoteEditor" }).exists(),
		).toBe(true);

		standalone.unmount();

		const chatCard = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(chatCard.find(".window-title").text()).toBe("待做");
		const chatEditor = chatCard.findComponent({
			name: "TiptapNoteEditor",
		});
		expect(chatEditor.exists()).toBe(true);
		expect(chatEditor.props("modelValue")).toContain("# User Todo");
	});

	it("refreshes the active workspace todo when the todo tool broadcasts a matching change", async () => {
		localStorage.setItem("todoPlanCardActiveId", "session-ai-todo");
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(
			wrapper
				.findComponent({ name: "TiptapNoteEditor" })
				.props("modelValue"),
		).toContain("Review work");

		todoPlanChangedHandler?.({
			scope: "session-ai-todo",
			sessionId: "session-1",
			workingDirectory: "/repo",
			document: {
				...snapshot.sessionAiTodo,
				content:
					"# AI Todo\n\n## Now\n- [x] Review work\n- [ ] Ship the refresh fix",
				updatedAt: 2,
				totalTasks: 2,
			},
		});
		await settle();

		const editor = wrapper.findComponent({ name: "TiptapNoteEditor" });
		expect(editor.props("modelValue")).toContain("Ship the refresh fix");
		expect(wrapper.find(".window-title").text()).toBe("待做");
		expect(wrapper.text()).not.toContain("1/2 open task");
	});

	it("does not overwrite local draft edits with an incoming todo broadcast", async () => {
		localStorage.setItem("todoPlanCardActiveId", "session-ai-todo");
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		await wrapper.find(".mock-editor").setValue("# AI Todo\n\nLocal draft");
		await settle();

		todoPlanChangedHandler?.({
			scope: "session-ai-todo",
			sessionId: "session-1",
			workingDirectory: "/repo",
			document: {
				...snapshot.sessionAiTodo,
				content: "# AI Todo\n\nExternal tool update",
				updatedAt: 2,
			},
		});
		await settle();

		const editor = wrapper.findComponent({ name: "TiptapNoteEditor" });
		expect(editor.props("modelValue")).toContain("Local draft");
		expect(editor.props("modelValue")).not.toContain("External tool update");
	});

	it("only registers card toggle events for chat cards", async () => {
		const addSpy = vi.spyOn(window, "addEventListener");

		const standalone = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { standalone: true },
		});
		await settle();

		expect(addSpy).not.toHaveBeenCalledWith(
			"todo-plan:toggle-card",
			expect.any(Function),
		);
		standalone.unmount();

		const chatCard = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(addSpy).toHaveBeenCalledWith(
			"todo-plan:toggle-card",
			expect.any(Function),
		);
		expect(chatCard.classes()).not.toContain("collapsed");

		window.dispatchEvent(new CustomEvent("todo-plan:toggle-card"));
		await settle();

		expect(chatCard.classes()).toContain("collapsed");
	});

	it("leaves native macOS window buttons untouched in the standalone window (always visible via window config)", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { standalone: true },
		});
		await settle();

		const panel = wrapper.find(".todo-plan-panel");
		panel.element.dispatchEvent(
			new MouseEvent("mouseenter", { bubbles: true }),
		);
		panel.element.dispatchEvent(
			new MouseEvent("mouseleave", { bubbles: true }),
		);
		await settle();

		expect(window.electronAPI.setWindowButtonVisibility).not.toHaveBeenCalled();
	});

	it("does not control native window buttons from chat card surfaces", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		const panel = wrapper.find(".todo-plan-panel");
		panel.element.dispatchEvent(
			new MouseEvent("mouseenter", { bubbles: true }),
		);
		panel.element.dispatchEvent(
			new MouseEvent("mouseleave", { bubbles: true }),
		);
		await settle();

		expect(window.electronAPI.setWindowButtonVisibility).not.toHaveBeenCalled();
	});

	it("hides the standalone window on escape without toggling it", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { standalone: true },
		});
		await settle();

		wrapper.find(".todo-plan-panel").element.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle();

		expect(window.electronAPI.hideTodoPlanWindow).toHaveBeenCalledWith({
			activation: "preserve-current-app",
			preserveMainWindowVisibility: true,
		});
		expect(window.electronAPI.toggleTodoPlanWindow).not.toHaveBeenCalled();
	});

	/**
	 * 草稿纸模式(2026-08-15 合并)。这一组钉的是"同一扇窗两种内容"的边界:
	 * 换过去之后 Todo 侧的一切(笔记按钮、格式条、⌘F/⌘P/⌘K/⌘N)必须整体退场,
	 * 换回来必须原样回来 —— 混在一起就是两个形态互相污染。
	 */
	describe("scratchpad mode", () => {
		async function mountStandalone() {
			const wrapper = mount(TodoPlanPanel, {
				attachTo: document.body,
				props: { standalone: true },
			});
			await settle();
			return wrapper;
		}

		/**
		 * 形态开关从标题栏的分段丸搬到了左侧图标轨(边栏 v2)。测试跟着按
		 * **可及名**找那两枚钮 —— 那是这两个入口对读屏与对测试的同一个名字。
		 */
		async function switchTo(wrapper: any, label: string) {
			const tooltip = label === "草稿纸" ? "草稿纸" : "待做 / 笔记";
			await wrapper.find(`.mode-rail [aria-label="${tooltip}"]`).trigger("click");
			await settle();
		}

		it("每窗口记一份形态,重挂时读回来", async () => {
			const wrapper = await mountStandalone();
			expect(wrapper.findComponent({ name: "TiptapNoteEditor" }).props("modelValue"))
				.toContain("# User Todo");

			await switchTo(wrapper, "草稿纸");

			expect(storage.todoPlanWindowMode).toBe("scratchpad");
			// 内嵌卡片那一份不受影响 —— 两个形态各记各的。
			expect(storage.todoPlanCardMode).toBeUndefined();
			wrapper.unmount();

			const reopened = await mountStandalone();
			expect(reopened.findComponent({ name: "TiptapNoteEditor" }).props("modelValue"))
				.toBe("纸上写了一句话");
		});

		it("切过去之后 Todo 侧的入口整体退场,切回来原样回来", async () => {
			const wrapper = await mountStandalone();

			await switchTo(wrapper, "草稿纸");

			expect(wrapper.find('[aria-label="更多操作"]').exists()).toBe(false);
			expect(wrapper.find('[aria-label="Browse notes"]').exists()).toBe(false);
			expect(wrapper.find('[aria-label="New note"]').exists()).toBe(false);
			expect(wrapper.find('[aria-label="Show formatting bar"]').exists()).toBe(false);
			expect(wrapper.find('[aria-label="Send scratchpad content"]').exists()).toBe(true);
			expect(wrapper.find(".window-title").text()).toBe("草稿纸");

			// ⌘K 在草稿纸上不该唤出命令面板 —— 那是笔记的东西。
			wrapper.find(".todo-plan-panel").element.dispatchEvent(
				new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
			);
			await settle();
			expect(wrapper.find(".todo-notes-action-panel").exists()).toBe(false);

			await switchTo(wrapper, "Todo");

			expect(wrapper.find('[aria-label="更多操作"]').exists()).toBe(true);
			expect(wrapper.find('[aria-label="Send scratchpad content"]').exists()).toBe(false);
			expect(wrapper.findComponent({ name: "TiptapNoteEditor" }).props("modelValue"))
				.toContain("# User Todo");
		});

		it("纸上的编辑写进 scratchpad store,不走 todo 的保存路", async () => {
			const wrapper = await mountStandalone();
			await switchTo(wrapper, "草稿纸");
			(window.electronAPI as any).updateTodoPlan.mockClear();

			await wrapper.find(".mock-editor").setValue("又想到一句");
			await settle();

			expect(mocks.scratchpadStore.setContent).toHaveBeenCalledWith("session-1", "又想到一句");
			expect((window.electronAPI as any).updateTodoPlan).not.toHaveBeenCalled();
		});

		it("⌘⏎ 把水位之后的内容直发成一条 send-message", async () => {
			const wrapper = await mountStandalone();
			await switchTo(wrapper, "草稿纸");

			wrapper.find(".mock-editor").element.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
			);
			await settle();

			// 先落盘再发:模型下一轮读到的那份必须已经含这段话。
			expect(mocks.scratchpadStore.flushNow).toHaveBeenCalledWith("session-1");
			expect((window.electronAPI as any).emitCommand).toHaveBeenCalledWith("session-1", {
				type: "command:send-message",
				content: "纸上写了一句话",
			});
		});

		it("有选区就只发选区", async () => {
			const wrapper = await mountStandalone();
			await switchTo(wrapper, "草稿纸");
			mocks.editorSelectedText.mockReturnValue("只发这一句");

			await wrapper.find('[aria-label="Send scratchpad content"]').trigger("click");
			await settle();

			expect((window.electronAPI as any).emitCommand).toHaveBeenCalledWith("session-1", {
				type: "command:send-message",
				content: "只发这一句",
			});
		});

		it("空纸时发送钮是关的", async () => {
			mocks.scratchpadRecord.content = "   ";
			const wrapper = await mountStandalone();
			await switchTo(wrapper, "草稿纸");

			expect(
				wrapper.find('[aria-label="Send scratchpad content"]').attributes("disabled"),
			).toBeDefined();
		});

		/**
		 * 跨窗口信号:composer 的草稿纸钮在主窗里写键,这扇窗靠 `storage` 事件跟上。
		 * 这是两个渲染进程之间唯一不需要后端改动的通道。
		 */
		it("别的窗口写了形态键,这扇窗跟着切", async () => {
			const wrapper = await mountStandalone();
			expect(wrapper.find(".window-title").text()).toBe("待做");

			window.dispatchEvent(
				new StorageEvent("storage", { key: "todoPlanWindowMode", newValue: "scratchpad" }),
			);
			await settle();

			expect(wrapper.find(".window-title").text()).toBe("草稿纸");
			// 跟随不回写:写的那一边已经落过盘了,再写一次只会多一次事件。
			expect(storage.todoPlanWindowMode).toBeUndefined();
		});
	});

	/**
	 * 边栏 v2 的信息面(2026-08-15)。这一组钉的是"读数不许说谎":
	 * 没有任务就不报 0/0、水位没事件就不说已读、时机判不了就把那一行关掉。
	 */
	describe("信息面", () => {
		async function mountWindow() {
			const wrapper = mount(TodoPlanPanel, {
				attachTo: document.body,
				props: { standalone: true },
			});
			await settle();
			return wrapper;
		}

		async function toScratchpad(wrapper: any) {
			await wrapper.find('.mode-rail [aria-label="草稿纸"]').trigger("click");
			await settle();
		}

		it("Todo 侧报 done / total,并把它换算成进度条宽度", async () => {
			const wrapper = await mountWindow();

			// 样本笔记是 `- [ ] Write tests` —— 一条,没做完。
			expect(wrapper.find(".progress-figure").text()).toBe("0/1");
			expect(
				(wrapper.find(".progress-fill").element as HTMLElement).style.width,
			).toBe("0%");
			expect(wrapper.find(".header-stat").text()).toBe("0 / 1 已完成");
		});

		it("没有任务的笔记不报 0 / 0 —— 改报字数", async () => {
			(window.electronAPI as any).getTodoPlan = vi.fn().mockResolvedValue({
				success: true,
				snapshot: {
					directory: snapshot.directory,
					userNotes: [{ ...snapshot.userNotes[0], content: "# 空笔记" }],
				},
			});

			const wrapper = await mountWindow();

			expect(wrapper.find(".header-stat").text()).toBe("5 字");
		});

		it("没有水位事件就不说已读", async () => {
			const wrapper = await mountWindow();
			await toScratchpad(wrapper);

			expect(wrapper.find(".state-line").text()).toBe("AI 尚未读过");
		});

		/**
		 * 水位本来就是**块边界**语义(偏移落在块中间时向后取整)。所以有块序时报
		 * 段号,报字数是给出一个比它实际知道的更精确的假象 —— 只有算不出块序时
		 * 才退回字数,退的是精度不是诚实。
		 */
		it("有块序就说第几段,算不出来才退回第几字", async () => {
			mocks.consumed.offset = 3;
			const wrapper = await mountWindow();
			await toScratchpad(wrapper);

			expect(wrapper.find(".state-line").text()).toBe("AI 已读至 3 字");

			wrapper
				.findComponent({ name: "TiptapNoteEditor" })
				.vm.$emit("watermark", { blockIndex: 1, blockCount: 4 });
			await settle();

			expect(wrapper.find(".state-line").text()).toBe("AI 读到第 2 段");
		});

		it("推送设置落在本窗口自己的键上,状态行跟着改口", async () => {
			const wrapper = await mountWindow();
			await toScratchpad(wrapper);

			expect(wrapper.findAll(".state-sub")[0].text()).toBe("手动推送");

			await wrapper.find('[aria-label="自动推送"]').trigger("click");
			await settle();

			expect(JSON.parse(storage.todoPlanWindowScratchpadPush).auto).toBe(true);
			// 纸上已经有没推过的内容 —— 一开就该开始倒计时,而不是干等下一次敲键。
			expect(wrapper.findAll(".state-sub")[0].text()).toBe("还有 5 秒后推送");
		});

		it("宿主查不到 AI 回复状态时,「时机」整行是真的关着的(inert),不是灰给你看", async () => {
			const wrapper = await mountWindow();
			await toScratchpad(wrapper);

			const timing = wrapper.findAll(".push-field")[0];
			expect(timing.classes()).toContain("is-off");
			expect(timing.attributes("inert")).toBeDefined();
		});
	});
});
