import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AppProtocolEnvelopeSchema,
	ClientRequestEnvelopeSchema,
	ClientSuccessResponseEnvelopeSchema,
	ConnectionEventsParamsSchema,
	DomainEventSchema,
	HostRequestEnvelopeSchema,
	HostSuccessResponseEnvelopeSchema,
	InteractionResultSchema,
	InteractionViewSchema,
	ItemViewSchema,
	PROTOCOL_VERSION,
	RpcErrorObjectSchema,
	RpcErrorResponseEnvelopeSchema,
	ServerNotificationEnvelopeSchema,
	ServerRequestEnvelopeSchema,
	ServerSuccessResponseEnvelopeSchema,
	SessionSnapshotSchema,
	SessionSummarySchema,
	TurnViewSchema,
} from "../src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "generated/app-server.schema.json");

const document = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: `https://arcmind.dev/schemas/app-server-v${PROTOCOL_VERSION}.json`,
	title: `ArcMind App-Server Protocol v${PROTOCOL_VERSION}`,
	$ref: "#/$defs/AppProtocolEnvelope",
	$defs: {
		AppProtocolEnvelope: AppProtocolEnvelopeSchema,
		ClientRequestEnvelope: ClientRequestEnvelopeSchema,
		ClientSuccessResponseEnvelope: ClientSuccessResponseEnvelopeSchema,
		ConnectionEventsParams: ConnectionEventsParamsSchema,
		DomainEvent: DomainEventSchema,
		HostRequestEnvelope: HostRequestEnvelopeSchema,
		HostSuccessResponseEnvelope: HostSuccessResponseEnvelopeSchema,
		InteractionResult: InteractionResultSchema,
		InteractionView: InteractionViewSchema,
		ItemView: ItemViewSchema,
		RpcErrorObject: RpcErrorObjectSchema,
		RpcErrorResponseEnvelope: RpcErrorResponseEnvelopeSchema,
		ServerNotificationEnvelope: ServerNotificationEnvelopeSchema,
		ServerRequestEnvelope: ServerRequestEnvelopeSchema,
		ServerSuccessResponseEnvelope: ServerSuccessResponseEnvelopeSchema,
		SessionSnapshot: SessionSnapshotSchema,
		SessionSummary: SessionSummarySchema,
		TurnView: TurnViewSchema,
	},
};

const serialized = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = await readFile(outputPath, "utf8");
	} catch {
		// Missing output is reported as stale below.
	}
	if (current !== serialized) {
		console.error("generated/app-server.schema.json is stale; run npm run generate --workspace @arcmind/app-protocol");
		process.exitCode = 1;
	}
} else {
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, serialized, "utf8");
}
