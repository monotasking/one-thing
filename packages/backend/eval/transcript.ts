/**
 * Replay transcript (workbench W2, design D4).
 *
 * Every replay attempt persists its full process — each round's model
 * output, every tool call with its mock result (source-tagged), and the
 * judge verdict — as one .jsonl file: header line first, one event per
 * line after. The workbench renders these with chat components.
 */

import fs from "node:fs";
import path from "node:path";

export interface TranscriptHeader {
	v: 1;
	kind: "evals-transcript";
	runId: string;
	attempt: number;
	incidentId?: string;
	caseId?: string;
	promptVersion?: string;
	disabledSections?: string[];
	model: string;
	provider?: string;
	startedAt: string;
}

export type TranscriptEvent =
	| { t: "round"; n: number }
	| {
			t: "assistant";
			content: string;
			toolCalls?: Array<{ id: string; name: string; args: unknown }>;
	  }
	| {
			t: "tool-result";
			toolCallId: string;
			name: string;
			source: "recorded" | "simulated" | "stub";
			result: string;
	  }
	| { t: "judge"; pass: boolean; reason: string; rubric?: string }
	| { t: "error"; message: string }
	| { t: "done"; finalContent: string; rounds: number };

export interface Transcript {
	header: TranscriptHeader;
	events: TranscriptEvent[];
}

export function writeTranscript(
	filePath: string,
	header: TranscriptHeader,
	events: TranscriptEvent[],
): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const lines = [JSON.stringify(header) + "\n"];
	for (const event of events) {
		try {
			lines.push(JSON.stringify(JSON.parse(JSON.stringify(event))) + "\n");
		} catch {
			lines.push(
				JSON.stringify({ t: "error", message: "non-serializable event" }) +
					"\n",
			);
		}
	}
	fs.writeFileSync(filePath, lines.join(""), "utf-8");
}

export function readTranscript(filePath: string): Transcript | null {
	if (!fs.existsSync(filePath)) return null;
	const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	if (!lines.length) return null;
	let header: TranscriptHeader;
	try {
		header = JSON.parse(lines[0]);
	} catch {
		return null;
	}
	const events: TranscriptEvent[] = [];
	for (const line of lines.slice(1)) {
		try {
			events.push(JSON.parse(line));
		} catch {
			// Skip bad lines
		}
	}
	return { header, events };
}

/** Render a compact text view of a transcript (judge input, CLI output). */
export function transcriptToText(transcript: Transcript): string {
	const parts: string[] = [];
	for (const event of transcript.events) {
		if (event.t === "assistant") {
			if (event.content) parts.push(`[assistant] ${event.content}`);
			for (const tc of event.toolCalls ?? []) {
				parts.push(
					`[tool call] ${tc.name}(${shorten(JSON.stringify(tc.args ?? {}), 300)})`,
				);
			}
		} else if (event.t === "tool-result") {
			parts.push(
				`[tool result · ${event.source}] ${shorten(event.result, 500)}`,
			);
		} else if (event.t === "error") {
			parts.push(`[error] ${event.message}`);
		}
	}
	return parts.join("\n");
}

function shorten(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
