export {
	createFixture,
	exportFixture,
	fixtureContextFromSnapshot,
	computeStaticPromptVersion,
	initPromptVersion,
	getPromptVersion,
	getSkeletonVersion,
	versionFromSections,
	type EvalFixture,
	type EvalFixtureContext,
	type EvalAssistantResponse,
} from "./eval-fixture.js";

export { hashSections } from "./eval-section-hash.js";
export {
	writeCaptureSnapshots,
	writePromptSnapshot,
	writeContextSnapshot,
	writeRequestSnapshot,
	writeResponseSnapshot,
} from "./eval-snapshot.js";
export type { SnapshotRefs } from "./eval-snapshot.js";
export { promptCaptureCache } from "./eval-prompt-capture-cache.js";
export {
	saveCaptureToDisk,
	loadCaptureFromDisk,
	pruneCaptureRing,
	getCapturesDir,
} from "./eval-capture-store.js";
export {
	createTurnTraceRecorder,
	readTraceRounds,
	readTraceRoundsFromDir,
	pruneTraceRing,
	getTracesDir,
	getTurnTraceDir,
	type TurnTraceRecorder,
	type TraceRoundRecord,
	type HydratedTraceRound,
} from "./eval-trace-store.js";
export {
	replayRound,
	tracedMessagesToEvalMessages,
	type RoundReplayAttempt,
	type RoundReplayResult,
} from "./eval-round-replay.js";

export {
	recordTurn,
	amendTurnRetry,
	amendTurnEditResend,
	recordExplicitDown,
	hasNegativeSignals,
} from "./eval-turn-evaluator.js";

export {
	buildJudgePrompt,
	buildJudgeUserMessage,
	parseJudgeOutput,
	JUDGE_CATEGORIES,
	type JudgeResult,
	type JudgeInput,
	type JudgeCategory,
} from "./eval-judge.js";

export {
	evaluate,
	evaluateHard,
	KNOWN_EXPECT_KEYS,
	type EvalExpectation,
	type EvalResponse,
	type EvalResult,
} from "./eval-evaluator.js";

export {
	loadMergedRecords,
	filterRecordsByWeeks,
	recordHasNegative,
	categorizeRecord,
	generateTriageReport,
	CATEGORY_TO_SECTION,
	type LoadMergedRecordsOptions,
} from "./eval-records.js";

export {
	parseCaseFile,
	parseCaseYaml,
	generateCaseYaml,
	type CaseDefinition,
} from "./eval-case-file.js";

export type {
	EvalChatMessage,
	EvalToolDef,
	EvalModelResponse,
	EvalModelCallOptions,
	EvalModelCaller,
} from "./eval-model-call.js";

export {
	runEvals,
	type EvalRunOptions,
	type EvalRunProgressEvent,
	type EvalRunResultEntry,
	type EvalRunCaseAttempt,
	type EvalRunCaseDetail,
} from "./eval-runner.js";

export {
	createIncidentBundle,
	renderIncidentMarkdown,
	extractTurnTrace,
	synthesizeContextFromMessages,
	listIncidents,
	getIncidentDir,
	readIncident,
	updateIncident,
	readIncidentTurnTrace,
	type IncidentMeta,
	type IncidentOrigin,
	type IncidentStatus,
	type TurnTraceEntry,
	type TurnTraceToolCall,
	type TurnTraceMessageLike,
	type CreateIncidentOptions,
	type CreateIncidentResult,
} from "./eval-incident.js";

export {
	createMockToolResolver,
	argsSimilarity,
	stringifyToolValue,
	type MockToolResolver,
	type MockToolResolution,
	type MockResultSource,
	type ToolSimulator,
} from "./eval-mock-tools.js";

export {
	writeTranscript,
	readTranscript,
	transcriptToText,
	type Transcript,
	type TranscriptHeader,
	type TranscriptEvent,
} from "./eval-transcript.js";

export {
	runReplay,
	loadSceneFromIncident,
	loadSceneFromDir,
	contextToEvalMessages,
	type ReplayScene,
	type ReplayOptions,
	type ReplayResult,
} from "./eval-replay.js";

export {
	buildRubricJudgeMessages,
	parseRubricVerdict,
	normalizeRubricClauses,
	type RubricVerdict,
} from "./eval-judge.js";

export {
	compareRunEntries,
	findBaselineEntry,
	isComparableEntry,
	loadResultEntries,
	renderComparisonMarkdown,
	STABLE_PASS,
	STABLE_FAIL,
	type RunComparison,
	type CaseFlip,
} from "./eval-compare.js";

export {
	measureReplayFidelity,
	replayDecisionSequence,
	traceDecisionSequence,
	fidelityVerdict,
	type FidelityReport,
} from "./eval-fidelity.js";

export {
	runSensitivityAudit,
	listPromptSectionNames,
	renderSensitivityMarkdown,
	type SensitivityReport,
	type SectionSensitivity,
	type SensitivityProgressEvent,
} from "./eval-sensitivity.js";

export {
	runJudgeCalibration,
	parseAnnotationsJsonl,
	renderCalibrationMarkdown,
	CALIBRATION_MIN_SAMPLES,
	CALIBRATION_AGREEMENT_THRESHOLD,
	CALIBRATION_SCORE_CUTOFF,
	type CalibrationAnnotation,
	type CalibrationSample,
	type CalibrationSampleOutcome,
	type CalibrationOutcome,
} from "./eval-calibration.js";

export {
	analyzeIncident,
	renderAnalyzedMarkdown,
	createAiToolSimulator,
	checkContextIntegrity,
	concludeDiagnosis,
	writeDiagnosisReport,
	type AnalysisModel,
	type IncidentAnalysis,
	type DiagnosisConclusion,
	type DiagnosisInput,
} from "./eval-analysis.js";

export {
	diagnoseIncident,
	type DiagnoseOptions,
	type DiagnoseResult,
	type DiagnoseProgress,
} from "./eval-diagnose.js";
