// Real browser selection -> normal submit/queue -> runtime -> read/edit tools -> refreshed preview.
// A deterministic local OpenAI-compatible fixture replaces the remote model; no user files/accounts are used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClientRequest } from "@metis/app-protocol";
import { AgentSessionRuntimeHost, InteractionBroker } from "@metis/app-server";
import { SessionDeliveredArtifacts, SessionManager, splitSessionFileSelectionPrompt, splitSessionAttachmentPrompt } from "@metis/coding-agent";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { selectionDeck, selectionPdf, selectionWorkbook } from "./document-selection-fixtures.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "../..");
const directory = await mkdtemp(join(tmpdir(), "metis-file-selection-"));
const cwd = join(directory, "workspace"),
	agentDir = join(directory, "agent");
await mkdir(cwd);
await mkdir(agentDir);
await writeFile(join(cwd, "objects.pptx"), await selectionDeck());
await writeFile(join(cwd, "document.pdf"), selectionPdf());
await writeFile(join(cwd, "cells.xlsx"), selectionWorkbook());
const source =
	"# Selection fixture\n\nOriginal target sentence.\n\n## First\n\n**Repeated phrase** with context.\n\n## Second\n\n**Repeated phrase** with context.\n\n```js\nconst answer = 42;\n```\n";
await writeFile(join(cwd, "notes.md"), source);
await writeFile(join(cwd, "code.ts"), "const first = 1;\nconst second = 2;\n");
await writeFile(join(cwd, "data.json"), '{"answer":42}');
await writeFile(join(cwd, "delivery.md"), "# Delivered\n\nDelivered original.\n");
const sessionId = randomUUID(),
	otherSessionId = randomUUID(),
	epoch = randomUUID();
const models = [],
	requests = [],
	events = [];
const messageText = (value) =>
	typeof value === "string"
		? value
		: Array.isArray(value)
			? value.map(messageText).join("\n")
			: value && typeof value === "object"
				? messageText(value.text ?? value.content)
				: "";
