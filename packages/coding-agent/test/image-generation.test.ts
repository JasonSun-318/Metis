import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@metis/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageGenerationConfig } from "../src/core/image-generation/config.ts";
import type { ImageGenerationInput } from "../src/core/image-generation/provider.ts";
import { createImageGenerationToolDefinition } from "../src/core/image-generation/tool.ts";
import { type ImageGenerationDetails, parseImageGenerationDetails } from "../src/core/image-generation/types.ts";
import { SessionDeliveredArtifacts } from "../src/core/session-delivered-artifacts.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getDefaultToolNames } from "../src/core/tools/index.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
	"base64",
);
const roots: string[] = [];
const managers: SessionManager[] = [];
const openAI: ImageGenerationConfig = {
	name: "Images",
	api: "openai-images",
	baseUrl: "https://images.test/v1",
	modelId: "gpt-image-2.5-flare",
};
const google: ImageGenerationConfig = {
	name: "Banana",
	api: "google-interactions",
	baseUrl: "https://google.test/v1beta",
	modelId: "gemini-nano-banana-2.1",
};
const openRouter: ImageGenerationConfig = {
	name: "OpenRouter",
	api: "openrouter-images",
	baseUrl: "https://openrouter.test/api/v1",
	modelId: "google/gemini-3.1-flash-image",
};
const openAIResponse = () => Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
const googleResponse = (id = "interaction-1") =>
	Response.json({
		id,
		status: "completed",
		steps: [
			{ type: "model_output", content: [{ type: "image", data: PNG.toString("base64"), mime_type: "image/png" }] },
		],
	});

