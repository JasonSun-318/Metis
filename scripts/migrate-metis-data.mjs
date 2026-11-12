#!/usr/bin/env node
/**
 * Migrate Metis desktop data after installing the unified build.
 *
 * The unified app no longer reads retired chat/code session state, so this
 * script rewrites old data before the first launch:
 *   1. removes the retired `mode` header field from session and agent journals;
 *   2. migrates desktop localStorage (project preferences v2/v1 -> v3,
 *      session grouping v1 -> v2, and a missing UI work mode).
 *
 * Dry run by default. `--apply` backs up journals and the Electron Local
 * Storage directory before changing anything and requires the app to be closed.
 * The app is opened briefly only to reach localStorage through the DevTools
 * protocol and is closed again by the script.
 *
 * Usage:
 *   node scripts/migrate-metis-data.mjs                 # report only
 *   node scripts/migrate-metis-data.mjs --apply         # migrate
 *   node scripts/migrate-metis-data.mjs --app /Applications/Metis.app --apply
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applySessionModeMigration, findActiveLocks, planSessionModeMigration } from "./migrate-session-modes.mjs";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

const DEFAULT_APP = "/Applications/Metis.app";
const DEFAULT_PORT = 9333;
const LOCAL_STORAGE = "Local Storage";

/**
 * Migrate browser localStorage holding pre-unification desktop preferences.
 * When `apply` is false, only report what would change.
 */
export function migrateLocalStorageData(storage, apply = true) {
	// This function is serialized into the renderer, so every value it uses must
	// be defined inside it.
	const workModeKey = "metis.work-mode.v1";
	const projectPreferencesKey = "metis.projectPreferences.v3";
	const legacyProjectKeys = ["metis.projectPreferences.v2", "metis.projectPreferences.v1"];
	const sessionGroupingKey = "metis.session-grouping.v2";
	const legacySessionGroupingKey = "metis.session-grouping.v1";
	const groupingValues = ["date", "project", "status", "unread", "none"];
	const maxAliasCodePoints = 80;
	const report = {
		workMode: null,
		projectPreferences: false,
		sessionGrouping: false,
		removedLegacyKeys: false,
	};
	const storedWorkMode = storage.getItem(workModeKey);
	if (storedWorkMode !== "chat" && storedWorkMode !== "code") {
		const derived = storage.getItem("metis.activeSessionId.code") ? "code" : "chat";
		report.workMode = derived;
		if (apply) storage.setItem(workModeKey, derived);
	}

	let hasProjectPreferences = false;
	try {
		const parsed = JSON.parse(storage.getItem(projectPreferencesKey) ?? "null");
		hasProjectPreferences = parsed?.version === 1 && Array.isArray(parsed.entries);
	} catch {
		hasProjectPreferences = false;
	}
	if (!hasProjectPreferences) {
		const workMode = report.workMode ?? storage.getItem(workModeKey) ?? "chat";
		let migrated = [];
		for (const key of legacyProjectKeys) {
			const raw = storage.getItem(key);
			if (raw === null) continue;
			try {
				const parsed = JSON.parse(raw);
				if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) continue;
				const ranked = parsed.entries
					.map((entry) => ({ entry, mode: entry?.mode }))
					.filter(
						({ entry }) =>
							entry &&
							typeof entry.cwd === "string" &&
							entry.cwd.trim().length > 0 &&
							typeof entry.pinned === "boolean",
					)
					.sort((left, right) => Number(right.mode === workMode) - Number(left.mode === workMode));
				const byCwd = new Map();
				for (const { entry } of ranked) {
					if (byCwd.has(entry.cwd)) continue;
					const alias =
						typeof entry.alias === "string" && entry.alias.trim()
							? [...entry.alias.trim()].slice(0, maxAliasCodePoints).join("")
							: undefined;
					byCwd.set(entry.cwd, { cwd: entry.cwd, pinned: entry.pinned, ...(alias ? { alias } : {}) });
				}
				migrated = [...byCwd.values()];
				break;
			} catch {}
		}
		if (migrated.length > 0) {
			report.projectPreferences = true;
			if (apply) storage.setItem(projectPreferencesKey, JSON.stringify({ version: 1, entries: migrated }));
		}
	}

	const grouping = storage.getItem(sessionGroupingKey);
	const legacyGrouping = storage.getItem(legacySessionGroupingKey);
	if ((!grouping || !groupingValues.includes(grouping)) && legacyGrouping !== null) {
		const workMode = report.workMode ?? storage.getItem(workModeKey) ?? "chat";
		let migrated = "date";
		try {
			const legacy = JSON.parse(legacyGrouping ?? "null");
			const candidate = legacy?.[workMode];
			if (groupingValues.includes(candidate)) migrated = candidate;
		} catch {
			// Keep daily grouping.
		}
		report.sessionGrouping = true;
		if (apply) storage.setItem(sessionGroupingKey, migrated);
	}

	const legacyKeys = [...legacyProjectKeys, legacySessionGroupingKey];
	report.removedLegacyKeys = legacyKeys.some((key) => storage.getItem(key) !== null);
	if (apply) for (const key of legacyKeys) storage.removeItem(key);
	return report;
}

