import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CoreTemplateSkill } from "@onething/core/engine";
import type { CoreSystemPromptSnapshot } from "../prompts/system-prompt-snapshot.js";
import {
	getOnethingEvalsFixturesAutoDir,
	type OnethingStorePathOptions,
} from "../storage/paths.js";
import {
	ONETHING_DEFAULT_SYSTEM_PROMPT,
	ONETHING_KNOWN_PROJECTS_INSTRUCTIONS,
} from "../prompts/system-prompt.js";
import { hashSections } from "./section-hash.js";

/**
 * Serializable subset of the prompt context for fixture reproduction.
 */
export interface EvalFixtureContext {
	workingDirectory?: string;
	workingDirectoryRoots?: string[];
	knownProjects?: {
		hasAny: boolean;
		entries: Array<{ path: string; displayPath: string; description: string }>;
	};
	skills: Array<{
		name: string;
		description: string;
		source: string;
		category?: string;
		enabled?: boolean;
		path?: string;
	}>;
	toolNames: string[];
	hasTools: boolean;
	platform: string;
	voiceConversation?: boolean;
	agentId?: string;
	agentName?: string;
}

/** Serializable assistant response captured in the fixture for debugging. */
export interface EvalAssistantResponse {
	/** Final text content of the assistant message. */
	content: string;
	/** Tool calls made by the assistant in this turn. */
	toolCalls?: Array<{
		name: string;
		args?: Record<string, unknown>;
	}>;
	/** Finish reason if available ("stop", "tool_calls", "length", etc.). */
	finishReason?: string;
}

export interface EvalFixture {
	version: 1;
	capturedAt: string;
	promptVersion: string;
	provider: string;
	model: string;
	context: EvalFixtureContext;
	userMessage: string;
	/** What the assistant actually returned in this turn (text + tool calls). */
	assistantResponse?: EvalAssistantResponse;
	sessionRef: { sessionId: string; turnId: string };
	/** Reference to the .prompt.json snapshot (system prompt sections). */
	promptSnapshotRef?: string;
	/** Reference to the .context.jsonl snapshot (message history). */
	contextSnapshotRef?: string;
	/** Reference to the .request.json snapshot (full API request body). */
	requestSnapshotRef?: string;
	/** Reference to the .response.json snapshot (full API response body). */
	responseSnapshotRef?: string;
}

/**
 * Compute a stable promptVersion from the fixed constants that define
 * the "skeleton" of the system prompt. This is a static fallback;
 * call initPromptVersion() with actual minimal scene output for the
 * production path (matches the design: hash of Phase 0 minimal scene).
 */
export function computeStaticPromptVersion(): string {
	// Tool guidelines / workspace rules left this skeleton when they moved onto
	// the tools (2026-08-18): they are part of the tool surface now, and the
	// section-level version (`versionFromSections`) already sees them.
	const skeleton = [
		ONETHING_DEFAULT_SYSTEM_PROMPT,
		ONETHING_KNOWN_PROJECTS_INSTRUCTIONS ?? "",
	].join("\n");
	return createHash("sha256").update(skeleton).digest("hex").slice(0, 8);
}

let _cachedPromptVersion: string | undefined;

/**
 * Initialize the prompt version from the actual minimal scene output.
 * Per the design doc: hash of Phase 0 minimal scene output (sha256, first 8 chars).
 * Call this during app startup after the prompt builder is available.
 */
export function initPromptVersion(minimalSceneOutput: string): void {
	_cachedPromptVersion = createHash("sha256")
		.update(minimalSceneOutput)
		.digest("hex")
		.slice(0, 8);
}

/** Lazily compute and cache the promptVersion. */
export function getPromptVersion(): string {
	if (!_cachedPromptVersion) {
		_cachedPromptVersion = computeStaticPromptVersion();
	}
	return _cachedPromptVersion;
}

/**
 * Return the skeleton version — the static skeleton hash that serves as a
 * coarse cross-session grouping key. Backward-compatible with old records
 * that only had this value as promptVersion.
 */
export function getSkeletonVersion(): string {
	return computeStaticPromptVersion();
}

/**
 * Compute promptVersion from named prompt sections.
 * This is the session-level version that captures the actual prompt
 * the model saw, including directory-specific AGENTS.md content.
 * Falls back to the cached skeleton version when sections are empty.
 */
