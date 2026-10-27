import type { AgentMode, ItemView } from "@metis/app-protocol";
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const params = new URLSearchParams(location.search);
const appearance: AgentMode = params.get("mode") === "code" ? "code" : "chat";
const count = Math.max(1, Math.min(1000, Number(params.get("count") ?? 80)));
const hasInitialOlder = params.has("older");
const single = params.has("single");
const split = params.has("split");
const editor = params.has("editor");
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
if (params.has("reduced")) document.documentElement.dataset.motion = "reduced";
setLocale("en");

function turn(pane: string, epoch: number, index: number): ItemView[] {
	const sessionId = `${pane}-session-${epoch}`;
	const base = {
		sessionId,
		turnId: `${sessionId}-turn-${index}`,
		state: "completed" as const,
		createdAt: "2026-10-25T00:00:00Z",
	};
	const prose = `Answer ${index + 1}: readable content remains anchored while the conversation changes.\n\n`;
	return [
		{
			...base,
			itemId: `${sessionId}-user-${index}`,
			role: "user",
			content: [
				{ type: "text", text: `Question ${index + 1}: ${pane} session ${epoch} — a message with a preview` },
			],
			...(index % 17 === 0 ? { attachments: [{ name: `source-${index}.md`, byteLength: 1024 }] } : {}),
		},
		{
			...base,
			itemId: `${sessionId}-answer-${index}`,
			role: "assistant",
			content: [
				{
					type: "text",
					text:
						prose.repeat(single ? 90 : 2 + (index % 3)) +
						(index % 13 === 0
							? `\n\n\`\`\`ts\nconst original_horizontal_code_scroll = '${"long_code_token_".repeat(60)}';\n\`\`\``
							: ""),
				},
			],
		},
	];
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function Conversation({ pane }: { readonly pane: string }) {
	const [epoch, setEpoch] = useState(0);
	const epochRef = useRef(epoch);
	epochRef.current = epoch;
	const initialStart = hasInitialOlder ? 20 : 0;
	const [items, setItems] = useState<ItemView[]>(() =>
		Array.from({ length: single ? 1 : count }, (_, index) => turn(pane, 0, initialStart + index)).flat(),
	);
	const [hasOlder, setHasOlder] = useState(hasInitialOlder);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [streaming, setStreaming] = useState(false);
	const [loads, setLoads] = useState(0);
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const loadOlder = async () => {
		if (loadingOlder || !hasOlder) return;
		const expectedEpoch = epochRef.current;
		setLoadingOlder(true);
		await nextFrame();
		await nextFrame();
		if (epochRef.current !== expectedEpoch) return;
		setItems((current) => [
			...Array.from({ length: 20 }, (_, index) => turn(pane, expectedEpoch, index)).flat(),
			...current,
		]);
		setHasOlder(false);
		setLoads((value) => value + 1);
		await nextFrame();
		await nextFrame();
		if (epochRef.current === expectedEpoch) setLoadingOlder(false);
	};
	const append = () => {
		const next = itemsRef.current.filter((item) => item.role === "user").length + initialStart;
		setStreaming(false);
		setItems((current) => [...current, ...turn(pane, epoch, next)]);
	};
	const stream = () => {
		setStreaming(true);
		setItems((current) =>
			current.map((item, index) =>
				index === current.length - 1
					? {
							...item,
							state: "streaming",
							content: [
								{
									type: "text",
									text:
										item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") +
										"\n\nStreamed chunk: " +
										"extra visible text. ".repeat(50),
								},
							],
						}
					: item,
			),
		);
	};
	const activeTurnId = streaming ? items.at(-1)?.turnId : undefined;
	return (
		<main
			className="fixture-conversation conversation-column"
			data-pane={pane}
			data-epoch={epoch}
			data-count={items.filter((item) => item.role === "user").length}
			data-loads={loads}
		>
			<header className="fixture-controls">
				<strong>
					{pane} · {appearance}
					{editor ? " · Editor" : ""}
				</strong>
				<button type="button" onClick={append}>
					Append turn
				</button>
				<button type="button" onClick={stream}>
					Stream chunk
				</button>
				<button
					type="button"
					onClick={() => {
						const nextEpoch = epoch + 1;
						epochRef.current = nextEpoch;
						setEpoch(nextEpoch);
						setStreaming(false);
						setHasOlder(false);
						setLoadingOlder(false);
						setItems(Array.from({ length: 6 }, (_, index) => turn(pane, nextEpoch, index)).flat());
					}}
				>
					Switch session
				</button>
			</header>
			<Transcript
				appearance={appearance}
				showNavigation={!editor}
				activeTurnId={activeTurnId}
				activeTurnStartedAt={streaming ? "2026-10-25T00:00:00Z" : undefined}
				hasOlder={hasOlder}
				loadingOlder={loadingOlder}
				autoLoadOlder={!params.has("manual-older")}
				onLoadOlder={loadOlder}
				itemIds={items.map((item) => item.itemId)}
				itemsById={new Map(items.map((item) => [item.itemId, item]))}
			/>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<div className={`fixture-grid${split ? " is-split" : ""}`}>
			<Conversation pane="primary" />
			{split && <Conversation pane="secondary" />}
		</div>
	</StrictMode>,
);
