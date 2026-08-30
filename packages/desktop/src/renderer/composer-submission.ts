export interface ConversationSubmission {
	readonly text: string;
	readonly attachments: readonly { readonly path: string; readonly name: string }[];
	readonly skill?: { readonly name: string };
}

function composerText(input: ConversationSubmission): string {
	return input.skill ? `/skill:${input.skill.name}${input.text ? ` ${input.text}` : ""}` : input.text;
}

export function composerPayload(input: ConversationSubmission) {
	return {
		text: composerText(input),
		...(input.attachments.length > 0
			? { attachments: input.attachments.map(({ path, name }) => ({ path, name })) }
			: {}),
	};
}

export function composerRequestKey(input: ConversationSubmission): string {
	return JSON.stringify({
		text: input.text,
		attachments: input.attachments.map(({ path, name }) => ({ path, name })),
		skill: input.skill?.name ?? null,
	});
}
