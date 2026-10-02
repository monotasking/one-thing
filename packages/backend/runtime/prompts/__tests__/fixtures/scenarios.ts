import path from "node:path";
import type { BuildOnethingPromptContextOptions } from "../../builder.js";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures/fake-project");
const FIXED_NOW = new Date("2026-07-07T12:00:00Z");

function host(
	darwin: boolean = true,
): BuildOnethingPromptContextOptions["host"] {
	return {
		getAgent: () => ({
			name: "test-agent",
			systemPrompt: "Always answer in pirate speak.",
		}),
		getHomeDir: () => "/Users/tester",
		getPlatform: () => (darwin ? "darwin" : "win32"),
	};
}

const sampleSkills = [
	{
		name: "canvas-design",
		description:
			"Create beautiful visual art in .png and .pdf documents using design philosophy.",
		source: "user",
		category: "design",
		enabled: true,
		path: "/Users/tester/.agents/skills/canvas-design/SKILL.md",
		directoryPath: "/Users/tester/.agents/skills/canvas-design",
	},
	{
		name: "brave-search",
		description: "Web search and content extraction via Brave Search API.",
		source: "builtin",
		category: "search",
		enabled: true,
		path: "/Users/tester/.pi/agent/skills/pi-skills/brave-search/SKILL.md",
		directoryPath: "/Users/tester/.pi/agent/skills/pi-skills/brave-search",
	},
	{
		name: "disabled-skill",
		description: "This skill is disabled and should not appear in prompt.",
		source: "user",
		enabled: false,
		path: "/Users/tester/.agents/skills/disabled/SKILL.md",
		directoryPath: "/Users/tester/.agents/skills/disabled",
	},
];

export interface ScenarioDef {
	name: string;
	ctx: BuildOnethingPromptContextOptions;
}

/**
 * Scene matrix: each scenario covers a distinct conditional branch.
 */
export function scenarios(): ScenarioDef[] {
	return [
		{
			name: "minimal",
			ctx: {
				hasTools: false,
				skills: [],
				host: host(),
				now: FIXED_NOW,
				workingDirectory: undefined,
			},
		},
		{
			name: "desktop-full",
			ctx: {
				hasTools: true,
				toolNames: ["read", "write", "edit", "bash", "glob", "grep", "variable"],
				skills: sampleSkills,
				host: host(),
				now: FIXED_NOW,
				workingDirectory: "/Users/tester/projects/myapp",
				activeProject: {
					hasActive: true,
					path: "/Users/tester/projects/myapp",
					displayPath: "~/projects/myapp",
					description: "My main application",
				},
				knownProjects: {
					hasAny: true,
					entries: [
						{
							path: "/Users/tester/projects/other",
							displayPath: "~/projects/other",
							description: "Another project",
						},
					],
				},
			},
		},
		{
			name: "codex-split",
			ctx: {
				hasTools: true,
				toolNames: ["read", "write", "edit", "bash"],
				skills: sampleSkills,
				host: host(),
				now: FIXED_NOW,
				workingDirectory: FIXTURE_DIR,
				providerId: "codex",
				model: "gpt-5-codex",
			},
		},
		{
			name: "voice",
			ctx: {
				hasTools: false,
				skills: [],
				host: host(),
				now: FIXED_NOW,
				workingDirectory: "/Users/tester/voice-project",
				voiceConversation: true,
			},
		},
		{
			name: "agents-md",
			ctx: {
				hasTools: true,
				toolNames: ["read", "write"],
				skills: [],
				host: host(),
				now: FIXED_NOW,
				workingDirectory: FIXTURE_DIR,
			},
		},
		{
			name: "windows",
			ctx: {
				hasTools: false,
				skills: [],
				host: {
					getAgent: () => ({
						name: "win-agent",
						systemPrompt: "Use PowerShell.",
					}),
					getHomeDir: () => "C:\\Users\\tester",
					getPlatform: () => "win32",
				},
				now: FIXED_NOW,
				workingDirectory: "C:\\Users\\tester\\projects\\winapp",
			},
		},
		{
			name: "linux",
			ctx: {
				hasTools: false,
				skills: [],
				host: {
					getAgent: () => ({ name: "linux-agent", systemPrompt: "Use bash." }),
					getHomeDir: () => "/home/tester",
					getPlatform: () => "linux",
				},
				now: FIXED_NOW,
				workingDirectory: "/home/tester/projects/linuxapp",
			},
		},
	];
}

/**
 * Estimate tokens from character count: chars / 3.5 approximation.
 */
export function estimateTokens(chars: number): number {
	return Math.ceil(chars / 3.5);
}

/**
 * Segment boundaries for the builder output.
 * Each segment ID maps to a builder section function.
 */
export const SEGMENTS = [
	"core",
	"agent",
	"voice",
	"runtime-context",
	"workdir",
	"active-project",
	"known-projects",
	"skills",
	"os",
	"agents-md",
	"context-variables",
	"plugins",
] as const;

export type SegmentId = (typeof SEGMENTS)[number];
