import fs from "node:fs";
import path from "node:path";
import type {
	CorePromptCapture,
	CoreRequestMessage,
	CoreEvalRawRequest,
	CoreEvalRawResponse,
} from "@onething/core/engine";
import { hashSections } from "./section-hash.js";
import {
	getOnethingEvalsFixturesAutoDir,
	type OnethingStorePathOptions,
} from "../storage/paths.js";

import { getLogger } from '../logging/index.js'

const log = getLogger('evals')

export interface SnapshotRefs {
	promptSnapshotRef: string | null;
	contextSnapshotRef: string | null;
	requestSnapshotRef: string | null;
	responseSnapshotRef: string | null;
}

/** Per-section cap for .prompt.json, aligned with AGENTS_MAX_BYTES. */
const SECTION_MAX_CHARS = 32 * 1024;
/** Default total cap for .context.jsonl (design §7). */
const CONTEXT_MAX_BYTES_DEFAULT = 2 * 1024 * 1024;

/**
 * Write a `.prompt.json` snapshot containing the full named sections
 * of the system prompt that was actually sent to the model.
 *
 * Returns the path relative to the fixtures auto dir, or null if
 * promptCapture is missing.
 */
export function writePromptSnapshot(options: {
	sessionId: string;
	turnId: string;
	promptCapture: CorePromptCapture;
	storeOptions?: OnethingStorePathOptions;
}): string | null {
	const dir = getOnethingEvalsFixturesAutoDir(options.storeOptions);
	fs.mkdirSync(dir, { recursive: true });

	const safeSessionId = options.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const safeTurnId = options.turnId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const date = new Date().toISOString().slice(0, 10);
	const baseName = `${date}-${safeSessionId.slice(0, 12)}-${safeTurnId.slice(0, 12)}`;
	const filename = `${baseName}.prompt.json`;
	const filePath = path.join(dir, filename);

	// Single authoritative joint-hash implementation (section-hash.ts);
	// computed from full section contents, before any snapshot truncation.
	const promptVersion = options.promptCapture.sections.length
		? hashSections(options.promptCapture.sections).promptVersion
		: "";

	const snapshot = buildPromptSnapshotObject(options.promptCapture, promptVersion);

	fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
	return filePath;
}

/**
 * Pure builder for the .prompt.json snapshot object. Shared with the
 * incident bundle writer so both artifacts keep an identical format.
 *
 * Caps oversized sections (skills lists, AGENTS.md). The hash is always
 * computed from the full content upstream, so a truncated section still
 * carries its true version identity.
 */
export function buildPromptSnapshotObject(
	promptCapture: CorePromptCapture,
	promptVersion?: string,
): {
	version: 1;
	capturedAt: string;
	promptVersion: string;
	sections: Array<{ name: string; hash: string; content: string }>;
	truncated: string[];
} {
	const resolvedVersion =
		promptVersion ??
		(promptCapture.sections.length
			? hashSections(promptCapture.sections).promptVersion
			: "");

	const truncated: string[] = [];
	const sections = promptCapture.sections.map((s) => {
		if (s.content.length <= SECTION_MAX_CHARS) {
			return {
				name: s.name,
				hash: promptCapture.sectionHashes[s.name] ?? "",
				content: s.content,
			};
		}
		truncated.push(s.name);
		return {
			name: s.name,
			hash: promptCapture.sectionHashes[s.name] ?? "",
			content: `${s.content.slice(0, SECTION_MAX_CHARS)}\n\n<!-- section truncated for snapshot -->`,
		};
	});

	return {
		version: 1,
		capturedAt: new Date().toISOString(),
		promptVersion: resolvedVersion,
		sections,
		truncated,
	};
}

/**
 * Write a `.context.jsonl` snapshot containing the request-view messages
 * (capability-transformed, whitelist-serialized).
 *
 * First line is a header record; subsequent lines are one per message.
 * Returns the path relative to the fixtures auto dir, or null if no
 * messages are available.
 */
