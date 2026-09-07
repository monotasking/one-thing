import fs from "node:fs";
import {
	getOnethingEvalsOnlineRecordsPath,
	type OnethingStorePathOptions,
} from "../storage/paths.js";
import {
	type EvalFixture,
	type EvalAssistantResponse,
	createFixture,
	exportFixture,
} from "./fixture.js";
import type { CoreTemplateSkill } from "@onething/core/engine";

import type {
  TurnSignals,
  TurnEvalRecord,
} from "@shared/contracts/eval-record.js";
export type {
  TurnSignals,
  TurnEvalRecord,
} from "@shared/contracts/eval-record.js";

/**
 * Amended record for post-turn updates (retry/edit events).
 * Snapshot refs are present when the amend path materialized snapshots
 * from the prompt-capture LRU (normal turns don't persist snapshots at
 * turn end — see design D2; a late negative signal writes them here).
 */
export interface AmendSnapshotRefs {
	promptSnapshotRef?: string | null;
	contextSnapshotRef?: string | null;
	requestSnapshotRef?: string | null;
	responseSnapshotRef?: string | null;
}

interface AmendRecord extends AmendSnapshotRefs {
	amend: true;
	turnId: string;
	sessionId: string;
	retried?: boolean;
	editResent?: boolean;
	explicitDown?: boolean;
	/** Fixture exported late (👎 downvote materializes it after turn end). */
	fixtureRef?: string | null;
	/** Incident bundle created late (👎/retry after turn end). */
	incidentRef?: string | null;
}

const DEFAULT_SIGNALS: TurnSignals = {
	retried: false,
	editResent: false,
	permissionDenied: false,
	toolErrors: 0,
	streamAborted: false,
};

function ensureOnlineDir(options?: OnethingStorePathOptions): string {
	const recordsPath = getOnethingEvalsOnlineRecordsPath(options);
	const dir = recordsPath.slice(0, recordsPath.lastIndexOf("/"));
	fs.mkdirSync(dir, { recursive: true });
	return recordsPath;
}