function readJson(url) {
	return fetch(url).then((response) => (response.ok ? response.json() : undefined));
}

function sleep(milliseconds) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitForRendererTarget(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const targets = await readJson(`http://127.0.0.1:${port}/json`);
			const target = targets?.find((entry) => entry.type === "page" && String(entry.url).includes("renderer"));
			if (target?.webSocketDebuggerUrl) return target;
		} catch {
			// The app is still starting.
		}
		await sleep(250);
	}
	throw new Error(`The app did not expose a renderer on port ${port}. Is another Metis instance running?`);
}

async function withDevTools(port, appPath, run) {
	const binary = join(appPath, "Contents/MacOS/Metis");
	if (!existsSync(binary)) throw new Error(`Metis binary not found: ${binary}`);
	const child = spawn(binary, [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore" });
	child.unref();
	try {
		const target = await waitForRendererTarget(port, 30_000);
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolveOpen, rejectOpen) => {
			const timer = setTimeout(() => rejectOpen(new Error("Timed out connecting to the app")), 10_000);
			socket.once("open", () => {
				clearTimeout(timer);
				resolveOpen();
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				rejectOpen(error);
			});
		});
		try {
			let nextId = 1;
			const pending = new Map();
			socket.on("message", (data) => {
				const message = JSON.parse(String(data));
				if (message.id !== undefined && pending.has(message.id)) {
					pending.get(message.id)(message);
					pending.delete(message.id);
				}
			});
			const call = (method, params = {}) => {
				const id = nextId++;
				return new Promise((resolveCall) => {
					pending.set(id, resolveCall);
					socket.send(JSON.stringify({ id, method, params }));
				});
			};
			const result = await run(call);
			socket.close();
			return result;
		} finally {
			socket.close();
		}
	} finally {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			// The app already exited.
		}
		try {
			execFileSync("pkill", ["-f", binary], { stdio: "ignore" });
		} catch {
			// The app already exited.
		}
	}
}

async function migrateStorageThroughApp({ appPath, port, apply }) {
	return withDevTools(port, appPath, async (call) => {
		const expression = `(${migrateLocalStorageData.toString()})(localStorage, ${apply ? "true" : "false"})`;
		const response = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (response.result?.exceptionDetails) {
			throw new Error(response.result.exceptionDetails.text ?? "localStorage migration failed");
		}
		return response.result?.result?.value;
	});
}

function backupDirectory(label) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const target = join(homedir(), "Metis-backups", `${label}-${stamp}`);
	mkdirSync(dirname(target), { recursive: true });
	return target;
}