const jsonBody = async (req) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	return JSON.parse(body);
};
function modelResponse(res, tool, text) {
	const delta = tool
		? {
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: randomUUID(),
						type: "function",
						function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
					},
				],
			}
		: { role: "assistant", content: text };
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(
		`data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "selection-fixture", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
	);
}
let opened, server, browser;
let failNext = false, loseNext = false;
let modelGate = null, releaseModel = null;
const holdModel = () => {
	assert.equal(modelGate, null);
	modelGate = new Promise((resolve) => { releaseModel = () => { modelGate = null; releaseModel = null; resolve(); }; });
};
try {
	server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url, "http://localhost");
			if (url.pathname === "/v1/chat/completions") {
				const body = await jsonBody(req);
				const messages = body.messages ?? [];
				const index = messages.findLastIndex((m) => m.role === "user");
				const prompt = messageText(messages[index]?.content);
				const parsed = splitSessionFileSelectionPrompt(prompt);
				const file = parsed.fileSelections[0];
				models.push({ prompt, files: parsed.fileSelections, quotes: splitSessionAttachmentPrompt(prompt).conversationQuotes ?? [], role: messages[index]?.role });
				if (modelGate) await modelGate;
				if (!file || !parsed.text.includes("REPLACE")) {
					modelResponse(res, null, "Reference received.");
					return;
				}
				const tools = messages.slice(index + 1).filter((m) => m.role === "tool");
				const replacement = file.source === "delivered" ? "Delivered revised." : "Updated target sentence.";
				if (tools.length === 0) {
					modelResponse(res, { name: "read", arguments: { path: file.path } }, null);
					return;
				}
				if (tools.length === 1) {
					if (file.source === "delivered") {
						const original = await readFile(file.path, "utf8");
						modelResponse(
							res,
							{
								name: "write",
								arguments: {
									path: join(cwd, "delivery-revised.md"),
									content: original.replace(file.selectedText, replacement),
								},
							},
							null,
						);
					} else
						modelResponse(
							res,
							{
								name: "edit",
								arguments: { path: file.path, edits: [{ oldText: file.selectedText, newText: replacement }] },
							},
							null,
						);
					return;
				}
				if (file.source === "delivered" && tools.length === 2) {
					modelResponse(
						res,
						{
							name: "deliver_file",
							arguments: { path: join(cwd, "delivery-revised.md"), name: "delivery-revised.md" },
						},
						null,
					);
					return;
				}
				modelResponse(res, null, "Updated the selected file.");
				return;
			}
			if (url.pathname === "/rpc") {
				const { method, params } = await jsonBody(req);
				validateClientRequest({ jsonrpc: "2.0", id: randomUUID(), method, params });
				requests.push({ method, params });
				if (failNext) {
					failNext = false;
					res.writeHead(409);
					res.end(JSON.stringify({ error: "Fixture rejected this submission" }));
					return;
				}
				assert.equal(params.sessionId, sessionId);
				const methods = {
					"turn/start": "startTurn",
					"turn/queue": "queueTurn",
					"turn/queue/update": "updateQueuedTurn",
					"turn/queue/send": "sendQueuedTurn",
					"turn/steer": "steer",
				};
				const result = await opened[methods[method]](params);
				if (loseNext) {
					loseNext = false;
					res.writeHead(503);
					res.end(JSON.stringify({ error: "Fixture lost the accepted response" }));
					return;
				}
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(result));
				return;
			}
			if (url.pathname === "/poll") {
				const after = Number(url.searchParams.get("after") ?? 0);
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						events: events.slice(after),
						cursor: events.length,
						snapshot: await opened.snapshot(epoch, () => events.length),
					}),
				);
				return;
			}
			if (url.pathname === "/preview") {
				const target = JSON.parse(url.searchParams.get("target"));
				assert.equal(target.sessionId, sessionId);
				if (target.source === "delivered") {
					const result = await opened.readDeliveredFile({ sessionId, fileId: target.fileId });
					res.end(Buffer.from(result.data, "base64"));
					return;
				}
				assert(
					["notes.md", "code.ts", "data.json", "objects.pptx", "document.pdf", "cells.xlsx"].includes(
						target.relativePath,
					),
				);
				res.end(await readFile(join(cwd, target.relativePath)));
				return;
			}
			if (url.pathname.startsWith("/pdfjs/standard_fonts/")) {
				res.end(await readFile(join(desktop, "node_modules/pdfjs-dist/standard_fonts", basename(url.pathname))));
				return;
			}
			const files = {
				"/pdf.worker.min.mjs": [
					join(desktop, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
					"text/javascript",
				],
				"/fixture.js": [join(directory, "fixture.js"), "text/javascript"],
				"/app.css": [join(desktop, "src/renderer/styles/app.css"), "text/css"],
				"/transcript-navigation.css": [join(desktop, "src/renderer/styles/transcript-navigation.css"), "text/css"],
			};
			if (files[url.pathname]) {
				res.setHeader("content-type", files[url.pathname][1]);
				res.end(await readFile(files[url.pathname][0]));
				return;
			}
			if (url.pathname === "/") {
				res.setHeader("content-type", "text/html");
				res.end(html);
				return;
			}
			res.writeHead(404);
			res.end();
		})().catch((error) => {
			console.error(error);
			if (!res.headersSent) res.writeHead(500);
			res.end(JSON.stringify({ error: String(error) }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					apiKey: "fixture-key",
					api: "openai-completions",
					models: [{ id: "selection-fixture", name: "Selection fixture", contextWindow: 64000, maxTokens: 2048 }],
				},
			},
		}),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "fixture", defaultModel: "selection-fixture", retry: { enabled: false } }),
	);
	const manager = SessionManager.create(cwd, join(agentDir, "sessions"), {
		id: sessionId,
		mode: "code",
		permissionPreset: "full",
	});
	const artifacts = new SessionDeliveredArtifacts(agentDir, manager);
	const tool = artifacts.createToolDefinition();
	const delivered = await tool.execute("fixture-delivery", { path: join(cwd, "delivery.md"), name: "delivery.md" });
	const toolMessage = {
		role: "toolResult",
		toolCallId: "fixture-delivery",
		toolName: "deliver_file",
		content: delivered.content,
		details: delivered.details,
		isError: false,
		timestamp: Date.now(),
	};
	artifacts.commitToolResult(toolMessage);
	manager.appendMessage(toolMessage);
	const deliveredPath = artifacts.resolve(delivered.details.fileId).path;
	const sessionFile = manager.getSessionFile();
	manager.close();
	const ref = {
		path: sessionFile,
		relativePath: basename(sessionFile),
		summary: {
			sessionId,
			mode: "code",
			cwdOrigin: "user-selected",
			cwd,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			state: "idle",
			archived: false,
			unread: false,
		},
	};
	const host = new AgentSessionRuntimeHost({ agentDir, interactions: new InteractionBroker({ serverEpoch: epoch }) });
	opened = await host.open(ref);
	opened.subscribe((event) => events.push(event));
	const component = (path) => JSON.stringify(join(desktop, "src/renderer", path));
	await build({
		stdin: {
			contents: `
import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {PreviewHost} from ${component("components/preview/PreviewHost.tsx")};
import {Composer} from ${component("components/Composer.tsx")};
import {MessageFileSelections} from ${component("components/MessageFileSelections.tsx")};
import {FilePanel} from ${component("components/FilePanel.tsx")};
import {FileSelectionProvider} from ${component("components/preview/FileSelectionContext.tsx")};
import {useConversationPlanFlow} from ${component("hooks/use-conversation-plan-flow.ts")};
import {setLocale} from ${component("i18n.ts")};
const sessionId=${JSON.stringify(sessionId)},other=${JSON.stringify(otherSessionId)};
const subscribers=new Set();let cursor=0;let busy=false;window.snapshot=null;
const request=async(method,params)=>{const response=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params})});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;};
const api={startTurn:params=>request('turn/start',params),queueTurn:params=>request('turn/queue',params),subscribe:listener=>{subscribers.add(listener);return()=>subscribers.delete(listener);},readPreviewFile:async target=>{const bytes=new Uint8Array(await(await fetch('/preview?target='+encodeURIComponent(JSON.stringify(target)))).arrayBuffer());return {ok:true,bytes,name:target.relativePath ?? 'delivery.md',mediaType:'text/plain',byteLength:bytes.length};}};
api.listWorkspaceDirectory=async()=>['notes.md','code.ts','data.json'].map(name=>({name,relativePath:name,kind:'file'}));
api.readWorkspaceFile=async({sessionId,relativePath})=>{const result=await api.readPreviewFile({source:'workspace',sessionId,relativePath});const text=new TextDecoder().decode(result.bytes);return {kind:'text',relativePath,absolutePath:relativePath,byteLength:result.bytes.length,text,revision:text};};
function WorkspaceFiles(){
 const [path,setPath]=useState(null),[draft,setDraft]=useState(null);
 const loaded=file=>setDraft(current=>current?.file.relativePath===file.relativePath && current.text!==current.savedText ? current : {file,text:file.text,savedText:file.text});
 return <FilePanel activePath={path} api={api} cwd=${JSON.stringify(cwd)} draft={draft} dirtyPaths={[]} expandedPaths={[]} onDraftChange={text=>setDraft(current=>({...current,text}))} onDraftLoaded={loaded} onExpandedPathsChange={()=>{}} onOpenFile={setPath} onError={console.error} onSave={async()=>{}} onWorkspaceMutation={()=>{}} saving={false} savingPaths={[]} sessionId={sessionId} visible/>;
}
function App(){
 const [workspaceFiles,setWorkspaceFiles]=useState(false);window.openWorkspaceFiles=()=>setWorkspaceFiles(true);
 const [snapshot,setSnapshot]=useState(null);const [target,setTarget]=useState({source:'workspace',sessionId,relativePath:'notes.md',name:'notes.md'});const [activeSession,setSession]=useState(sessionId);const [error,setError]=useState('');
 window.openFixture=(name)=>{setTarget({source:'workspace',sessionId,relativePath:name,name});setSession(sessionId);};
 window.openDelivered=()=>{setTarget({source:'delivered',sessionId,fileId:${JSON.stringify(delivered.details.fileId)},name:'delivery.md'});setSession(sessionId);};
 window.switchTask=()=>setSession(other);window.restoreTask=()=>setSession(sessionId);window.setLocale=setLocale;
 const running=Boolean(snapshot?.activeTurnId);window.running=running;
 const flow=useConversationPlanFlow({api,sessionId:activeSession,writableSessionId:activeSession,running,queuedTurnCount:snapshot?.queuedTurns.length ?? 0,serverReady:true,syncReady:true,compacting:false,interactionPending:false,collaborationMode:'default',itemOrder:[],itemsById:new Map(),clearError:()=>setError(''),reportError:error=>setError(error.message)});
 useEffect(()=>{const poll=async()=>{if(busy)return;busy=true;try{const result=await(await fetch('/poll?after='+cursor)).json();cursor=result.cursor;window.snapshot=result.snapshot;setSnapshot(result.snapshot);if(result.events.length)for(const listener of subscribers)listener({type:'app-server',envelope:{jsonrpc:'2.0',method:'connection/events',params:{events:result.events}}});}finally{busy=false;}};void poll();const timer=setInterval(poll,100);return()=>clearInterval(timer);},[]);
 return <FileSelectionProvider enabled={activeSession===sessionId} onSubmit={(sid,input)=>sid===sessionId?flow.submit(input):Promise.reject(new Error("This conversation is not ready to send"))}>
 <section id="conversation"><div id="messages">{snapshot?.recentItems.map(item=><div className={'message '+item.role} key={item.itemId}>{item.role==='user' && <MessageFileSelections selections={item.fileSelections}/>} {item.content.map((block,i)=><pre key={i}>{block.text ?? (block.type==='tool_result' ? block.name+': '+block.output:'')}</pre>)}</div>)}{snapshot?.queuedTurns.map(turn=><div className="queued" key={turn.queueItemId}>{turn.text}</div>)}</div><div id="error">{error}</div><Composer key={activeSession} disabled={false} running={running} onInterrupt={async()=>{}} onSubmit={flow.submit} selectionSessionId={activeSession}/></section>
 <aside id="preview">{workspaceFiles ? <WorkspaceFiles/> : <PreviewHost file={target} api={api} active={activeSession===sessionId} onError={console.error}/>}</aside>
 </FileSelectionProvider>;
}
await setLocale('en');createRoot(document.getElementById('root')).render(<App/>);
`,
			loader: "tsx",
			resolveDir: repo,
		},
		outfile: join(directory, "fixture.js"),
		bundle: true,
		platform: "browser",
		format: "esm",
		jsx: "automatic",
		logLevel: "silent",
	});
	const html = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/transcript-navigation.css"><style>:root{--app-bg:#171717;--panel:#262626;--text:#eee;--muted:#aaa;--border-strong:#555;--border:#444;--surface-08:#333;--overlay-shadow:0 4px 20px #0008}body{font-family:Arial}#root{display:flex;height:100vh;gap:20px;padding:12px}#conversation{flex:1;min-width:0;display:flex;flex-direction:column}#messages{flex:1;overflow:auto}#messages>.message{position:static}.message pre{white-space:pre-wrap;font:inherit;font-size:13px;padding:8px}.message.user{margin:8px 0 8px 12%;border-radius:12px;background:#303030}.message.tool{font-size:11px;color:#aaa}#preview{position:relative;width:480px;min-width:0;flex:none}.composer-dock{position:relative}.text-viewport{padding:20px}.file-markdown p{margin:18px 0}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
	browser = await chromium.launch({ channel: process.env.PREVIEW_BROWSER_CHANNEL ?? "chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.setDefaultTimeout(8000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator(".file-markdown").waitFor();
	const popup = page.locator(".file-selection-popover:popover-open");
	async function drag(text, occurrence = 0, reverse = false, rootSelector = ".text-viewport") {
		const points = await page.locator(rootSelector).evaluate(
			(root, { text, occurrence }) => {
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					const at = node.textContent.indexOf(text);
					if (at < 0 || occurrence-- > 0) continue;
					const first = document.createRange(),
						last = document.createRange();
					first.setStart(node, at);
					first.setEnd(node, at + 1);
					last.setStart(node, at + text.length - 1);
					last.setEnd(node, at + text.length);
					const a = first.getBoundingClientRect(),
						b = last.getBoundingClientRect();
					return {
						a: { x: a.left + 0.2, y: a.top + a.height / 2 },
						b: { x: b.right - 0.2, y: b.top + b.height / 2 },
					};
				}
				throw Error(`No text ${text}`);
			},
			{ text, occurrence },
		);
		const [a, b] = reverse ? [points.b, points.a] : [points.a, points.b];
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		await page.mouse.move(b.x, b.y, { steps: 12 });
		await page.mouse.up();
		try {
			await expect(popup).toBeVisible();
		} catch (error) {
			console.log(
				await page.evaluate(() => ({
					selection: getSelection()?.toString(),
					popup: document.querySelector(".file-selection-popover")?.outerHTML,
					error: document.querySelector(".selection-error")?.textContent,
				})),
			);
			console.log("pageErrors", errors);
			await page.screenshot({ path: join(directory, "failure.png") }).catch(() => {});
			throw error;
		}
	}
	async function geometry() {
		await expect
			.poll(async () => {
				const b = await popup.boundingBox(),
					size = page.viewportSize();
				return Boolean(
					b && b.x >= 7 && b.y >= 7 && b.x + b.width <= size.width + 1 && b.y + b.height <= size.height + 1,
				);
			})
			.toBe(true);
	}
	console.log(`Browser/runtime ready: ${directory}`);
	for (const width of [280, 480, 1000])
		for (const locale of ["en", "zh-CN"]) {
			await page.evaluate(
				({ width, locale }) => {
					document.getElementById("preview").style.width = `${width}px`;
					return window.setLocale(locale);
				},
				{ width, locale },
			);
			await drag("Original target sentence.", 0, width === 280);
			await geometry();
			const buttons = await popup.locator("button").all();
			assert.equal(buttons.length, 2);
			const [a, b] = await Promise.all(buttons.map((button) => button.boundingBox()));
			assert(a.x + a.width <= b.x + 1 || a.y + a.height <= b.y + 1);
			await buttons[0].click();
			await geometry();
			const input = popup.getByRole("textbox");
			const initialHeight = (await input.boundingBox()).height;
			assert(initialHeight <= 32);
			await input.fill("Please revise this part.\n".repeat(8));
			await expect.poll(async () => (await input.boundingBox()).height).toBeGreaterThan(initialHeight);
			assert((await input.boundingBox()).height <= 144);
			await geometry();
			await input.fill("");
			await expect.poll(async () => (await input.boundingBox()).height).toBe(initialHeight);
			await page.screenshot({ path: join(directory, `request-${width}-${locale}.png`) });
			await page.keyboard.press("Escape");
		}
	await page.evaluate(() => {
		document.getElementById("preview").style.width = "480px";
		return window.setLocale("en");
	});
	await drag("Repeated phrase", 1);
	await popup.getByRole("button", { name: "Add to conversation", exact: true }).click();
	await expect(page.locator(".composer-selections summary")).toContainText("1");
	await page.locator(".composer-selections summary").click();
	await expect(page.locator(".composer-selection")).toContainText("11");
	await page.locator("#composer-input").fill("Explain this reference");
	await page.locator("#composer-input").press("Enter");
	await expect.poll(() => requests.length).toBe(1);
	await expect.poll(() => models.some((call) => call.files[0]?.startLine === 11)).toBe(true);
	await expect(page.locator(".composer-selections")).toHaveCount(0);
	await expect.poll(() => page.evaluate(() => Boolean(window.snapshot && !window.snapshot.activeTurnId))).toBe(true);
	console.log("PASS add reference -> real runtime/model context");
	// The inline path keeps unrelated composer text and staged references intact, even on failure.
	await drag("Repeated phrase");
	await popup.getByRole("button", { name: "Add to conversation", exact: true }).click();
	await page.locator("#composer-input").fill("Keep this unsent draft");
	await drag("Original target sentence.");
	await popup.getByRole("button", { name: "Request changes", exact: true }).click();
	await popup.getByRole("textbox").fill("REPLACE this sentence");
	await page.keyboard.press("Escape");
	await expect(popup).toHaveCount(0);
	await drag("Original target sentence.");
	await popup.getByRole("button", { name: "Request changes", exact: true }).click();
	await expect(popup.getByRole("textbox")).toHaveValue("REPLACE this sentence");
	const beforeIme = requests.length;
	await popup
		.getByRole("textbox")
		.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
	assert.equal(requests.length, beforeIme);
	await page.setViewportSize({ width: 1100, height: 260 });
	await geometry();
	await page.locator(".text-viewport").evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(popup).toBeHidden();
	await page.locator(".text-viewport").evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect(popup).toBeVisible();
	await geometry();
	await page.setViewportSize({ width: 1280, height: 900 });
	await geometry();
	failNext = true;
	await popup.getByRole("button", { name: "Send change request", exact: true }).click();
	await expect(popup.getByRole("alert")).toContainText("rejected");
	await expect(popup.getByRole("textbox")).toHaveValue("REPLACE this sentence");
	await popup.getByRole("button", { name: "Send change request", exact: true }).click();
	await expect(page.locator(".file-markdown")).toContainText("Updated target sentence.");
	assert((await readFile(join(cwd, "notes.md"), "utf8")).includes("Updated target sentence."));
	await expect(page.locator("#composer-input")).toHaveText("Keep this unsent draft");
	await expect(page.locator(".composer-selections summary")).toContainText("1");
	await expect(page.locator(".message.user").last()).toContainText("Request changes to notes.md");
	await expect(page.locator(".message.user").last()).not.toContainText("file_selections");
	await expect
		.poll(() =>
			events.some(
				(event) =>
					event.type === "item/completed" &&
					event.item.content.some(
						(block) => block.type === "tool_result" && block.name === "edit" && !block.isError,
					),
			),
		)
		.toBe(true);
	console.log("PASS inline request -> read/edit -> file and preview update; failure preserves draft");
	// Expanded preview uses the same popover, then returns focus to the composer.
	await page.getByRole("button", { name: "Expand preview", exact: true }).click();
	await drag("Updated target sentence.");
	await popup.getByRole("button", { name: "Add to conversation", exact: true }).click();
	await expect(page.getByRole("button", { name: "Expand preview", exact: true })).toBeVisible();
	await expect(page.locator("#composer-input")).toBeFocused();
	// Returning to the task restores its notes reference alongside the new JSON fragment.
	await page.evaluate(() => window.switchTask());
	await expect(page.locator(".composer-selections")).toHaveCount(0);
	await page.evaluate(() => window.openFixture("data.json"));
	await expect(page.locator(".preview-plain-text")).toContainText("answer");
	await drag('"answer"');
	await popup.getByRole("button", { name: "Add to conversation", exact: true }).click();
	await page.locator("#composer-input").fill("Explain JSON");
	await page.locator("#composer-input").press("Enter");
	await expect.poll(() => requests.at(-1)?.params.text).toBe("Explain JSON");
	const jsonQuote = requests.at(-1).params.fileSelections.find((file) => file.relativePath === "data.json");
	assert.equal(jsonQuote?.basis, "formatted");
	assert.equal(jsonQuote.startLine, undefined);
	assert(requests.at(-1).params.fileSelections.some((file) => file.relativePath === "notes.md"));
	await expect.poll(() => page.evaluate(() => Boolean(window.snapshot && !window.snapshot.activeTurnId))).toBe(true);
	await page.evaluate(() => window.openFixture("code.ts"));
	await expect(page.locator(".preview-plain-text")).toContainText("const second");
	await drag("const first = 1;\nconst second = 2;", 0, true);
	await popup.getByRole("button", { name: "Add to conversation", exact: true }).click();
	await page.locator(".composer-selections summary").click();
	await expect(page.locator(".composer-selection")).toContainText("Lines 1–2");
	await page.getByRole("button", { name: "Remove reference code.ts", exact: true }).click();
	await drag("const second = 2;");
	await popup.getByRole("button", { name: "Add to conversation", exact: true }).click();
	await page.locator("#composer-input").fill("Explain code");
	await page.locator("#composer-input").press("Enter");
	await expect.poll(() => requests.at(-1)?.params.text).toBe("Explain code");
	assert.equal(requests.at(-1).params.fileSelections[0].startLine, 2);
	await expect.poll(() => page.evaluate(() => Boolean(window.snapshot && !window.snapshot.activeTurnId))).toBe(true);
	console.log("PASS expanded preview, task isolation, JSON and code");
	// Queue during a slow ordinary turn, then edit its public text without losing context.
	holdModel();
	await page.locator("#composer-input").fill("Slow ordinary turn");
	await page.locator("#composer-input").press("Enter");
	await expect.poll(() => page.evaluate(() => window.running)).toBe(true);
	await drag("const second = 2;");
	await popup.getByRole("button", { name: "Request changes", exact: true }).click();
	await popup.getByRole("textbox").fill("Explain queued selection");
	await popup.getByRole("button", { name: "Send change request", exact: true }).click();
	await expect.poll(() => requests.at(-1)?.method).toBe("turn/queue");
	const queue = (await opened.snapshot(epoch, () => events.length)).queuedTurns[0];
	assert(queue);
	await opened.updateQueuedTurn({
		sessionId,
		requestId: randomUUID(),
		queueItemId: queue.queueItemId,
		expectedRevision: queue.revision,
		text: "Explain edited queued selection",
	});
	releaseModel?.();
	await expect
		.poll(
			() =>
				models.some(
					(call) =>
						call.prompt.includes("Explain edited queued selection") &&
						call.files[0]?.selectedText === "const second = 2;",
				),
			{ timeout: 15000 },
		)
		.toBe(true);
	releaseModel?.();
	await expect.poll(() => opened.isActive(), { timeout: 15000 }).toBe(false);
	console.log("PASS queue edit retains selected-file context");
	// An accepted request whose response is lost retries with the original ID and is not executed twice.
	await page.evaluate(() => window.openFixture("notes.md"));
	await expect(page.locator(".file-markdown")).toContainText("Updated target sentence.");
	await drag("Updated target sentence.");
	await popup.getByRole("button", { name: "Request changes", exact: true }).click();
	await popup.getByRole("textbox").fill("Explain retry reference");
	loseNext = true;
	const beforeRetry = requests.length;
	await popup.getByRole("button", { name: "Send change request", exact: true }).click();
	await expect(popup.getByRole("alert")).toContainText("lost");
	await popup.getByRole("button", { name: "Send change request", exact: true }).click();
	await expect.poll(() => requests.length).toBe(beforeRetry + 2);
	assert.equal(requests[beforeRetry].params.requestId, requests[beforeRetry + 1].params.requestId);
	await expect.poll(() => opened.isActive(), { timeout: 15000 }).toBe(false);
	const retryMessages = (await opened.snapshot(epoch, () => events.length)).recentItems.filter(
		(item) => item.role === "user" && item.content.some((block) => block.text?.includes("Explain retry reference")),
	);
	assert.equal(retryMessages.length, 1);
	// Original delivered artifact stays immutable and the runtime delivers a new revision.
	await page.evaluate(() => window.openDelivered());
	await expect(page.locator(".file-markdown")).toContainText("Delivered original.");
	await drag("Delivered original.");
	await popup.getByRole("button", { name: "Request changes", exact: true }).click();
	await popup.getByRole("textbox").fill("REPLACE this delivered text");
	await popup.getByRole("button", { name: "Send change request", exact: true }).click();
	await expect
		.poll(async () => (await opened.snapshot(epoch, () => events.length)).deliveredFiles.length, { timeout: 15000 })
		.toBe(2);
	assert((await readFile(deliveredPath, "utf8")).includes("Delivered original."));
	assert((await readFile(join(cwd, "delivery-revised.md"), "utf8")).includes("Delivered revised."));
	console.log("PASS retry idempotency and delivered revision preservation");
	await expect.poll(() => opened.isActive(), { timeout: 15000 }).toBe(false);
	await page.screenshot({ path: join(directory, "completed.png") });
	// Document-specific selections flow through the same real runtime without a vision configuration.
	const sendDocumentRequest = async (instruction) => {
		await expect(popup.getByRole("button", { name: "Add to conversation", exact: true })).toHaveCount(0);
		await popup.getByRole("button", { name: "Request changes", exact: true }).click();
		await popup.getByRole("textbox").fill(instruction);
		await geometry();
		await popup.getByRole("button", { name: "Send change request", exact: true }).click();
		await expect.poll(() => models.some((m) => m.prompt.includes(instruction)), { timeout: 15000 }).toBe(true);
		await expect.poll(() => opened.isActive(), { timeout: 15000 }).toBe(false);
		return models.findLast((m) => m.prompt.includes(instruction)).files[0];
	};
	await page.evaluate(() => window.openFixture("objects.pptx"));
	await page.locator('.pptx-object-target[data-object-id="2"]').waitFor();
	await expect
		.poll(() =>
			page
				.locator(".pptx-render-host img")
				.evaluateAll((images) => images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)),
		)
		.toBe(true);
	for (const [id, type] of [
		["2", "shape"],
		["3", "picture"],
		["4", "chart"],
	]) {
		const object = page.locator('.pptx-object-target[data-object-id="' + id + '"]');
		await object.hover();
		await expect(page.locator(".file-selection-popover")).toHaveCount(0);
		assert.deepEqual(
			await object.evaluate((element) => {
				const style = getComputedStyle(element);
				return { background: style.backgroundColor, shadow: style.boxShadow };
			}),
			{ background: "rgba(0, 0, 0, 0)", shadow: "none" },
		);
		await object.click();
		const quote = await sendDocumentRequest("DOC " + type + " change");
		assert.equal(quote.target.objectId, id);
		assert.equal(quote.target.objectType, type);
		assert.equal(quote.target.slidePath, "ppt/slides/slide1.xml");
		assert.equal(quote.target.page, 1);
		if (type === "shape") assert.equal(quote.selectedText, "Selected title");
		if (type === "picture") assert.equal(JSON.parse(quote.sourceExcerpt).resource.target, "../media/image1.png");
		if (type === "chart") assert.equal(JSON.parse(quote.sourceExcerpt).chartPath, "ppt/charts/chart1.xml");
	}
	await page.screenshot({ path: join(directory, "pptx-object-requests.png") });
	await page.getByRole("button", { name: "Zoom in", exact: true }).click();
	await page.locator('.pptx-object-target[data-object-id="3"]').click();
	const zoomQuote = await sendDocumentRequest("DOC zoomed picture change");
	assert.equal(zoomQuote.target.objectId, "3");
	await page.evaluate(() => window.openFixture("document.pdf"));
	await expect(page.locator(".textLayer")).toContainText("PDF selected sentence.");
	await drag("PDF selected sentence.", 0, false, ".textLayer");
	const pdfQuote = await sendDocumentRequest("DOC pdf change");
	assert.deepEqual(pdfQuote.target, { kind: "pdf", page: 1 });
	assert(pdfQuote.selectedText.includes("PDF selected sentence."));
	await page.evaluate(() => window.openFixture("cells.xlsx"));
	await page.locator(".excel-cell").first().waitFor();
	await expect(page.locator(".excel-col-header").first()).toHaveText("C");
	await expect(page.locator(".excel-row-header").first()).toHaveText("5");
	const startCell = await page.locator(".excel-grid-row").first().locator(".excel-cell").first().boundingBox();
	await page.mouse.move(startCell.x + 10, startCell.y + 10);
	await page.mouse.down();
	await page.mouse.move(startCell.x + 100, startCell.y + 40, { steps: 5 });
	await page.mouse.up();
	await expect(page.locator(".excel-selection-info")).toContainText("C5:D6");
	await expect(page.locator(".excel-selection-info")).toContainText("=SUM(C6:C7)");
	const cellQuote = await sendDocumentRequest("DOC cells change");
	assert.deepEqual(cellQuote.target, { kind: "spreadsheet", sheet: "Revenue", range: "C5:D6" });
	assert(JSON.parse(cellQuote.sourceExcerpt).cells.some((c) => c.address === "C5" && c.formula === "SUM(C6:C7)"));
	await page.screenshot({ path: join(directory, "xlsx-cell-requests.png") });
	// Selecting a merged cell expands to the real merged range.
	await page.locator(".excel-merge").click();
	await expect(page.locator(".excel-selection-info")).toContainText("C8:D8");
	const mergeQuote = await sendDocumentRequest("DOC merged cells change");
	assert.equal(mergeQuote.target.range, "C8:D8");
	// Virtual rows retain absolute addresses after scrolling; blank cells remain selectable.
	await page.locator(".excel-viewport").evaluate((element) => {
		element.scrollTop = 2800;
	});
	const visibleRow = page
		.locator(".excel-grid-row")
		.filter({ has: page.locator(".excel-row-header", { hasText: /^110$/ }) });
	await visibleRow.locator(".excel-cell").last().click();
	const blankQuote = await sendDocumentRequest("DOC empty cell change");
	assert.equal(blankQuote.target.range, "E110");
	assert.equal(JSON.parse(blankQuote.sourceExcerpt).cells[0].value, null);
	console.log(
		"PASS PPTX shapes/pictures/charts, PDF native text, XLSX real ranges -> model context without vision gating",
	);
	// The actual file-tree entry point must support source selections and its own Markdown preview.
	await writeFile(join(cwd, "notes.md"), source);
	await page.evaluate(() => {
		document.getElementById("preview").style.width = "800px";
		window.openWorkspaceFiles();
	});
	await page.locator('button.file-tree-row-select[title="notes.md"]').click();
	await expect(page.locator(".cm-content")).toContainText("Original target sentence.");
	await drag("Original target sentence.", 0, true, ".cm-content");
	await popup.getByRole("button", { name: "Add to conversation", exact: true }).click();
	await expect(page.locator(".composer-selections summary")).toContainText("1");
	await page.locator("#composer-input").fill("Explain workspace source selection");
	await page.locator("#composer-input").press("Enter");
	await expect.poll(() => requests.at(-1)?.params.text).toBe("Explain workspace source selection");
	assert.equal(requests.at(-1).params.fileSelections[0].startLine, 3);
	await expect.poll(() => opened.isActive()).toBe(false);
	const sentQuote = page.locator(".message.user").last().locator(".message-file-selection");
	await expect(sentQuote).toHaveCount(1);
	await expect(sentQuote.locator("summary")).toContainText("notes.md");
	await expect(sentQuote.locator("summary")).toContainText("Lines 3–3");
	await sentQuote.locator("summary").click();
	await expect(sentQuote.locator("blockquote")).toBeVisible();
	await expect(sentQuote.locator("blockquote")).toHaveText("Original target sentence.");
	await page.screenshot({ path: join(directory, "sent-workspace-reference.png") });
	await page.getByRole("button", { name: "Show preview", exact: true }).click();
	await drag("Original target sentence.", 0, false, ".file-preview-body");
	await popup.getByRole("button", { name: "Request changes", exact: true }).click();
	await popup.getByRole("textbox").fill("REPLACE workspace Markdown selection");
	await popup.getByRole("button", { name: "Send change request", exact: true }).click();
	await expect
		.poll(() =>
			models.some(
				(call) =>
					call.prompt.includes("REPLACE workspace Markdown selection") && call.files[0]?.basis === "markdown",
			),
		)
		.toBe(true);
	await expect.poll(() => opened.isActive()).toBe(false);
	await expect(page.locator(".file-preview-body .file-markdown")).toContainText("Updated target sentence.");
	await page.getByRole("button", { name: "View source", exact: true }).click();
	await expect(page.locator(".cm-content")).toContainText("Updated target sentence.");
	await page.locator(".cm-content").click();
	await page.keyboard.press("ControlOrMeta+Home");
	await page.keyboard.type("Unsaved local text. ");
	await drag("Updated target sentence.", 0, false, ".cm-content");
	await expect(popup.getByRole("alert")).toContainText("Save this file");
	await expect(popup.getByRole("button", { name: "Add to conversation", exact: true })).toBeDisabled();
	await expect(popup.getByRole("button", { name: "Request changes", exact: true })).toBeDisabled();
	await expect(page.locator(".cm-content")).toContainText("Unsaved local text.");
	await page.screenshot({ path: join(directory, "workspace-file-selection.png") });
	console.log("PASS file tree -> CodeMirror source and Markdown preview -> conversation");
	// The same runtime sends literal conversation references as ordinary user context.
	await expect.poll(() => opened.isActive()).toBe(false);
	const beforeQuotes = await opened.snapshot(epoch, () => events.length);
	const quoteSource = [...beforeQuotes.recentItems].reverse().find((item) => item.role === "assistant" && item.content.some((block) => block.type === "text"));
	assert(quoteSource);
	const quoteText = quoteSource.content.find((block) => block.type === "text").text;
	const liveQuoteSource = [...events].reverse().find((event) => event.type === "item/completed" && event.item.role === "assistant" && event.item.itemId.startsWith("live:") && event.item.content.some((block) => block.text === quoteText))?.item;
	assert(liveQuoteSource, "The runtime must exercise a live message ID before normalizing quote provenance");
	const conversationQuotes = [{ sourceItemId: liveQuoteSource.itemId, sourceRole: "assistant", selectedText: quoteText }];
	await assert.rejects(opened.startTurn({ sessionId, requestId: randomUUID(), text: "Reject a foreign origin", conversationQuotes: [{ ...conversationQuotes[0], sourceItemId: "missing-source" }] }));
	await assert.rejects(opened.startTurn({ sessionId, requestId: randomUUID(), text: "Reject a false speaker", conversationQuotes: [{ ...conversationQuotes[0], sourceRole: "user" }] }));
	await opened.startTurn({ sessionId, requestId: randomUUID(), text: "Explain this conversation quote", conversationQuotes });
	await expect.poll(() => models.some((call) => call.prompt.includes("Explain this conversation quote") && call.quotes[0]?.selectedText === quoteText)).toBe(true);
	assert.equal(models.find((call) => call.prompt.includes("Explain this conversation quote")).role, "user");
	await expect.poll(() => opened.isActive()).toBe(false);
	holdModel();
	await opened.startTurn({ sessionId, requestId: randomUUID(), text: "Slow turn before quoted queue" });
	const quoteQueue = await opened.queueTurn({ sessionId, requestId: randomUUID(), text: "Explain queued conversation quote", conversationQuotes });
	await opened.updateQueuedTurn({ sessionId, requestId: randomUUID(), queueItemId: quoteQueue.queuedTurn.queueItemId, expectedRevision: quoteQueue.queuedTurn.revision, text: "Explain edited conversation quote" });
	releaseModel?.();
	await expect.poll(() => models.some((call) => call.prompt.includes("Explain edited conversation quote") && call.quotes[0]?.selectedText === quoteText), { timeout: 15000 }).toBe(true);
	await expect.poll(() => opened.isActive(), { timeout: 15000 }).toBe(false);
	holdModel();
	await opened.startTurn({ sessionId, requestId: randomUUID(), text: "Slow turn before quoted steering" });
	await opened.steer({ sessionId, requestId: randomUUID(), text: "Explain steered conversation quote", delivery: "follow_up", conversationQuotes });
	releaseModel?.();
	await expect.poll(() => models.some((call) => call.prompt.includes("Explain steered conversation quote") && call.quotes[0]?.selectedText === quoteText), { timeout: 15000 }).toBe(true);
	releaseModel?.();
	await expect.poll(() => opened.isActive(), { timeout: 15000 }).toBe(false);
	const liveQuoteView = (await opened.snapshot(epoch, () => events.length)).recentItems.find((item) => item.role === "user" && item.content.some((block) => block.text === "Explain this conversation quote"));
	assert.equal(liveQuoteView.conversationQuotes[0].sourceLiveItemId, liveQuoteSource.itemId);
	console.log("PASS conversation quotes -> ordinary model context, validated source, queued edit and follow-up steering");
	// Reopen the persisted session, retaining concise public messages and the durable quotes.
	await page.close();
	await opened.close();
	opened = await host.open(ref);
	const restored = await opened.snapshot(epoch, () => events.length);
	assert(restored.recentItems.some((item) => item.role === "user" && item.fileSelections?.some(
		(file) => file.name === "notes.md" && file.startLine === 3 && file.selectedText === "Original target sentence.",
	)));
	assert(
		restored.recentItems.some(
			(item) =>
				item.role === "user" && item.content.some((block) => block.text?.includes("Explain retry reference")),
		),
	);
	const restoredQuote = restored.recentItems.find((item) => item.role === "user" && item.content.some((block) => block.text === "Explain this conversation quote"));
	assert.equal(restoredQuote.conversationQuotes[0].selectedText, quoteText);
	assert.notEqual(restoredQuote.conversationQuotes[0].sourceItemId, liveQuoteSource.itemId);
	assert(restored.recentItems.some((item) => item.itemId === restoredQuote.conversationQuotes[0].sourceItemId && item.role === "assistant"));
	assert(!restoredQuote.content.some((block) => block.text?.includes("conversation_quotes")));
	const journal = await readFile(sessionFile, "utf8");
	assert(journal.includes("conversation_quotes"));
	assert(!journal.includes("sourceLiveItemId"));
	assert(journal.includes("file_selections"));
	assert(
		!restored.recentItems
			.filter((item) => item.role === "user")
			.some((item) => JSON.stringify(item).includes("file_selections")),
	);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			ok: true,
			directory,
			requests: requests.length,
			modelCalls: models.length,
			checks: [
				"responsive popover, scrolling and resize",
				"dismiss and restore inline draft",
				"IME",
				"multiline reverse selection",
				"real mouse selection",
				"composer reference",
				"inline request",
				"read/edit tools",
				"refresh",
				"failure",
				"session isolation",
				"queue edit",
				"retry dedup",
				"delivered revision",
				"history restore",
				"conversation quotes: model user context, source validation, queue edits, steering and stable restored source IDs",
				"workspace file tree: source and Markdown",
				"workspace clean draft refresh and unsaved edit guard",
				"PPTX object, PDF text, XLSX cell target context without vision gating",
			],
		}),
	);
} finally {
	releaseModel?.();
	await browser?.close();
	await opened?.close();
	if (server) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}
