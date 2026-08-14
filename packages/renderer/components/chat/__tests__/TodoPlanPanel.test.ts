// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import TodoPlanPanel from "../TodoPlanPanel.vue";

const mocks = vi.hoisted(() => ({
	sessionsStore: {
		currentSessionId: "session-1",
		sessions: [{ id: "session-1", workingDirectory: "/repo" }],
	},
	editorFocus: vi.fn(),
	editorSetSelection: vi.fn(),
	editorSetValue: vi.fn(),
	editorApplyCommand: vi.fn(),
}));

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

vi.mock("@/editor/MarkdownDocumentEditor.vue", () => ({
	default: {
		name: "MarkdownDocumentEditor",
		props: [
			"features",
			"modelValue",
			"surface",
			"documentId",
			"documentPath",
			"workspaceRoot",
			"settings",
			"toolbar",
			"sourceToggle",
		],
		emits: [
			"update:modelValue",
			"keydown",
			"cancel",
			"paste",
			"openLink",
			"openImage",
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
				getSelectedText: () => "",
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
			setWindowButtonVisibility: vi.fn().mockResolvedValue({ success: true }),
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
		expect(wrapper.find('[aria-label="Command Panel"]').exists()).toBe(true);
		expect(
			wrapper.find(".panel-actions .icon-button").attributes("aria-label"),
		).toBe("Command Panel");
		expect(wrapper.find('[aria-label="Browse notes"]').exists()).toBe(true);
		expect(wrapper.find('[aria-label="New note"]').exists()).toBe(true);
		expect(wrapper.find('[aria-label="Unpin Todo"]').exists()).toBe(true);
		expect(wrapper.find('[aria-label="Find in note"]').exists()).toBe(false);
		expect(wrapper.find(".window-traffic-spacer").exists()).toBe(true);
		expect(wrapper.find(".window-title").exists()).toBe(true);
		expect(wrapper.find('[aria-label="Open in window"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Dock card"]').exists()).toBe(false);
		expect(wrapper.find(".resize-handle").exists()).toBe(false);
	});

	it("shows chat card controls in chat mode", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(wrapper.find('[aria-label="Command Panel"]').exists()).toBe(true);
		expect(wrapper.find('[aria-label="Browse notes"]').exists()).toBe(true);
		expect(wrapper.find('[aria-label="New note"]').exists()).toBe(true);
		expect(wrapper.find('[aria-label="Find in note"]').exists()).toBe(false);
		expect(wrapper.find('[aria-label="Pin Todo"]').exists()).toBe(true);
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
		expect(wrapper.find(".window-title").text()).toBe("User Todo");

		await wrapper.find(".window-title").trigger("click");
		await settle();
		expect(wrapper.find(".note-switcher").exists()).toBe(false);

		await wrapper.find('[aria-label="Browse notes"]').trigger("click");
		await settle();
		expect(wrapper.find(".note-switcher").exists()).toBe(true);
	});

	it("keeps task counts out of the compact titlebar", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(wrapper.find(".window-title").text()).toBe("User Todo");
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

		await wrapper.find('[aria-label="Command Panel"]').trigger("click");
		await settle();

		expect(wrapper.find(".todo-notes-action-panel").exists()).toBe(true);
		expect(
			wrapper.find(".panel-actions .icon-button").attributes("aria-label"),
		).toBe("Command Panel");
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

	it("always uses the markdown live preview editor without a separate preview mode", async () => {
		const wrapper = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		const editor = wrapper.findComponent({ name: "MarkdownDocumentEditor" });

		expect(editor.props("surface")).toBe("todo-notes");
		expect(editor.props("features")).toMatchObject({
			tasks: true,
			tables: true,
			images: true,
			math: true,
		});
		expect(editor.props("sourceToggle")).toBe(false);
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
				.findComponent({ name: "MarkdownDocumentEditor" })
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

		expect(standalone.text()).toContain("AI Todo");
		expect(
			standalone.findComponent({ name: "MarkdownDocumentEditor" }).exists(),
		).toBe(true);

		standalone.unmount();

		const chatCard = mount(TodoPlanPanel, {
			attachTo: document.body,
			props: { sessionId: "session-1", workingDirectory: "/repo" },
		});
		await settle();

		expect(chatCard.find(".window-title").text()).toBe("User Todo");
		const chatEditor = chatCard.findComponent({
			name: "MarkdownDocumentEditor",
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
				.findComponent({ name: "MarkdownDocumentEditor" })
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

		const editor = wrapper.findComponent({ name: "MarkdownDocumentEditor" });
		expect(editor.props("modelValue")).toContain("Ship the refresh fix");
		expect(wrapper.find(".window-title").text()).toBe("AI Todo");
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

		const editor = wrapper.findComponent({ name: "MarkdownDocumentEditor" });
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
});