function appIsRunning() {
	try {
		execFileSync("pgrep", ["-f", "Metis.app/Contents/MacOS/Metis"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function parseArgs(argv) {
	const options = {
		apply: false,
		agentDir: join(homedir(), ".metis", "agent"),
		app: DEFAULT_APP,
		port: DEFAULT_PORT,
		json: false,
		force: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--apply") options.apply = true;
		else if (argument === "--json") options.json = true;
		else if (argument === "--force") options.force = true;
		else if (argument === "--agent-dir") options.agentDir = resolve(argv[++index] ?? "");
		else if (argument === "--app") options.app = resolve(argv[++index] ?? "");
		else if (argument === "--port") options.port = Number.parseInt(argv[++index] ?? "", 10);
		else if (argument === "--help" || argument === "-h") {
			console.log(`Usage: node scripts/migrate-metis-data.mjs [options]

  --apply            Apply the migration (dry run by default)
  --app <path>       Metis.app path (default: ${DEFAULT_APP})
  --agent-dir <dir>  Metis agent directory (default: ~/.metis/agent)
  --port <port>      Temporary debugging port (default: ${DEFAULT_PORT})
  --json             Print machine-readable output
  --force            Migrate even when stale session leases exist (app/CLI must be closed)`);
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${argument}`);
			process.exit(2);
		}
	}
	return options;
}

async function run() {
	const options = parseArgs(process.argv.slice(2));
	if (appIsRunning()) {
		console.error("Close Metis before running this migration.");
		process.exit(1);
	}
	const report = { mode: options.apply ? "apply" : "dry-run", agentDir: options.agentDir, app: options.app };
	const locks = findActiveLocks({ agentDir: options.agentDir });
	if (locks.length > 0) {
		report.sessionLocks = locks.length;
		if (options.apply && !options.force) {
			console.error("Session leases are present; close Metis and the CLI, or pass --force for stale leases.");
			process.exit(1);
		}
	}
	const { entries, errors } = planSessionModeMigration({ agentDir: options.agentDir });
	report.journals = { changed: entries.length, errors: errors.length };
	if (errors.length > 0) {
		for (const error of errors) console.error(`Cannot migrate ${error.relativePath}: ${error.error}`);
		process.exit(1);
	}

	if (options.apply && entries.length > 0) {
		const result = applySessionModeMigration({
			agentDir: options.agentDir,
			backupDir: backupDirectory("sessions"),
		});
		report.journalBackup = result.backupDir;
		report.journals.migrated = result.migrated.length;
	}

	const localStorageDir = join(homedir(), "Library", "Application Support", "Metis", LOCAL_STORAGE);
	if (options.apply && existsSync(localStorageDir)) {
		const backup = backupDirectory("local-storage");
		cpSync(localStorageDir, backup, { recursive: true });
		report.localStorageBackup = backup;
	}
	report.storage = await migrateStorageThroughApp({
		appPath: options.app,
		port: options.port,
		apply: options.apply,
	});

	if (options.json) console.log(JSON.stringify(report, null, 2));
	else {
		console.log(`Metis desktop data migration (${report.mode})`);
		console.log(`Journals with a retired mode: ${report.journals.changed}`);
		if (report.journalBackup) console.log(`Journal backup: ${report.journalBackup}`);
		if (report.localStorageBackup) console.log(`Local Storage backup: ${report.localStorageBackup}`);
		console.log(`UI work mode: ${report.storage.workMode ?? "unchanged"}`);
		console.log(
			`Project preferences: ${report.storage.projectPreferences ? "migrated" : "no change"}; session grouping: ${report.storage.sessionGrouping ? "migrated" : "no change"}`,
		);
		if (report.storage.removedLegacyKeys)
			console.log(options.apply ? "Removed retired preference keys." : "Would remove retired preference keys.");
		if (!options.apply) console.log("Dry run only; pass --apply to back up and migrate.");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	run().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
