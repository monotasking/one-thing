/**
 * Tests for the process-bound VariablesStore.
 *
 * P3(2026-09-18)删掉了那两个内置笔记目录,这份文件于是只剩「存自定义变量 +
 * 通知订阅者」两件事 —— 变更通知因此改用 `setGlobalVariables` 触发。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVariablesStoreForTests } from "../store-bound.js";
import { createDefaultVariablesFile } from "../schema.js";

const persistence = vi.hoisted(() => ({
	saved: undefined as unknown,
}));

vi.mock("../store-persistence.js", () => ({
	loadFromDisk: () =>
		persistence.saved ?? {
			global_variables: [],
		},
	saveToDisk: vi.fn((state: unknown) => {
		persistence.saved = JSON.parse(JSON.stringify(state));
	}),
}));

let store = resetVariablesStoreForTests();

beforeEach(() => {
	persistence.saved = undefined;
	store = resetVariablesStoreForTests();
	store.hydrateForTests(createDefaultVariablesFile());
});

describe("subscribe", () => {
	it("fires after every mutation", () => {
		let count = 0;
		const off = store.subscribe(() => count++);
		const set = (value: string): void =>
			store.setGlobalVariables([{ name: "x", value, scope: "global" }]);
		set("/x");
		set("/y");
		set("/w");
		expect(count).toBe(3);
		off();
		set("/z");
		expect(count).toBe(3); // unsubscribed
	});

	it("continues notifying when one listener throws", () => {
		const calls: string[] = [];
		store.subscribe(() => {
			throw new Error("boom");
		});
		store.subscribe(() => calls.push("ok"));
		const origErr = console.error;
		console.error = () => undefined;
		try {
			store.setGlobalVariables([{ name: "x", value: "1", scope: "global" }]);
		} finally {
			console.error = origErr;
		}
		expect(calls).toEqual(["ok"]);
	});
});
