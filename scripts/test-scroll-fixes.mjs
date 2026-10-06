#!/usr/bin/env node
/**
 * E2E test for scroll + pagination fixes.
 *
 * Usage:
 *   node scripts/test-scroll-fixes.mjs
 *
 * Requires:
 *   - Playwright installed (npx playwright install chromium)
 *
 * What it tests:
 *   1. Scroll-to-top (thumb drag) auto-loads without snap-back
 *   2. HasMoreAfter: scroll-to-bottom button visible + click reloads tail
 *   3. Cross-page nav trail: anchor-based loadMessagesAround API
 */

import { spawn } from "node:child_process";
import { statSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

// ── Config ──────────────────────────────────────────────────────────
const STORE_PATH = "/tmp/onething-test-store-e2e";
const BASE_URL = "http://127.0.0.1:5174";
const API_URL = "http://127.0.0.1:8787";
const TOTAL_TURNS = 300;

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";

let passed = 0;
let failed = 0;

function assert(name, condition, detail = "") {
	if (condition) {
		console.log(`  ${PASS} ${name}${detail ? `  (${detail})` : ""}`);
		passed++;
	} else {
		console.log(`  ${FAIL} ${name}${detail ? `  (${detail})` : ""}`);
		failed++;
	}
}

// ── Step 1: Create test data ────────────────────────────────────────
console.log("\n📦 Creating test session data...");

rmSync(STORE_PATH, { recursive: true, force: true });
const sessionsDir = join(STORE_PATH, "sessions");
const settingsDir = join(STORE_PATH, "settings");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(settingsDir, { recursive: true });

const now = Date.now();
const sessionId = "test-scroll-fixes";

function makeUserMsg(i) {
	return {
		id: `user-${i}`,
		seq: i * 2 - 1,
		role: "user",
		content:
			`User message #${i}. The quick brown fox jumps over the lazy dog. ` +
			`Question ${i}: Can you help me with this task? Some filler text to make ` +
			`each message tall enough for meaningful scroll behavior.`,
		timestamp: now - (TOTAL_TURNS - i) * 60000,
	};
}

function makeAssistantMsg(i) {
	return {
		id: `assistant-${i}`,
		seq: i * 2,
		role: "assistant",
		content:
			`Assistant response #${i}. Detailed help for question ${i}.\n\n` +
			`\`\`\`javascript\nconsole.log("message ${i}");\nconst x = ${i} * 2;\n\`\`\`\n\n` +
			`More explanation here. This makes the message taller.\n\n` +
			`## Summary\n- Point A for #${i}\n- Point B for #${i}\n- Point C for #${i}`,
		timestamp: now - (TOTAL_TURNS - i) * 60000 + 1000,
	};
}

const messages = [];
for (let i = 1; i <= TOTAL_TURNS; i++) {
	messages.push(makeUserMsg(i), makeAssistantMsg(i));
}

writeFileSync(
	join(sessionsDir, `${sessionId}.json`),
	JSON.stringify({
		id: sessionId,
		name: `Test Session (${TOTAL_TURNS} turns)`,
		messages,
		createdAt: now - TOTAL_TURNS * 120000,
		updatedAt: now,
		agentId: "default",
		permissionMode: "default",
		isPinned: false,
		isArchived: false,
		messageCount: messages.length,
		previewText: messages[0].content.slice(0, 80),
	}),
);

writeFileSync(
	join(sessionsDir, "index.json"),
	JSON.stringify(
		[
			{
				id: sessionId,
				name: `Test Session (${TOTAL_TURNS} turns)`,
				createdAt: now - TOTAL_TURNS * 120000,
				updatedAt: now,
				agentId: "default",
				permissionMode: "default",
				isPinned: false,
				isArchived: false,
				messageCount: messages.length,
				previewText: messages[0].content.slice(0, 80),
			},
		],
		null,
		2,
	),
);

writeFileSync(
	join(settingsDir, "settings.json"),
	JSON.stringify({
		general: { messageListDensity: "comfortable" },
		chat: {},
		storage: { sessionFormat: "legacy-json" },
	}),
);

const fileSizeKB = statSync(join(sessionsDir, `${sessionId}.json`)).size / 1024;
console.log(
	`  Created: ${TOTAL_TURNS * 2} messages, ${fileSizeKB.toFixed(0)} KB`,
);

// ── Step 2: Start dev server ────────────────────────────────────────
console.log("\n🚀 Starting dev server...");

const server = spawn("bun", ["run", "dev:web"], {
	cwd: process.cwd(),
	env: { ...process.env, ONETHING_STORE_PATH: STORE_PATH, ONETHING_CREDENTIALS_KEYRING: 'file' },
	stdio: ["ignore", "pipe", "pipe"],
});

// Wait for server (API) + frontend (Vite) to be ready
const ready = await new Promise((resolve) => {
	let apiReady = false;
	let frontendReady = false;
	const check = () => {
		fetch(`${API_URL}/api/capabilities`)
			.then((r) => {
				if (r.ok) apiReady = true;
			})
			.catch(() => {});
		fetch(`${BASE_URL}`)
			.then((r) => {
				if (r.ok) frontendReady = true;
			})
			.catch(() => {});
		if (apiReady && frontendReady) {
			resolve(true);
			return;
		}
		setTimeout(check, 500);
	};
	check();
	setTimeout(() => resolve(false), 120000);
});

if (!ready) {
	console.log("  ✗ Server failed to start within 30s");
	server.kill();
	process.exit(1);
}
console.log(`  ${PASS} Server ready at ${API_URL}`);

// ── Step 3: Run tests ───────────────────────────────────────────────
console.log("\n🧪 Running E2E tests...\n");

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
	await page.goto(BASE_URL);
	await page.waitForTimeout(3000);

	// Click session in sidebar
	const sessionItem = page
		.locator('[role="menuitem"]')
		.filter({ hasText: "Test Session (" });
	await sessionItem.click();
	await page.waitForTimeout(3000);

	const info = () =>
		page.evaluate(() => {
			const el = document.querySelector(".scrollbar-viewport");
			const msgs = document.querySelectorAll("[data-message-id]");
			const last = msgs.length
				? msgs[msgs.length - 1].dataset.messageId
				: "none";
			const first = msgs.length ? msgs[0].dataset.messageId : "none";
			const st = el?.scrollTop ?? 0;
			const sh = el?.scrollHeight ?? 0;
			const ch = el?.clientHeight ?? 0;
			return {
				msgCount: msgs.length,
				first,
				last,
				scrollTop: Math.round(st),
				scrollHeight: Math.round(sh),
				clientHeight: ch,
				distanceToBottom: Math.round(sh - st - ch),
				atBottom: Math.abs(st - (sh - ch)) < 10,
			};
		});

	// ── Test 1: Scroll to top without snap-back ──────────────────────
	console.log("── Test 1: Scroll-to-top (thumb drag, no wheel) ──");

	const init = await info();
	console.log(
		`  Initial: ${init.msgCount} msgs, atBottom=${init.atBottom}, first=${init.first}`,
	);

	const beforeCount = init.msgCount;

	// Simulate thumb drag: write scrollTop directly, only dispatch scroll (no wheel!)
	await page.evaluate(() => {
		const el = document.querySelector(".scrollbar-viewport");
		el.scrollTop = 0;
		el.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	await page.waitForTimeout(2000);

	const after1 = await info();
	console.log(
		`  After:  ${after1.msgCount} msgs, atBottom=${after1.atBottom}, first=${after1.first}, distanceToBottom=${after1.distanceToBottom}`,
	);

	assert(
		"Messages increased (auto-load triggered)",
		after1.msgCount > beforeCount,
		`${beforeCount} → ${after1.msgCount}`,
	);
	assert(
		"NOT at bottom (no snap-back)",
		!after1.atBottom,
		`distanceToBottom=${after1.distanceToBottom}px`,
	);

	// Do it 2 more times to verify consecutive loads
	for (let round = 2; round <= 3; round++) {
		const beforeRound = (await info()).msgCount;
		await page.evaluate(() => {
			const el = document.querySelector(".scrollbar-viewport");
			el.scrollTop = 0;
			el.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		await page.waitForTimeout(2000);
		const afterRound = await info();
		assert(
			`Round ${round}: messages loaded`,
			afterRound.msgCount > beforeRound,
			`${beforeRound} → ${afterRound.msgCount}`,
		);
		assert(
			`Round ${round}: not at bottom`,
			!afterRound.atBottom,
			`distanceToBottom=${afterRound.distanceToBottom}px`,
		);
	}

	// ── Test 2: HasMoreAfter scroll-to-bottom button ─────────────────
	console.log("\n── Test 2: HasMoreAfter / scroll-to-bottom ──");

	// Scroll to middle so we're not at tail
	await page.evaluate(() => {
		const el = document.querySelector(".scrollbar-viewport");
		el.scrollTop = el.scrollHeight / 2;
		el.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	await page.waitForTimeout(500);

	const btnInfo = await page.evaluate(() => {
		const btn = document.querySelector(".scroll-to-bottom-btn");
		if (!btn) return { exists: false };
		const style = window.getComputedStyle(btn);
		return { exists: true, opacity: style.opacity };
	});
	console.log(`  Button: exists=${btnInfo.exists}, opacity=${btnInfo.opacity}`);

	assert("Scroll-to-bottom button exists", btnInfo.exists);
	assert(
		"Button visible (opacity != 0)",
		btnInfo.exists && btnInfo.opacity !== "0",
	);

	// Click button — should reload tail
	if (btnInfo.exists) {
		await page.evaluate(() => {
			const btn = document.querySelector(".scroll-to-bottom-btn");
			btn.click();
		});
		await page.waitForTimeout(3000);
		const afterBtn = await info();
		console.log(
			`  After click: ${afterBtn.msgCount} msgs, last=${afterBtn.last}, atBottom=${afterBtn.atBottom}`,
		);
		assert(
			"Reloaded to real tail",
			afterBtn.last === "assistant-300" && afterBtn.atBottom,
			`last=${afterBtn.last}, atBottom=${afterBtn.atBottom}`,
		);
	}

	// ── Test 2.5: Cross-page nav + scroll down without snap ──────
	console.log("\n── Test 2.5: Cross-page nav trail → scroll down ──");

	// Navigate to user-1 via store API (simulating nav trail click)
	await page.evaluate(async () => {
		const app = document.querySelector("#app").__vue_app__;
		const pinia = app.config.globalProperties.$pinia;
		const chatStore = pinia._s.get("chat");
		const sid = "test-scroll-fixes";
		const markers = chatStore.sessionUserMarkers.get(sid);
		const navIdx = markers?.findIndex((m) => m.id === "user-1");
		const el = document.querySelector(".scrollbar-viewport");
		const child = el?.querySelector("[data-message-id]");
		let inst = child?.__vueParentComponent;
		while (inst && !inst.exposed?.scrollToMessage) inst = inst.parent;
		await inst.setupState.navigateToUserMessage(navIdx);
	});
	await page.waitForTimeout(3000);

	const afterNav = await info();
	console.log(`  After nav: ${afterNav.msgCount} msgs, first=${afterNav.first}`);
	assert(
		"Navigated to user-1",
		afterNav.first === "user-1",
		`first=${afterNav.first}`,
	);

	// Scroll down 500px with wheel
	await page.evaluate(async () => {
		const el = document.querySelector(".scrollbar-viewport");
		for (let i = 0; i < 5; i++) {
			el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, bubbles: true }));
			el.scrollTop = (el.scrollTop || 0) + 100;
			el.dispatchEvent(new Event("scroll", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 200));
		}
	});
	await page.waitForTimeout(2000);

	const afterScroll = await info();
	console.log(`  After scroll down: ${afterScroll.msgCount} msgs, first=${afterScroll.first}, scrollTop=${afterScroll.scrollTop}, atBottom=${afterScroll.atBottom}`);
	assert(
		"NOT snapped to bottom",
		!afterScroll.atBottom && afterScroll.first === "user-1",
		`first=${afterScroll.first}, atBottom=${afterScroll.atBottom}`,
	);

	// ── Test 3: Backend anchor pagination ────────────────────────────
	console.log("\n── Test 3: Backend anchor pagination (loadMessagesAround) ──");

	const anchorResp = await (
		await fetch(`${API_URL}/api/session-messages/page`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId,
				anchor: { messageId: "user-100", before: 4, after: 16 },
			}),
		})
	).json();

	console.log(
		`  API: success=${anchorResp.success}, messages=${anchorResp.messages?.length}, hasMoreBefore=${anchorResp.hasMoreBefore}, hasMoreAfter=${anchorResp.hasMoreAfter}`,
	);

	assert("API returns success", anchorResp.success === true);
	assert(
		"Returns correct window size",
		anchorResp.messages?.length === 21,
		`got ${anchorResp.messages?.length}`,
	);
	assert(
		"Target user-100 in results",
		anchorResp.messages?.some((m) => m.id === "user-100"),
	);
	assert("hasMoreBefore=true", anchorResp.hasMoreBefore === true);
	assert("hasMoreAfter=true", anchorResp.hasMoreAfter === true);
} finally {
	await browser.close();
	server.kill();
}

// ── Report ──────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`\n  Results: ${passed} passed, ${failed} failed`);
console.log(`  ${failed === 0 ? PASS + " ALL PASS" : FAIL + " SOME FAILED"}\n`);

process.exit(failed > 0 ? 1 : 0);
