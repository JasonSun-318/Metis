import type { ClientParams } from "@metis/app-protocol";
import {
	assertSessionConversationQuotes,
	type DurablePromptInput,
	type FileEntry,
	formatSessionAttachments,
	formatSessionConversationQuotes,
	formatSessionFileSelections,
	importSessionAttachments,
	parseDeliverFileDetails,
	removeSessionAttachment,
	resolveDeliveredFilePath,
} from "@metis/coding-agent/host";
import { resolveFileSelections } from "./file-selection-context.ts";
import { opaqueId } from "./item-projection.ts";
import { AppServerError } from "./session-runtime-host.ts";

/** Resolve references in the selected child's history; never in an unrelated active chat. */
export async function prepareAgentMessage(
	input: ClientParams<"agent/send">,
	context: { agentDir: string; cwd: string; journal: readonly FileEntry[] },
): Promise<{ input: DurablePromptInput; rollback(): void }> {
	const quotes = input.input.conversationQuotes ?? [];
	assertSessionConversationQuotes(quotes);
	const messages = context.journal.filter((entry) => entry.type === "message");
	for (const quote of quotes) {
		if (
			!messages.some(
				(entry) => opaqueId(entry.id, "item") === quote.sourceItemId && entry.message.role === quote.sourceRole,
			)
		) {
			throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId, requestId: input.requestId });
		}
	}
	const text = formatSessionConversationQuotes(input.input.text, quotes);
	const selections = await resolveFileSelections(input.input.fileSelections ?? [], {
		cwd: context.cwd,
		resolveDelivered: (fileId) => {
			for (let i = messages.length - 1; i >= 0; i -= 1) {
				const message = messages[i]!.message;
				if (message.role !== "toolResult" || message.toolName !== "deliver_file" || message.isError) continue;
				const details = parseDeliverFileDetails(message.details);
				if (details?.fileId !== fileId) continue;
				const path = resolveDeliveredFilePath(context.agentDir, input.agentId, fileId, details.name);
				return path ? { name: details.name, path } : undefined;
			}
			return undefined;
		},
	});
	const created: string[] = [];
	const rollback = () => {
		for (const path of created) removeSessionAttachment(context.agentDir, input.agentId, path);
	};
	try {
		const attachments = input.input.attachments?.length
			? importSessionAttachments({
					agentDir: context.agentDir,
					sessionId: input.agentId,
					cwd: context.cwd,
					attachments: input.input.attachments,
					key: input.requestId,
					onFileCreated: (path) => created.push(path),
				})
			: [];
		return {
			input: {
				text: formatSessionAttachments(formatSessionFileSelections(text, selections), attachments),
				...(input.input.images
					? {
							images: input.input.images.map((image) => ({
								type: "image_ref" as const,
								hash: image.hash,
								mimeType: image.mediaType,
								size: image.byteLength,
							})),
						}
					: {}),
			},
			rollback,
		};
	} catch (error) {
		rollback();
		throw error;
	}
}