export function versionFromSections(
	sections: Array<{ name: string; content: string }>,
): string {
	if (sections.length === 0) return getPromptVersion();
	return hashSections(sections).promptVersion;
}

/**
 * Strip non-serializable fields from skills list.
 */
function stripSkills(
	skills: CoreTemplateSkill[],
): EvalFixtureContext["skills"] {
	return skills
		.filter((s) => s.enabled !== false)
		.map((s) => ({
			name: s.name,
			description: s.description,
			source: s.source,
			category: s.category,
			enabled: s.enabled,
			path: s.path,
		}));
}

/**
 * Extract fixture context from a system prompt snapshot (Phase 1 integration).
 * Bridges the snapshot system (debug display) and eval fixture system (replay).
 * Per design doc: fixture export reuses snapshot's context collection pipeline.
 */
export function fixtureContextFromSnapshot(
	snapshot: CoreSystemPromptSnapshot,
	userMessage: string,
): {
	provider: string;
	model: string;
	context: EvalFixtureContext;
	userMessage: string;
} {
	return {
		provider: snapshot.providerId,
		model: snapshot.model,
		context: {
			workingDirectory: snapshot.workingDirectory,
			skills: snapshot.skills.items.map((s) => ({
				name: s.name,
				description: s.description,
				source: s.source,
				category: s.category,
				enabled: s.enabled,
				path: s.path,
			})),
			toolNames: snapshot.tools.builtin.map((t) => t.name),
			hasTools: snapshot.tools.hasTools,
			platform: process.platform,
			agentId: snapshot.agentId,
			agentName: snapshot.agentName,
		},
		userMessage,
	};
}

/**
 * Create a serializable eval fixture from the prompt context.
 */
export function createFixture(options: {
	workingDirectory?: string;
	workingDirectoryRoots?: string[];
	knownProjects?: EvalFixtureContext["knownProjects"];
	skills: CoreTemplateSkill[];
	toolNames?: string[];
	hasTools: boolean;
	platform?: string;
	voiceConversation?: boolean;
	agentId?: string;
	agentName?: string;
	providerId: string;
	model: string;
	userMessage: string;
	sessionId: string;
	turnId: string;
	assistantResponse?: EvalAssistantResponse;
	promptSnapshotRef?: string | null;
	contextSnapshotRef?: string | null;
	requestSnapshotRef?: string | null;
	responseSnapshotRef?: string | null;
}): EvalFixture {
	return {
		version: 1,
		capturedAt: new Date().toISOString(),
		promptVersion: getPromptVersion(),
		provider: options.providerId,
		model: options.model,
		context: {
			workingDirectory: options.workingDirectory,
			workingDirectoryRoots: options.workingDirectoryRoots,
			knownProjects: options.knownProjects,
			skills: stripSkills(options.skills),
			toolNames: options.toolNames ?? [],
			hasTools: options.hasTools,
			platform: options.platform ?? process.platform,
			voiceConversation: options.voiceConversation,
			agentId: options.agentId,
			agentName: options.agentName,
		},
		userMessage: options.userMessage,
		assistantResponse: options.assistantResponse,
		sessionRef: {
			sessionId: options.sessionId,
			turnId: options.turnId,
		},
		promptSnapshotRef: options.promptSnapshotRef ?? undefined,
		contextSnapshotRef: options.contextSnapshotRef ?? undefined,
		requestSnapshotRef: options.requestSnapshotRef ?? undefined,
		responseSnapshotRef: options.responseSnapshotRef ?? undefined,
	};
}

/**
 * Write a fixture to the auto-export directory.
 * Returns the file path of the written fixture.
 */
export function exportFixture(
	fixture: EvalFixture,
	storeOptions?: OnethingStorePathOptions,
): string {
	const dir = getOnethingEvalsFixturesAutoDir(storeOptions);
	fs.mkdirSync(dir, { recursive: true });

	const date = new Date().toISOString().slice(0, 10);
	const safeSessionId = fixture.sessionRef.sessionId.replace(
		/[^a-zA-Z0-9_-]/g,
		"_",
	);
	const safeTurnId = fixture.sessionRef.turnId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const filename = `${date}-${safeSessionId.slice(0, 12)}-${safeTurnId.slice(0, 12)}.json`;
	const filePath = path.join(dir, filename);

	fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2), "utf-8");
	return filePath;
}
