export interface ScratchpadDocument {
	sessionId: string;
	filePath: string;
	content: string;
	/**
	 * Revision marker for read-watermark correlation: the file's mtime in ms.
	 * 0 means the scratchpad has never been written.
	 */
	version: number;
	updatedAt: number;
}

export interface ScratchpadGetRequest {
	sessionId: string;
}

export interface ScratchpadGetResponse {
	success: boolean;
	document?: ScratchpadDocument;
	error?: string;
}

export interface ScratchpadUpdateRequest {
	sessionId: string;
	content: string;
}

export interface ScratchpadUpdateResponse {
	success: boolean;
	document?: ScratchpadDocument;
	error?: string;
}

export interface ScratchpadDeleteRequest {
	sessionId: string;
}

export interface ScratchpadDeleteResponse {
	success: boolean;
	error?: string;
}

/** Rename a draft session's scratchpad to the real id it materialized into. */
export interface ScratchpadAdoptRequest {
	fromSessionId: string;
	toSessionId: string;
}

export interface ScratchpadAdoptResponse {
	success: boolean;
	error?: string;
}

export interface ScratchpadChangedPayload {
	sessionId: string;
	document?: ScratchpadDocument;
}
