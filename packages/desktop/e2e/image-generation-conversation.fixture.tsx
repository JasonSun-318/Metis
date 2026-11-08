import type { ItemView } from "@metis/app-protocol";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { CodeTranscriptTurn } from "../src/renderer/components/CodeTranscriptTurn.tsx";
import { ImageGenerationContext } from "../src/renderer/components/ImageGenerationContext.tsx";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
import { TranscriptTurn } from "../src/renderer/components/TranscriptTurn.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { type DesktopPreviewFileInput, validateReadPreviewFileInput } from "../src/shared/desktop-api.ts";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "code" ? "code" : "chat";
const requestedCount = Number(params.get("count") ?? "1");
const aspectRatio = params.get("ratio") ?? "1:1";
const [ratioWidth, ratioHeight] = (params.get("outputRatio") ?? aspectRatio).split(":").map(Number);
const imageWidth = 1200;
const imageHeight = Math.round((imageWidth * ratioHeight!) / ratioWidth!);
const initial = params.get("state") ?? "generating";
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
setLocale("zh-CN");
document.getElementById("root")!.className = mode === "code" ? "transcript-code" : "";
const sessionId = "11111111-1111-4111-8111-111111111111";
const fileIds = Array.from({ length: requestedCount }, (_, index) => `${index + 1}`.padStart(16, "0"));
let reads = 0;

// A local raster fixture exercises the real preview/decode pipeline without a provider request.
async function sampleImage(index: number) {
	const canvas = document.createElement("canvas");
	canvas.width = imageWidth;
	canvas.height = imageHeight;
	const ctx = canvas.getContext("2d")!;
	ctx.scale(imageWidth / 1200, imageHeight / 1200);
	const gradient = ctx.createLinearGradient(0, 0, 1200, 1200);
	gradient.addColorStop(0, ["#304b50", "#65536b", "#636845", "#705842"][index % 4]!);
	gradient.addColorStop(1, "#d6c1a7");
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 1200, 1200);
	ctx.fillStyle = "#efdfba";
	ctx.beginPath();
	ctx.arc(880, 280, 110, 0, Math.PI * 2);
	ctx.fill();
	for (let row = 0; row < 3; row++) {
		ctx.fillStyle = ["#6e8581", "#425f5c", "#203e3c"][row]!;
		ctx.beginPath();
		ctx.moveTo(0, 730 + row * 130);
		ctx.bezierCurveTo(320, 350 + row * 220, 700, 950 - row * 150, 1200, 600 + row * 150);
		ctx.lineTo(1200, 1200);
		ctx.lineTo(0, 1200);
		ctx.fill();
	}
	const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
	return new Uint8Array(await blob.arrayBuffer());
}
const api = {
	readPreviewFile: (input: DesktopPreviewFileInput) => {
		// Match the synchronous validation performed by the real desktop preload.
		const target = validateReadPreviewFileInput(input);
		if (params.has("previewError") || (params.has("retryError") && reads === 0)) {
			reads++;
			throw new Error("Preview transport failed");
		}
		reads++;
		document.body.dataset.reads = String(reads);
		return sampleImage(fileIds.indexOf(target.source === "delivered" ? target.fileId : "")).then((bytes) => ({
			ok: true as const,
			name: "image.png",
			mediaType: "image/png",
			byteLength: bytes.length,
			bytes,
		}));
	},
};
function Fixture() {
	const [state, setState] = useState(initial);
	const [action, setAction] = useState("");
	const running = state === "generating" || state === "progress";
	const images = ["completed", "partial", "progress"].includes(state)
		? fileIds.slice(0, state === "partial" || state === "progress" ? 1 : requestedCount).map((fileId, index) => ({
				fileId,
				name: `mountain-${index + 1}.png`,
				byteLength: 250000,
				deliveredAt: "2026-11-05T00:00:00Z",
				availability: "available" as const,
				mediaType: "image/png" as const,
				width: imageWidth,
				height: imageHeight,
			}))
		: [];
	const base = { sessionId, turnId: "turn", state: "completed" as const, createdAt: "2026-11-05T00:00:00Z" };
	const items: ItemView[] = [
		{ ...base, itemId: "user", role: "user", content: [{ type: "text", text: "帮我生成一张静谧山谷的插画" }] },
		{
			...base,
			itemId: "call",
			role: "assistant",
			content: [
				{ type: "text", text: "我会用柔和的色调，画一片日落时分的山谷。" },
				{
					type: "tool_call",
					toolCallId: "generate",
					name: "image_generate",
					state: running ? "running" : "completed",
					inputPreview: JSON.stringify({
						prompt: "a peaceful mountain valley",
						count: requestedCount,
						aspect_ratio: aspectRatio,
					}),
				},
			],
		},
		...(state !== "generating"
			? [
					{
						...base,
						itemId: "result",
						role: "tool" as const,
						content: [
							{
								type: "tool_result" as const,
								toolCallId: "generate",
								name: "image_generate",
								isError: state === "failed" || state === "unconfigured",
								output: "",
								imageGeneration: {
									status: (state === "progress" ? "generating" : state) as "completed",
									requestedCount,
									images,
									aspectRatio,
									...(state === "unconfigured"
										? {
												message: "尚未配置生图模型，请前往设置完成配置。",
												errorCode: "IMAGE_MODEL_NOT_CONFIGURED",
											}
										: {}),
								},
							},
						],
					},
				]
			: []),
		...(state === "completed"
			? [
					{
						...base,
						itemId: "answer",
						role: "assistant" as const,
						content: [
							{ type: "text" as const, text: "画面已完成。你可以点击图片放大查看，也可以继续调整颜色和构图。" },
						],
					},
				]
			: []),
	];
	const Turn = mode === "code" ? CodeTranscriptTurn : TranscriptTurn;
	return (
		<ImageGenerationContext.Provider
			value={{
				api,
				onConfigure: () => setAction("configure"),
				onEdit: (_sessionId, image) => setAction(`edit:${image.fileId}`),
				onReveal: (_sessionId, fileId) => setAction(`reveal:${fileId}`),
			}}
		>
			<div className="fixture-toolbar">
				<span>Metis · {mode}</span>
				<button type="button" onClick={() => setState("completed")}>
					Complete
				</button>
				<output data-action={action}>{action}</output>
			</div>
			{params.has("belowFold") && <div style={{ height: 1600 }} />}
			{params.has("workspace") ? (
				<div className="workspace-panel" style={{ width: "100%", height: 720, transform: "translateY(60px)" }}>
					<Transcript
						appearance={mode}
						hasOlder={false}
						loadingOlder={false}
						onLoadOlder={async () => {}}
						itemIds={items.map((item) => item.itemId)}
						itemsById={new Map(items.map((item) => [item.itemId, item]))}
					/>
				</div>
			) : (
				<main className={mode === "code" ? "code-transcript-turn" : "transcript-turn"}>
					<Turn items={items} running={running} />
				</main>
			)}
		</ImageGenerationContext.Provider>
	);
}
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Fixture />
	</StrictMode>,
);