export function writeContextSnapshot(options: {
	sessionId: string;
	turnId: string;
	requestMessages: CoreRequestMessage[];
	maxBytes?: number;
	storeOptions?: OnethingStorePathOptions;
}): string | null {
	if (!options.requestMessages.length) return null;

	const dir = getOnethingEvalsFixturesAutoDir(options.storeOptions);
	fs.mkdirSync(dir, { recursive: true });

	const safeSessionId = options.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const safeTurnId = options.turnId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const date = new Date().toISOString().slice(0, 10);
	const baseName = `${date}-${safeSessionId.slice(0, 12)}-${safeTurnId.slice(0, 12)}`;
	const filename = `${baseName}.context.jsonl`;
	const filePath = path.join(dir, filename);

	const content = buildContextSnapshotContent({
		sessionId: options.sessionId,
		turnId: options.turnId,
		requestMessages: options.requestMessages,
		maxBytes: options.maxBytes,
	});

	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

/**
 * Pure builder for the .context.jsonl snapshot content. Shared with the
 * incident bundle writer so both artifacts keep an identical format.
 */
export function buildContextSnapshotContent(options: {
	sessionId: string;
	turnId: string;
	requestMessages: CoreRequestMessage[];
	maxBytes?: number;
	/** True when rebuilt from persisted session messages (storage view). */
	synthesized?: boolean;
}): string {
	// Header line
	const header =
		JSON.stringify({
			v: 2,
			sessionId: options.sessionId,
			kind: "evals-context",
			turnId: options.turnId,
			capturedAt: new Date().toISOString(),
			...(options.synthesized ? { synthesized: true } : {}),
		}) + "\n";

	// Message lines
	const messageLines: string[] = [];
	for (let seq = 1; seq <= options.requestMessages.length; seq++) {
		const m = options.requestMessages[seq - 1];
		try {
			// Serialize through JSON to deep-clone and strip non-JSON values
			const serialized = JSON.parse(JSON.stringify(m));
			messageLines.push(JSON.stringify({ seq, m: serialized }) + "\n");
		} catch {
			// Skip messages that can't be serialized (e.g. circular refs)
			messageLines.push(
				JSON.stringify({
					seq,
					m: { role: m.role, content: "[non-serializable content omitted]" },
				}) + "\n",
			);
		}
	}

	// Total-size cap (design §7): keep the header, the first message, and as
	// much of the tail as fits; replace the middle with an omitted marker.
	// A capped snapshot is readable evidence but not a complete replay source.
	const maxBytes = options.maxBytes ?? CONTEXT_MAX_BYTES_DEFAULT;
	let body: string[];
	const totalBytes = messageLines.reduce(
		(sum, line) => sum + Buffer.byteLength(line, "utf-8"),
		0,
	);
	if (totalBytes <= maxBytes) {
		body = messageLines;
	} else {
		const first = messageLines[0];
		let budget =
			maxBytes - Buffer.byteLength(first, "utf-8") - 128; /* marker slack */
		const tail: string[] = [];
		for (let i = messageLines.length - 1; i >= 1; i--) {
			const size = Buffer.byteLength(messageLines[i], "utf-8");
			if (size > budget) break;
			budget -= size;
			tail.unshift(messageLines[i]);
		}
		const omitted = messageLines.length - 1 - tail.length;
		body =
			omitted > 0
				? [first, JSON.stringify({ omitted }) + "\n", ...tail]
				: [first, ...tail];
	}

	return header + body.join("");
}

/**
 * Write all available snapshots and return the refs.
 */
export function writeCaptureSnapshots(options: {
	sessionId: string;
	turnId: string;
	promptCapture?: CorePromptCapture;
	/** Total-size cap for .context.jsonl (settings.evals.snapshotMaxBytes). */
	contextMaxBytes?: number;
	storeOptions?: OnethingStorePathOptions;
}): SnapshotRefs {
	const refs: SnapshotRefs = {
		promptSnapshotRef: null,
		contextSnapshotRef: null,
		requestSnapshotRef: null,
		responseSnapshotRef: null,
	};

	if (!options.promptCapture) return refs;

	try {
		refs.promptSnapshotRef = writePromptSnapshot({
			sessionId: options.sessionId,
			turnId: options.turnId,
			promptCapture: options.promptCapture,
			storeOptions: options.storeOptions,
		});
	} catch (err) {
		log.error("prompt snapshot write failed", undefined, err);
	}

	try {
		if (options.promptCapture.requestMessages?.length) {
			refs.contextSnapshotRef = writeContextSnapshot({
				sessionId: options.sessionId,
				turnId: options.turnId,
				requestMessages: options.promptCapture.requestMessages,
				maxBytes: options.contextMaxBytes,
				storeOptions: options.storeOptions,
			});
		}
	} catch (err) {
		log.error("context snapshot write failed", undefined, err);
	}

	try {
		if (options.promptCapture.rawRequest) {
			refs.requestSnapshotRef = writeRequestSnapshot({
				sessionId: options.sessionId,
				turnId: options.turnId,
				rawRequest: options.promptCapture.rawRequest,
				storeOptions: options.storeOptions,
			});
		}
	} catch (err) {
		log.error("request snapshot write failed", undefined, err);
	}

	try {
		if (options.promptCapture.rawResponse) {
			refs.responseSnapshotRef = writeResponseSnapshot({
				sessionId: options.sessionId,
				turnId: options.turnId,
				rawResponse: options.promptCapture.rawResponse,
				storeOptions: options.storeOptions,
			});
		}
	} catch (err) {
		log.error("response snapshot write failed", undefined, err);
	}

	return refs;
}

/**
 * Write a `.request.json` snapshot containing the full API request body.
 */
export function writeRequestSnapshot(options: {
	sessionId: string;
	turnId: string;
	rawRequest: CoreEvalRawRequest;
	storeOptions?: OnethingStorePathOptions;
}): string | null {
	const dir = getOnethingEvalsFixturesAutoDir(options.storeOptions);
	fs.mkdirSync(dir, { recursive: true });

	const safeSessionId = options.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const safeTurnId = options.turnId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const date = new Date().toISOString().slice(0, 10);
	const baseName = `${date}-${safeSessionId.slice(0, 12)}-${safeTurnId.slice(0, 12)}`;
	const filename = `${baseName}.request.json`;
	const filePath = path.join(dir, filename);

	const snapshot = {
		version: 2,
		capturedAt: new Date().toISOString(),
		model: options.rawRequest.model,
		// systemPrompt lives in .prompt.json (sectioned) and messages live in
		// .context.jsonl — duplicating them here doubled snapshot volume
		// (measured 17.4MB of 39MB). This file keeps only the request params
		// that exist nowhere else.
		messagesRef: "see .context.jsonl",
		systemPromptRef: "see .prompt.json",
		messageCount: options.rawRequest.messages?.length ?? 0,
		tools: options.rawRequest.tools,
		toolChoice: options.rawRequest.toolChoice,
		temperature: options.rawRequest.temperature,
		maxTokens: options.rawRequest.maxTokens,
	};

	// Safe-serialize: strip non-JSON values (functions, symbols, circular refs)
	// that may leak from engine internals.
	let safe: unknown;
	try {
		safe = JSON.parse(JSON.stringify(snapshot));
	} catch {
		// Fall back to raw write if circular refs prevent stringify
		safe = snapshot;
	}
	fs.writeFileSync(filePath, JSON.stringify(safe, null, 2), "utf-8");
	return filePath;
}

/**
 * Write a `.response.json` snapshot containing the full API response body.
 */
export function writeResponseSnapshot(options: {
	sessionId: string;
	turnId: string;
	rawResponse: CoreEvalRawResponse;
	storeOptions?: OnethingStorePathOptions;
}): string | null {
	const dir = getOnethingEvalsFixturesAutoDir(options.storeOptions);
	fs.mkdirSync(dir, { recursive: true });

	const safeSessionId = options.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const safeTurnId = options.turnId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const date = new Date().toISOString().slice(0, 10);
	const baseName = `${date}-${safeSessionId.slice(0, 12)}-${safeTurnId.slice(0, 12)}`;
	const filename = `${baseName}.response.json`;
	const filePath = path.join(dir, filename);

	const snapshot = {
		version: 1,
		capturedAt: new Date().toISOString(),
		content: options.rawResponse.content,
		toolCalls: options.rawResponse.toolCalls,
		finishReason: options.rawResponse.finishReason,
		usage: options.rawResponse.usage,
	};

	// Safe-serialize: strip non-JSON values (functions, symbols, circular refs)
	let safe: unknown;
	try {
		safe = JSON.parse(JSON.stringify(snapshot));
	} catch {
		safe = snapshot;
	}
	fs.writeFileSync(filePath, JSON.stringify(safe, null, 2), "utf-8");
	return filePath;
}