function fixture(initial: ImageGenerationConfig | undefined = openAI) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "metis-image-generation-")));
	roots.push(cwd);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const manager = SessionManager.create(cwd, join(cwd, "sessions"));
	managers.push(manager);
	manager.appendMessage({ role: "user", content: "Draw a robot", timestamp: Date.now() });
	const artifacts = new SessionDeliveredArtifacts(agentDir, manager);
	const request = vi.fn<typeof fetch>().mockImplementation(async () => openAIResponse());
	let config: ImageGenerationConfig | undefined = initial;
	const tool = createImageGenerationToolDefinition(cwd, {
		getConfig: () => config,
		getApiKey: () => "secret-image-key",
		getSession: () => ({ agentDir, sessionId: manager.getSessionId(), artifacts }),
		fetch: request,
	});
	const execute = (
		input: ImageGenerationInput = { prompt: "robot" },
		signal?: AbortSignal,
		onUpdate?: (result: AgentToolResult<ImageGenerationDetails>) => void,
	) => tool.execute("call", input, signal, onUpdate, {} as never);
	const persist = (result: AgentToolResult<ImageGenerationDetails>) => {
		const id = manager.appendMessage({
			role: "toolResult",
			toolName: "image_generate",
			toolCallId: "call",
			content: result.content,
			details: result.details,
			isError: false,
			timestamp: Date.now(),
		});
		artifacts.finishGeneration("call");
		return id;
	};
	return {
		cwd,
		agentDir,
		manager,
		artifacts,
		request,
		tool,
		execute,
		persist,
		setConfig: (next: ImageGenerationConfig | undefined) => {
			config = next;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) manager.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native image generation", () => {
	it("uses OpenRouter Images JSON and preserves progress and durable edit references", async () => {
		const value = fixture(openRouter);
		value.request.mockImplementation(async () =>
			Response.json({ data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }] }),
		);
		const progress: number[] = [];
		const result = await value.execute(
			{ prompt: "robot", count: 2, aspect_ratio: "16:9", resolution: "2K", quality: "high", output_format: "png" },
			undefined,
			(update) => progress.push(update.details.images.length),
		);
		expect(value.request).toHaveBeenCalledTimes(2);
		const [url, init] = value.request.mock.calls[0]!;
		expect(url).toBe("https://openrouter.test/api/v1/images");
		expect(init!.headers).toMatchObject({
			Authorization: "Bearer secret-image-key",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(init!.body as string)).toEqual({
			model: openRouter.modelId,
			prompt: "robot",
			n: 1,
			aspect_ratio: "16:9",
			resolution: "2K",
			quality: "high",
			output_format: "png",
		});
		expect(progress).toEqual([0, 1, 2]);
		expect(result.details.status).toBe("completed");
		value.persist(result);
		const image = result.details.images[0]!;
		expect(readFileSync(value.artifacts.resolve(image.fileId)!.path)).toEqual(PNG);
		await value.execute({
			prompt: "make blue",
			reference_images: [`metis-image:${image.fileId}`],
			aspect_ratio: "auto",
			resolution: "auto",
		});
		const [editUrl, editInit] = value.request.mock.calls[2]!;
		expect(editUrl).toBe(url);
		expect(JSON.parse(editInit!.body as string)).toEqual({
			model: openRouter.modelId,
			prompt: "make blue",
			n: 1,
			input_references: [
				{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
			],
		});
		expect(JSON.stringify(result)).not.toContain(PNG.toString("base64"));
	});

	it("embeds local OpenRouter edit bytes and supports transparent PNG output", async () => {
		const value = fixture(openRouter);
		const path = join(value.cwd, "reference.png");
		writeFileSync(path, PNG);
		await value.execute({
			prompt: "remove background",
			mode: "edit",
			reference_images: [path],
			background: "transparent",
			output_format: "png",
		});
		const body = JSON.parse(value.request.mock.calls[0]![1]!.body as string);
		expect(body).toMatchObject({
			background: "transparent",
			output_format: "png",
			input_references: [
				{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
			],
		});
		expect(body).not.toHaveProperty("size");
	});

	it("validates OpenRouter declared and requested output formats before saving images", async () => {
		const value = fixture(openRouter);
		value.request.mockResolvedValueOnce(
			Response.json({ data: [{ b64_json: PNG.toString("base64"), media_type: "image/jpeg" }] }),
		);
		await expect(value.execute()).rejects.toThrow("media type");
		value.request.mockResolvedValueOnce(
			Response.json({ data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }] }),
		);
		await expect(value.execute({ prompt: "robot", output_format: "webp" })).rejects.toThrow("output format");
		expect(value.artifacts.list()).toEqual([]);
	});
	it("keeps the tool available while unconfigured and returns a real error before any HTTP request", async () => {
		const value = fixture();
		value.setConfig(undefined);
		expect(getDefaultToolNames({ webSearchEnabled: false, isSubagent: false })).toContain("image_generate");
		await expect(value.execute()).rejects.toThrow("IMAGE_MODEL_NOT_CONFIGURED:");
		expect(value.request).not.toHaveBeenCalled();
		value.setConfig(openAI);
		expect((await value.execute()).details.status).toBe("completed");
	});

	it("sends OpenAI JSON, stages readable progress, journals metadata and restores/forks independent owned bytes", async () => {
		const value = fixture();
		const progress: ImageGenerationDetails[] = [];
		const result = await value.execute(
			{
				prompt: "robot",
				count: 2,
				aspect_ratio: "3:2",
				quality: "high",
				background: "transparent",
				output_format: "png",
			},
			undefined,
			(update) => {
				progress.push(update.details);
				for (const image of update.details.images)
					expect(readFileSync(value.artifacts.resolve(image.fileId)!.path)).toEqual(PNG);
			},
		);
		expect(value.request).toHaveBeenCalledTimes(2);
		const [url, init] = value.request.mock.calls[0]!;
		expect(url).toBe("https://images.test/v1/images/generations");
		expect(JSON.parse(init!.body as string)).toEqual({
			model: openAI.modelId,
			prompt: "robot",
			n: 1,
			size: "1536x1024",
			quality: "high",
			background: "transparent",
			output_format: "png",
		});
		expect(init!.headers).toMatchObject({ Authorization: "Bearer secret-image-key" });
		expect(progress.map((entry) => entry.images.length)).toEqual([0, 1, 2]);
		expect(result.details.images).toHaveLength(2);
		expect(new Set(result.details.images.map((image) => image.fileId)).size).toBe(2);
		expect(JSON.stringify(result)).not.toContain(PNG.toString("base64"));
		expect(JSON.stringify(result)).not.toContain("secret-image-key");
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("metis-image:") });
		const entryId = value.persist(result);
		const restoredManager = SessionManager.openReadOnly(value.manager.getSessionFile()!);
		const restored = new SessionDeliveredArtifacts(value.agentDir, restoredManager);
		expect(restored.list().map((image) => image.availability)).toEqual(["available", "available"]);
		const fork = value.manager.createBranchedSessionManager(entryId);
		managers.push(fork);
		value.artifacts.copyTo(fork);
		const forkArtifacts = new SessionDeliveredArtifacts(value.agentDir, fork);
		const original = restored.resolve(result.details.images[0]!.fileId)!;
		const copied = forkArtifacts.resolve(result.details.images[0]!.fileId)!;
		expect(copied.path).not.toBe(original.path);
		rmSync(original.path);
		expect(readFileSync(copied.path)).toEqual(PNG);
		expect(restored.list()[0]!.availability).toBe("unavailable");
	});

	it("uploads edits as multipart image bytes and describes actual file-read and exact network permission claims", async () => {
		const value = fixture();
		const path = join(value.cwd, "reference.png");
		writeFileSync(path, PNG);
		await value.execute({ prompt: "make blue", mode: "edit", reference_images: [path] });
		const [url, init] = value.request.mock.calls[0]!;
		expect(url).toBe("https://images.test/v1/images/edits");
		const form = init!.body as FormData;
		expect(form.get("prompt")).toBe("make blue");
		const file = form.get("image[]") as File;
		expect(file.type).toBe("image/png");
		expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
		const claim = value.tool.permission.describe(
			{ prompt: "edit", reference_images: [".env"] },
			{ actionId: "image", cwd: value.cwd, workspaceRoots: [value.cwd] },
		);
		expect(claim.readPaths).toEqual([join(value.cwd, ".env")]);
		expect(claim.effects).toContain("sensitive-read");
		expect(claim.networkEndpoints).toEqual([{ hostname: "images.test", port: 443 }]);
	});

	it("uses Google Interactions REST steps and privately preserves continuation for durable references", async () => {
		const value = fixture(google);
		value.request.mockImplementation(async () => googleResponse());
		const first = await value.execute({ prompt: "robot", aspect_ratio: "16:9", resolution: "2K" });
		value.persist(first);
		const image = first.details.images[0]!;
		expect(image.continuation).toMatchObject({ interactionId: "interaction-1", modelId: google.modelId });
		expect(value.artifacts.list()[0]).not.toHaveProperty("continuation");
		expect(value.artifacts.list()[0]).not.toHaveProperty("mediaType");
		expect(value.artifacts.resolve(image.fileId)!.artifact).not.toHaveProperty("continuation");
		expect(JSON.stringify(first.content)).not.toContain("interaction-1");
		await value.execute({ prompt: "make blue", mode: "edit", reference_images: [`metis-image:${image.fileId}`] });
		const [url, init] = value.request.mock.calls[1]!;
		expect(url).toBe("https://google.test/v1beta/interactions");
		expect(init!.headers).toMatchObject({ "x-goog-api-key": "secret-image-key" });
		expect(JSON.parse(init!.body as string)).toMatchObject({
			model: google.modelId,
			input: "make blue",
			previous_interaction_id: "interaction-1",
			response_format: { type: "image", delivery: "inline" },
		});
		value.setConfig({ ...google, modelId: "another-image-model" });
		await value.execute({ prompt: "edit again", reference_images: [`metis-image:${image.fileId}`] });
		const changed = JSON.parse(value.request.mock.calls[2]![1]!.body as string);
		expect(changed.previous_interaction_id).toBeUndefined();
		expect(changed.input).toEqual([
			{ type: "text", text: "edit again" },
			{ type: "image", data: PNG.toString("base64"), mime_type: "image/png" },
		]);
	});

	it.each([openAI, openRouter])(
		"retains successful images after an HTTP failure and never retries (%j)",
		async (config) => {
			const value = fixture(config);
			value.request
				.mockResolvedValueOnce(openAIResponse())
				.mockResolvedValueOnce(Response.json({ error: { message: "secret-image-key" } }, { status: 429 }));
			const result = await value.execute({ prompt: "robot", count: 3 });
			expect(result.details).toMatchObject({
				status: "partial",
				requestedCount: 3,
				images: [expect.any(Object)],
				message: expect.stringContaining("HTTP 429"),
			});
			expect(value.request).toHaveBeenCalledTimes(2);
			expect(JSON.stringify(result)).not.toContain("secret-image-key");
			value.persist(result);
			expect(new SessionDeliveredArtifacts(value.agentDir, value.manager).list()[0]!.availability).toBe("available");
		},
	);

	it("edits older Google images from owned bytes without relying on an expired interaction", async () => {
		const value = fixture(google);
		value.request.mockImplementation(async () => googleResponse());
		const first = await value.execute();
		first.details.images[0] = {
			...first.details.images[0]!,
			deliveredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
		};
		value.persist(first);
		await value.execute({
			prompt: "make blue",
			reference_images: [`metis-image:${first.details.images[0]!.fileId}`],
		});
		const body = JSON.parse(value.request.mock.calls[1]![1]!.body as string);
		expect(body.previous_interaction_id).toBeUndefined();
		expect(body.input[1]).toEqual({ type: "image", data: PNG.toString("base64"), mime_type: "image/png" });
		expect(value.request).toHaveBeenCalledTimes(2);
	});

	it.each([openAI, openRouter])("propagates abort to the request and retains earlier images (%j)", async (config) => {
		const value = fixture(config);
		const controller = new AbortController();
		value.request.mockResolvedValueOnce(openAIResponse()).mockImplementationOnce(async (_url, init) => {
			controller.abort();
			expect(init?.signal?.aborted).toBe(true);
			throw new DOMException("aborted", "AbortError");
		});
		const result = await value.execute({ prompt: "robot", count: 2 }, controller.signal);
		expect(result.details.status).toBe("partial");
		expect(result.details.message).toContain("IMAGE_GENERATION_CANCELLED");
		value.persist(result);
		expect(value.artifacts.list()).toHaveLength(1);
		await expect(value.execute({ prompt: "robot" }, AbortSignal.abort())).rejects.toThrow(
			"IMAGE_GENERATION_CANCELLED",
		);
		expect(value.request).toHaveBeenCalledTimes(2);
	});

	it("does not retry transport failures", async () => {
		const value = fixture();
		value.request.mockImplementation(async () => {
			throw new TypeError("fetch failed");
		});
		await expect(value.execute()).rejects.toThrow("IMAGE_GENERATION_NETWORK");
		expect(value.request).toHaveBeenCalledTimes(1);
	});

	it.each([
		[google, { quality: "high" }, "quality"],
		[google, { background: "transparent" }, "background"],
		[google, { output_format: "webp" }, "PNG or JPEG"],
		[openAI, { background: "transparent", output_format: "jpeg" }, "Transparent"],
		[openRouter, { background: "transparent", output_format: "jpeg" }, "Transparent"],
		[openRouter, { quality: "xhigh" }, "quality"],
		[openRouter, { quality: "max" }, "quality"],
		[{ ...openAI, modelId: "gpt-image-1.5" }, { resolution: "2K" }, "1K"],
	] as const)("rejects unsupported options before billing: %j %j", async (config, options, hint) => {
		const value = fixture(config);
		await expect(value.execute({ prompt: "robot", ...options })).rejects.toThrow(hint);
		expect(value.request).not.toHaveBeenCalled();
	});

	it("rejects non-image HTTP success, oversized responses and missing image outputs", async () => {
		const value = fixture();
		value.request.mockResolvedValueOnce(
			Response.json({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] }),
		);
		await expect(value.execute()).rejects.toThrow("IMAGE_GENERATION_INVALID_RESPONSE");
		value.request.mockResolvedValueOnce(new Response("{}", { headers: { "Content-Length": "999999999" } }));
		await expect(value.execute()).rejects.toThrow("oversized");
		value.setConfig(google);
		value.request.mockResolvedValueOnce(
			Response.json({
				status: "completed",
				steps: [{ type: "model_output", content: [{ type: "text", text: "Unable to generate" }] }],
			}),
		);
		await expect(value.execute()).rejects.toThrow("IMAGE_GENERATION_NO_IMAGE");
		expect(value.artifacts.list()).toEqual([]);
	});

	it("validates persisted details and never authorizes an arbitrary sourcePath", async () => {
		const value = fixture();
		const result = await value.execute();
		expect(parseImageGenerationDetails(result.details)).toEqual(result.details);
		expect(
			parseImageGenerationDetails({
				...result.details,
				images: [{ ...result.details.images[0], sourcePath: "/etc/passwd" }],
			}),
		).toBeUndefined();
		value.persist(result);
		expect(existsSync(value.artifacts.resolve(result.details.images[0]!.fileId)!.path)).toBe(true);
	});
});
