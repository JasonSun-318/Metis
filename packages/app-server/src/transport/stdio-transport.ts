import type { Readable, Writable } from "node:stream";
import {
	assertEnvelopeByteLimit,
	MAX_ENVELOPE_UTF8_BYTES,
	ProtocolValidationError,
	parseRawEnvelope,
} from "@arcmind/app-protocol";
import type { TransportConnection, TransportHandlers } from "./transport.ts";

function oversizedFrame(): ProtocolValidationError {
	return new ProtocolValidationError("parse", "Envelope exceeds the 8 MiB transport limit");
}

function invalidLineEnding(): ProtocolValidationError {
	return new ProtocolValidationError("parse", "Stdio transport accepts LF-delimited JSONL only");
}

/** LF-delimited JSON over stdio with bounded framing and write backpressure. */
export class StdioTransport implements TransportConnection {
	private readonly input: Readable;
	private readonly output: Writable;
	private handlers?: TransportHandlers;
	private readonly parts: Buffer[] = [];
	private lineBytes = 0;
	private discardingOversizedLine = false;
	private inboundTail = Promise.resolve();
	private outboundTail = Promise.resolve();
	private started = false;
	private closed = false;
	private disconnectQueued = false;

	constructor(input: Readable, output: Writable) {
		this.input = input;
		this.output = output;
	}

	private readonly onData = (chunk: Buffer | string): void => {
		this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
	};

	private readonly onEnd = (): void => {
		if (this.discardingOversizedLine) this.enqueueInvalid(oversizedFrame());
		else if (this.lineBytes > 0) {
			this.enqueueInvalid(new ProtocolValidationError("parse", "Stdio JSONL ended with an incomplete frame"));
		}
		this.resetLine();
		this.queueDisconnect();
	};

	private readonly onInputError = (): void => {
		this.queueDisconnect();
	};

	private readonly onInputClose = (): void => {
		this.queueDisconnect();
	};

	private readonly onOutputFailure = (): void => {
		this.queueDisconnect();
	};

	start(handlers: TransportHandlers): void {
		if (this.started) throw new TypeError("Stdio transport has already started");
		if (this.closed) throw new TypeError("Stdio transport is closed");
		this.started = true;
		this.handlers = handlers;
		this.input.on("data", this.onData);
		this.input.once("end", this.onEnd);
		this.input.once("error", this.onInputError);
		this.input.once("close", this.onInputClose);
		this.output.on("error", this.onOutputFailure);
		this.output.once("close", this.onOutputFailure);
	}

	private consume(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.byteLength) {
			const newline = chunk.indexOf(0x0a, offset);
			const end = newline < 0 ? chunk.byteLength : newline;
			const segment = chunk.subarray(offset, end);
			if (!this.discardingOversizedLine && segment.byteLength > 0) {
				if (this.lineBytes + segment.byteLength > MAX_ENVELOPE_UTF8_BYTES) {
					this.parts.length = 0;
					this.lineBytes = 0;
					this.discardingOversizedLine = true;
				} else {
					this.parts.push(segment);
					this.lineBytes += segment.byteLength;
				}
			}

			if (newline < 0) return;
			if (this.discardingOversizedLine) this.enqueueInvalid(oversizedFrame());
			else this.finishLine();
			this.resetLine();
			offset = newline + 1;
		}
	}

	private finishLine(): void {
		const line = Buffer.concat(this.parts, this.lineBytes);
		if (line.at(-1) === 0x0d) {
			this.enqueueInvalid(invalidLineEnding());
			return;
		}
		try {
			this.enqueueEnvelope(parseRawEnvelope(line));
		} catch (error) {
			this.enqueueInvalid(
				error instanceof ProtocolValidationError
					? error
					: new ProtocolValidationError("parse", "Invalid JSONL frame"),
			);
		}
	}

	private resetLine(): void {
		this.parts.length = 0;
		this.lineBytes = 0;
		this.discardingOversizedLine = false;
	}

	private enqueue(task: () => Promise<void> | void): void {
		this.inboundTail = this.inboundTail.then(task).catch(async () => {
			if (this.disconnectQueued) return;
			this.disconnectQueued = true;
			await this.handlers?.onDisconnect();
		});
	}

	private enqueueEnvelope(envelope: unknown): void {
		this.enqueue(async () => await this.handlers?.onEnvelope(envelope));
	}

	private enqueueInvalid(error: ProtocolValidationError): void {
		this.enqueue(async () => await this.handlers?.onInvalidFrame(error));
	}

	private queueDisconnect(): void {
		if (this.disconnectQueued) return;
		this.disconnectQueued = true;
		this.enqueue(async () => await this.handlers?.onDisconnect());
	}

	async send(envelope: unknown): Promise<void> {
		if (!this.started || this.closed) throw new Error("Stdio transport is not open");
		assertEnvelopeByteLimit(envelope);
		const line = `${JSON.stringify(envelope)}\n`;
		this.outboundTail = this.outboundTail.then(async () => await this.writeLine(line));
		try {
			await this.outboundTail;
		} catch (error) {
			this.queueDisconnect();
			throw error;
		}
	}

	private async writeLine(line: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			let callbackDone = false;
			let drained = false;
			let settled = false;
			const cleanup = () => {
				this.output.off("drain", onDrain);
				this.output.off("error", onError);
				this.output.off("close", onClose);
			};
			const finish = () => {
				if (settled || !callbackDone || !drained) return;
				settled = true;
				cleanup();
				resolve();
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const onDrain = () => {
				drained = true;
				finish();
			};
			const onError = (error: Error) => fail(error);
			const onClose = () => fail(new Error("Stdio output closed"));
			this.output.once("drain", onDrain);
			this.output.once("error", onError);
			this.output.once("close", onClose);
			try {
				const accepted = this.output.write(line, (error?: Error | null) => {
					if (error) {
						fail(error);
						return;
					}
					callbackDone = true;
					finish();
				});
				if (accepted) {
					drained = true;
					this.output.off("drain", onDrain);
				}
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.input.off("data", this.onData);
		this.input.off("end", this.onEnd);
		this.input.off("error", this.onInputError);
		this.input.off("close", this.onInputClose);
		this.output.off("error", this.onOutputFailure);
		this.output.off("close", this.onOutputFailure);
		await this.outboundTail.catch(() => undefined);
	}
}