function writeRecord(
	record: TurnEvalRecord | AmendRecord,
	options?: OnethingStorePathOptions,
): void {
	const filePath = ensureOnlineDir(options);
	fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

/**
 * Write the initial turn evaluation record at turn end.
 * Returns a function that can be called later to append an amend record.
 */
export function recordTurn(options: {
	turnId: string;
	sessionId: string;
	promptVersion: string;
	providerId: string;
	model: string;
	signals: Partial<TurnSignals>;
	workingDirectory?: string;
	workingDirectoryRoots?: string[];
	skills: CoreTemplateSkill[];
	toolNames?: string[];
	hasTools: boolean;
	platform?: string;
	voiceConversation?: boolean;
	agentId?: string;
	agentName?: string;
	userMessage: string;
	knownProjects?: {
		hasAny: boolean;
		entries: Array<{ path: string; displayPath: string; description: string }>;
	};
	assistantResponse?: EvalAssistantResponse;
	sectionHashes?: Record<string, string>;
	skeletonVersion?: string;
	incidentRef?: string | null;
	promptSnapshotRef?: string | null;
	contextSnapshotRef?: string | null;
	requestSnapshotRef?: string | null;
	responseSnapshotRef?: string | null;
	/**
	 * Probability of exporting a NORMAL (no negative signal) turn's fixture
	 * as a distribution sample. 0/undefined = off. Keep it low (~0.02) —
	 * this exists to let silent failures and the real task distribution
	 * into the funnel, not to fixture every turn.
	 */
	randomSampleRate?: number;
	/** Injectable random source for tests (default Math.random). */
	sampleRng?: () => number;
	storeOptions?: OnethingStorePathOptions;
}): void {
	const mergedSignals: TurnSignals = { ...DEFAULT_SIGNALS, ...options.signals };

	const hasNegativeSignal =
		mergedSignals.retried ||
		mergedSignals.editResent ||
		mergedSignals.streamAborted ||
		mergedSignals.toolErrors > 0;

	const sampled =
		!hasNegativeSignal &&
		(options.randomSampleRate ?? 0) > 0 &&
		(options.sampleRng ?? Math.random)() < (options.randomSampleRate ?? 0);

	// Auto-export fixture for turns with negative signals *before* writing the
	// record, so exactly one record is ever written per turn (with fixtureRef
	// already populated) instead of a placeholder followed by amends/duplicates
	// that downstream readers (e.g. scripts/diagnose-weekly.mjs) would double-count.
	let fixtureRef: string | null = null;
	if (hasNegativeSignal || sampled) {
		const fixture = createFixture({
			workingDirectory: options.workingDirectory,
			workingDirectoryRoots: options.workingDirectoryRoots,
			knownProjects: options.knownProjects,
			skills: options.skills,
			toolNames: options.toolNames,
			hasTools: options.hasTools,
			platform: options.platform,
			voiceConversation: options.voiceConversation,
			agentId: options.agentId,
			agentName: options.agentName,
			providerId: options.providerId,
			model: options.model,
			userMessage: options.userMessage,
			sessionId: options.sessionId,
			turnId: options.turnId,
			assistantResponse: options.assistantResponse,
			promptSnapshotRef: options.promptSnapshotRef,
			contextSnapshotRef: options.contextSnapshotRef,
			requestSnapshotRef: options.requestSnapshotRef,
			responseSnapshotRef: options.responseSnapshotRef,
		});
		fixtureRef = exportFixture(fixture, options.storeOptions);
	}

	const record: TurnEvalRecord = {
		ts: new Date().toISOString(),
		sessionId: options.sessionId,
		turnId: options.turnId,
		promptVersion: options.promptVersion,
		skeletonVersion: options.skeletonVersion,
		sectionHashes: options.sectionHashes,
		provider: options.providerId,
		model: options.model,
		signals: mergedSignals,
		explicit: null,
		judge: null,
		sampled: sampled || undefined,
		fixtureRef,
		incidentRef: options.incidentRef ?? null,
		promptSnapshotRef: options.promptSnapshotRef ?? null,
		contextSnapshotRef: options.contextSnapshotRef ?? null,
		requestSnapshotRef: options.requestSnapshotRef ?? null,
		responseSnapshotRef: options.responseSnapshotRef ?? null,
	};

	writeRecord(record, options.storeOptions);
}
export function amendTurnRetry(options: {
	turnId: string;
	sessionId: string;
	snapshotRefs?: AmendSnapshotRefs;
	incidentRef?: string | null;
	storeOptions?: OnethingStorePathOptions;
}): void {
	const amend: AmendRecord = {
		amend: true,
		turnId: options.turnId,
		sessionId: options.sessionId,
		retried: true,
		incidentRef: options.incidentRef,
		...options.snapshotRefs,
	};
	writeRecord(amend, options.storeOptions);
}

/**
 * Amend a turn record when an edit-and-resend occurs after turn end.
 */
export function amendTurnEditResend(options: {
	turnId: string;
	sessionId: string;
	snapshotRefs?: AmendSnapshotRefs;
	incidentRef?: string | null;
	storeOptions?: OnethingStorePathOptions;
}): void {
	const amend: AmendRecord = {
		amend: true,
		turnId: options.turnId,
		sessionId: options.sessionId,
		editResent: true,
		incidentRef: options.incidentRef,
		...options.snapshotRefs,
	};
	writeRecord(amend, options.storeOptions);
}

/**
 * Record an explicit 👎 downvote with fixture export.
 */
export function recordExplicitDown(options: {
	turnId: string;
	sessionId: string;
	providerId: string;
	model: string;
	userMessage: string;
	workingDirectory?: string;
	workingDirectoryRoots?: string[];
	skills: CoreTemplateSkill[];
	toolNames?: string[];
	hasTools: boolean;
	platform?: string;
	voiceConversation?: boolean;
	agentId?: string;
	agentName?: string;
	knownProjects?: {
		hasAny: boolean;
		entries: Array<{ path: string; displayPath: string; description: string }>;
	};
	assistantResponse?: EvalAssistantResponse;
	incidentRef?: string | null;
	promptSnapshotRef?: string | null;
	contextSnapshotRef?: string | null;
	requestSnapshotRef?: string | null;
	responseSnapshotRef?: string | null;
	storeOptions?: OnethingStorePathOptions;
}): string {
	const fixture = createFixture({
		workingDirectory: options.workingDirectory,
		workingDirectoryRoots: options.workingDirectoryRoots,
		knownProjects: options.knownProjects,
		skills: options.skills,
		toolNames: options.toolNames,
		hasTools: options.hasTools,
		platform: options.platform,
		voiceConversation: options.voiceConversation,
		agentId: options.agentId,
		agentName: options.agentName,
		providerId: options.providerId,
		model: options.model,
		userMessage: options.userMessage,
		sessionId: options.sessionId,
		turnId: options.turnId,
		assistantResponse: options.assistantResponse,
		promptSnapshotRef: options.promptSnapshotRef,
		contextSnapshotRef: options.contextSnapshotRef,
		requestSnapshotRef: options.requestSnapshotRef,
		responseSnapshotRef: options.responseSnapshotRef,
	});
	const fixturePath = exportFixture(fixture, options.storeOptions);

	// The turn already has its record (written at turn end by the trigger).
	// A downvote is a late explicit signal on that SAME turn — write an amend
	// that loadMergedRecords folds back in, instead of a second full record
	// that would double-count the turn and split its data across two rows
	// (sectionHashes/promptVersion on one, fixture/snapshots on the other).
	const amend: AmendRecord = {
		amend: true,
		turnId: options.turnId,
		sessionId: options.sessionId,
		explicitDown: true,
		fixtureRef: fixturePath,
		incidentRef: options.incidentRef,
		promptSnapshotRef: options.promptSnapshotRef,
		contextSnapshotRef: options.contextSnapshotRef,
		requestSnapshotRef: options.requestSnapshotRef,
		responseSnapshotRef: options.responseSnapshotRef,
	};
	writeRecord(amend, options.storeOptions);
	return fixturePath;
}
export function hasNegativeSignals(signals: TurnSignals): boolean {
	return (
		signals.retried ||
		signals.editResent ||
		signals.toolErrors > 0 ||
		signals.streamAborted
	);
}
