import type { ChatMessage, MessageOrigin } from "@shared/ipc.js";
import { registerPromptContextProvider } from "../engine/prompt/plugin-context.js";
import { sessionReads } from "../session/reads.js";
import {
	latestRealOrigin,
	originConnector,
	originDisplayName,
	originWorkspaceId,
} from "./origin.js";

const PROVIDER_PLUGIN_ID = "core-channel-identity";
const PROVIDER_ID = "communication-context";

let unregister: (() => void) | null = null;

function latestOrigin(messages: readonly ChatMessage[]): MessageOrigin | undefined {
	return latestRealOrigin(messages);
}

function buildCommunicationContext(origin: MessageOrigin): string {
	const identity = origin.resolvedIdentity;
	const conversation = origin.conversation;
	const isOwnerSession =
		identity?.kind === "client-user" && identity?.profileId === "local-owner";

	// Owner (desktop/voice) sessions: keep minimal context.
	if (
		isOwnerSession ||
		origin.transport === "desktop" ||
		origin.transport === "voice"
	) {
		return "";
	}

	// Channel-user / API sessions: identity block replacing Communication Context.
	const userId = identity?.userId || identity?.profileId || "unknown";
	const displayName = originDisplayName(origin);
	const connector = originConnector(origin) || origin.transport;
	const workspaceId = originWorkspaceId(origin);
	const conversationType = conversation?.type || "direct";
	const title = conversation?.title || "";

	const lines = [
		"# Conversation Counterpart",
		`- user_id: ${userId}`,
		`- display name: ${displayName}`,
		`- channel: ${connector}${workspaceId ? ` (workspace: ${workspaceId})` : ""}`,
		`- conversation: ${conversationType}${title ? ` "${title}"` : ""}`,
		"",
		"You are talking to this person, not to your owner.",
	];

	return lines.join("\n");
}

export function registerChannelPromptContextProvider(): void {
	if (unregister) return;
	unregister = registerPromptContextProvider(
		PROVIDER_PLUGIN_ID,
		PROVIDER_ID,
		(context) => {
			if (!context.sessionId) return null;
			const origin = latestOrigin(sessionReads.listMessages(context.sessionId).messages);
			if (!origin) return null;
			const content = buildCommunicationContext(origin);
			if (!content) return null;
			return {
				role: "developer",
				source: `plugins/${PROVIDER_PLUGIN_ID}/${PROVIDER_ID}`,
				content,
			};
		},
	);
}

export function unregisterChannelPromptContextProvider(): void {
	unregister?.();
	unregister = null;
}

export const __testing = {
	buildCommunicationContext,
	latestOrigin,
};
