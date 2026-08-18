import { z } from "zod";
import type { JsonObject, JsonObjectProperty } from "@onething/core";
import { Tool } from "../tool.js";

/**
 * The main session's first-class handle on the radio. Delegation to the DJ
 * agent already existed (intent file → conductor → DJ wake), but its only
 * handle was skill prose plus a hand-written JSON file — models follow tools
 * far better than prose, the file write needed a permission prompt, and
 * hand-written JSON drifts. This tool is the same delegation with structure:
 * no file writes by the model, no prompt, and an actual receipt to relay.
 */

export interface RadioToolStatus {
	active: boolean;
	intent: string;
	programmeLength: number;
	nowPlayingTitle?: string;
	lastError?: string;
}

export interface RadioToolAdapters {
	/** Stage+apply the intent (open or retune); retune also clears the programme. */
	open(intent: string, options: { clearProgramme: boolean }): Promise<RadioToolStatus>;
	/** active:false + stop playback, in the order that avoids auto-revive. */
	close(): Promise<RadioToolStatus>;
	status(): RadioToolStatus;
	/** Cut a named song in as the next track (search + playability check inside). */
	request(song: string): Promise<{ success: boolean; title?: string; error?: string }>;
}

interface RadioMetadata extends JsonObject {
	action: string;
	[key: string]: JsonObjectProperty;
}

export const RadioParameters = z.object({
	action: z
		.enum(["open", "retune", "close", "status", "request"])
		.describe(
			"open: start the station with an intent (the DJ agent curates and playback starts automatically). retune: change direction — new intent, old programme discarded. close: stop the station and the music. status: read current state. request: cut a specific song in as the next track (station must be on).",
		),
	intent: z
		.string()
		.optional()
		.describe(
			"Required for open/retune: the listener's mood/style in one plain sentence, e.g. 「下雨天,安静的中文民谣」. This becomes the station's brief for the DJ.",
		),
	song: z
		.string()
		.optional()
		.describe(
			"Required for request: the song the user named, ideally 「歌名 歌手」. The app searches, verifies playability, and queues it next — never play it manually while the radio is on.",
		),
});

function describeStatus(status: RadioToolStatus): string {
	return [
		`active: ${status.active}`,
		status.intent ? `intent: ${status.intent}` : null,
		`programme_left: ${status.programmeLength}`,
		status.nowPlayingTitle ? `now_playing: ${status.nowPlayingTitle}` : null,
		status.lastError ? `last_error: ${status.lastError}` : null,
	]
		.filter(Boolean)
		.join("\n");
}

export function createRadioTool(
	adapters: RadioToolAdapters,
): Tool.Info<typeof RadioParameters, RadioMetadata> {
	return Tool.define<typeof RadioParameters, RadioMetadata>("radio", {
		name: "Radio",
		description: `Run the personal radio station — the default way to play music that keeps going ("放点歌", "来点轻音乐,一直放着"). Call open with a one-sentence intent; the DJ agent curates the programme and playback starts on its own (first song within ~a minute). You never pick songs yourself.

- open: start (or restart) with an intent. retune: new direction, pass the new intent. close: the user is done ("别放了"). status: what is playing, songs left, problems. request: the user names a song while the station is on — it cuts in as the next track; NEVER play manually while the radio is on.
- Only play manually (ncm-cli via bash, see the netease-music-cli skill) when the user names ONE song AND the radio is off.`,
		category: "builtin",
		enabled: true,
		autoExecute: true,
		permissionGuard: "safe",
		executionMode: "sequential",
		renderKind: "text",

		parameters: RadioParameters,

		async execute(args) {
			if (args.action === "request") {
				const song = args.song?.trim();
				if (!song) {
					return {
						title: "缺少歌名",
						output: "request 需要 song:用户点名想听的歌,尽量带歌手,如「晴天 周杰伦」。",
						metadata: { action: args.action },
					};
				}
				const requested = await adapters.request(song);
				if (!requested.success) {
					return {
						title: "点歌失败",
						output: requested.error ?? "点歌失败",
						metadata: { action: args.action },
					};
				}
				return {
					title: "已插队",
					output: `「${requested.title}」将在下一首播出${requested.error ? `(${requested.error})` : ""}。向用户确认时报这个完整歌名。`,
					metadata: { action: args.action },
				};
			}

			if (args.action === "status") {
				const status = adapters.status();
				return {
					title: status.active ? "电台状态" : "电台未开",
					output: describeStatus(status),
					metadata: { action: args.action },
				};
			}

			if (args.action === "close") {
				const status = await adapters.close();
				return {
					title: "电台已关",
					output: describeStatus(status),
					metadata: { action: args.action },
				};
			}

			const intent = args.intent?.trim();
			// Length 1 is never a real direction — historically always debris
			// ('x'), and a station briefed with debris curates blind.
			if (!intent || intent.length < 2) {
				return {
					title: "缺少意图",
					output:
						"open/retune 需要 intent:用一句话概括听众想要的氛围(时间、心情、风格),不要用占位符或单个字符。",
					metadata: { action: args.action },
				};
			}

			const status = await adapters.open(intent, {
				clearProgramme: args.action === "retune",
			});
			return {
				title: args.action === "retune" ? "已换台" : "电台已开",
				output: `${describeStatus(status)}\n\nDJ 正在编排:先凑一小批让音乐尽快响(通常两三分钟内第一首开播),然后边播边补全节目单、准备串词。可随时用 radio(action: "status") 查看进度;向用户转述时请如实说明这个节奏,不要承诺"马上"。`,
				metadata: { action: args.action },
			};
		},
	});
}
