import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockMock = vi.hoisted(() => ({
	lockSync: vi.fn(),
	lock: vi.fn(),
}));

vi.mock("proper-lockfile", () => ({
	default: {
		lockSync: lockMock.lockSync,
		lock: lockMock.lock,
	},
}));

import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { getPluginLockPath, getPluginRegistryPath, withPluginRegistryLock } from "../src/core/plugins/registry.ts";
import { FileSettingsStorage } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

type LockFailure = Error & { code: string };

function lockFailure(code = "ELOCKED", message = `simulated ${code}`): LockFailure {
	return Object.assign(new Error(message), { code });
}

function captureError(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("Expected operation to throw");
}

/**
 * Deterministic busy-wait clock. Each Date.now call returns a value and then
 * advances by stepMs. With stepMs === the retry delay, one busy wait consumes
 * exactly two reads: the start timestamp and the first timestamp that has
 * reached the delay.
 */
function installClock(stepMs: number): number[] {
	const calls: number[] = [];
	let now = 1_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => {
		const value = now;
		calls.push(value);
		now += stepMs;
		return value;
	});
	return calls;
}

function expectRetryWaits(clockCalls: number[], delayMs: number, waits: number): void {
	expect(clockCalls).toHaveLength(waits * 2);
	for (let index = 0; index < waits; index++) {
		expect(clockCalls[index * 2 + 1] - clockCalls[index * 2]).toBe(delayMs);
	}
}

function jsonFile<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

const CHILD_TIMEOUT_MS = 20_000;

interface ChildOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

function trackChild(child: ChildProcess): { outcome: Promise<ChildOutcome> } {
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const outcome = new Promise<ChildOutcome>((resolveOutcome, rejectOutcome) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			rejectOutcome(
				new Error(`child process timed out after ${CHILD_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`),
			);
		}, CHILD_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			rejectOutcome(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolveOutcome({ code, signal, stdout, stderr });
		});
	});
	// Avoid an unhandled rejection when an assertion fails before the outcome is awaited.
	outcome.catch(() => {});
	return { outcome };
}

describe("lock caller compatibility", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "metis-lock-callers-"));
		lockMock.lockSync.mockReset();
		lockMock.lock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	describe("FileAuthStorageBackend.withLock", () => {
		function authSetup(): { authPath: string; backend: FileAuthStorageBackend } {
			const authPath = join(tempRoot, "agent", "auth.json");
			return { authPath, backend: new FileAuthStorageBackend(authPath) };
		}

		it("locks auth.json with 10x20, reads under lock and releases after publishing", () => {
			const clock = installClock(20);
			const { authPath, backend } = authSetup();
			const next = JSON.stringify({ token: "next" });
			const events: string[] = [];
			const release = vi.fn(() => {
				events.push("release");
				expect(readFileSync(authPath, "utf8")).toBe(next);
			});
			lockMock.lockSync.mockImplementation(() => {
				events.push("lock");
				expect(existsSync(authPath)).toBe(true);
				expect(readFileSync(authPath, "utf8")).toBe("{}");
				return release;
			});

			const result = backend.withLock((current) => {
				events.push("callback");
				expect(current).toBe("{}");
				expect(readFileSync(authPath, "utf8")).toBe("{}");
				return { result: "ok", next };
			});

			expect(result).toBe("ok");
			expect(events).toEqual(["lock", "callback", "release"]);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(lockMock.lockSync).toHaveBeenCalledWith(authPath, { realpath: false });
			expect(release).toHaveBeenCalledTimes(1);
			expect(readFileSync(authPath, "utf8")).toBe(next);
			expect(clock).toEqual([]);
		});

		it("initializes a missing auth file before locking, even when acquisition fails", () => {
			const clock = installClock(20);
			const { authPath, backend } = authSetup();
			const error = lockFailure("EACCES", "permission denied");
			lockMock.lockSync.mockImplementation(() => {
				throw error;
			});
			const callback = vi.fn();

			expect(captureError(() => backend.withLock(callback))).toBe(error);
			expect(callback).not.toHaveBeenCalled();
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(readFileSync(authPath, "utf8")).toBe("{}");
			expect(clock).toEqual([]);
		});

		it("propagates a raw non-ELOCKED error immediately and leaves existing content untouched", () => {
			const clock = installClock(20);
			const { authPath, backend } = authSetup();
			mkdirSync(join(tempRoot, "agent"), { recursive: true });
			writeFileSync(authPath, JSON.stringify({ keep: true }));
			const error = lockFailure("EIO", "disk error");
			lockMock.lockSync.mockImplementation(() => {
				throw error;
			});
			const callback = vi.fn();

			expect(captureError(() => backend.withLock(callback))).toBe(error);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(callback).not.toHaveBeenCalled();
			expect(readFileSync(authPath, "utf8")).toBe(JSON.stringify({ keep: true }));
			expect(clock).toEqual([]);
		});

		it("retries ELOCKED 10 times and throws the final raw error without invoking the callback", () => {
			const clock = installClock(20);
			const { authPath, backend } = authSetup();
			const errors = Array.from({ length: 10 }, (_value, index) =>
				lockFailure("ELOCKED", `locked attempt ${index + 1}`),
			);
			let attempt = 0;
			lockMock.lockSync.mockImplementation(() => {
				throw errors[attempt++];
			});
			const callback = vi.fn();

			expect(captureError(() => backend.withLock(callback))).toBe(errors[9]);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(10);
			expect(callback).not.toHaveBeenCalled();
			expectRetryWaits(clock, 20, 9);
			expect(readFileSync(authPath, "utf8")).toBe("{}");
		});

		it("recovers on a later ELOCKED attempt and releases exactly once", () => {
			const clock = installClock(20);
			const { authPath, backend } = authSetup();
			const next = JSON.stringify({ token: "recovered" });
			const release = vi.fn();
			let attempt = 0;
			lockMock.lockSync.mockImplementation(() => {
				if (attempt < 3) {
					attempt++;
					throw lockFailure("ELOCKED");
				}
				return release;
			});

			const result = backend.withLock(() => ({ result: "recovered", next }));

			expect(result).toBe("recovered");
			expect(lockMock.lockSync).toHaveBeenCalledTimes(4);
			expect(release).toHaveBeenCalledTimes(1);
			expectRetryWaits(clock, 20, 3);
			expect(readFileSync(authPath, "utf8")).toBe(next);
		});

		it("releases exactly once and does not write when the callback throws", () => {
			const { authPath, backend } = authSetup();
			const release = vi.fn();
			lockMock.lockSync.mockReturnValue(release);
			const callbackError = new Error("callback failed");

			expect(
				captureError(() =>
					backend.withLock(() => {
						throw callbackError;
					}),
				),
			).toBe(callbackError);
			expect(release).toHaveBeenCalledTimes(1);
			expect(readFileSync(authPath, "utf8")).toBe("{}");
		});

		it("gives a release failure precedence over a callback failure", () => {
			const { backend } = authSetup();
			const callbackError = new Error("callback failed");
			const releaseError = new Error("release failed");
			lockMock.lockSync.mockReturnValue(() => {
				throw releaseError;
			});

			expect(
				captureError(() =>
					backend.withLock(() => {
						throw callbackError;
					}),
				),
			).toBe(releaseError);
		});
	});

	describe("FileSettingsStorage.withLock", () => {
		let agentDir: string;
		let projectDir: string;
		let globalPath: string;
		let projectPath: string;

		beforeEach(() => {
			agentDir = join(tempRoot, "agent");
			projectDir = join(tempRoot, "project");
			globalPath = join(agentDir, "settings.json");
			projectPath = join(projectDir, ".metis", "settings.json");
		});

		it("locks an existing settings file before reading, writes, and releases once", () => {
			const clock = installClock(20);
			mkdirSync(agentDir, { recursive: true });
			const previous = JSON.stringify({ theme: "dark" });
			const next = JSON.stringify({ theme: "light" });
			writeFileSync(globalPath, previous);
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const events: string[] = [];
			const release = vi.fn(() => {
				events.push("release");
				expect(readFileSync(globalPath, "utf8")).toBe(next);
			});
			lockMock.lockSync.mockImplementation(() => {
				events.push("lock");
				expect(readFileSync(globalPath, "utf8")).toBe(previous);
				return release;
			});

			const result = storage.withLock("global", (current) => {
				events.push("callback");
				expect(current).toBe(previous);
				return next;
			});

			expect(result).toBeUndefined();
			expect(events).toEqual(["lock", "callback", "release"]);
			expect(lockMock.lockSync).toHaveBeenCalledWith(globalPath, { realpath: false });
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(release).toHaveBeenCalledTimes(1);
			expect(readFileSync(globalPath, "utf8")).toBe(next);
			expect(clock).toEqual([]);
		});

		it("does not lock, create directories or create the file for a missing read-only file", () => {
			const clock = installClock(20);
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const callback = vi.fn(() => undefined);

			storage.withLock("global", callback);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(undefined);
			expect(lockMock.lockSync).not.toHaveBeenCalled();
			expect(existsSync(agentDir)).toBe(false);
			expect(existsSync(globalPath)).toBe(false);
			expect(clock).toEqual([]);
		});

		it("runs the callback before locking and only creates the directory when writing", () => {
			const clock = installClock(20);
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const next = JSON.stringify({ theme: "light" });
			const events: string[] = [];
			const release = vi.fn(() => {
				events.push("release");
				expect(readFileSync(globalPath, "utf8")).toBe(next);
			});
			lockMock.lockSync.mockImplementation(() => {
				events.push("lock");
				expect(existsSync(agentDir)).toBe(true);
				return release;
			});

			storage.withLock("global", (current) => {
				events.push("callback");
				expect(current).toBeUndefined();
				expect(existsSync(agentDir)).toBe(false);
				expect(lockMock.lockSync).not.toHaveBeenCalled();
				return next;
			});

			expect(events).toEqual(["callback", "lock", "release"]);
			expect(lockMock.lockSync).toHaveBeenCalledWith(globalPath, { realpath: false });
			expect(release).toHaveBeenCalledTimes(1);
			expect(readFileSync(globalPath, "utf8")).toBe(next);
			expect(clock).toEqual([]);
		});

		it("uses the project settings path for project scope", () => {
			mkdirSync(join(projectDir, ".metis"), { recursive: true });
			const previous = JSON.stringify({ theme: "project-dark" });
			writeFileSync(projectPath, previous);
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const release = vi.fn();
			lockMock.lockSync.mockReturnValue(release);
			const currentValues: Array<string | undefined> = [];

			storage.withLock("project", (current) => {
				currentValues.push(current);
				return undefined;
			});

			expect(currentValues).toEqual([previous]);
			expect(lockMock.lockSync).toHaveBeenCalledWith(projectPath, { realpath: false });
			expect(release).toHaveBeenCalledTimes(1);
		});

		it("runs the callback before a failing write acquisition for a missing file and writes nothing", () => {
			const clock = installClock(20);
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const error = lockFailure("EIO", "disk error");
			const events: string[] = [];
			lockMock.lockSync.mockImplementation(() => {
				events.push("lock");
				throw error;
			});

			expect(
				captureError(() =>
					storage.withLock("global", () => {
						events.push("callback");
						return JSON.stringify({ theme: "light" });
					}),
				),
			).toBe(error);
			expect(events).toEqual(["callback", "lock"]);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(existsSync(agentDir)).toBe(true);
			expect(existsSync(globalPath)).toBe(false);
			expect(clock).toEqual([]);
		});

		it("propagates a raw lock error without reading a corrupt settings file", () => {
			const clock = installClock(20);
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(globalPath, "{ invalid json");
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const error = lockFailure("EIO", "disk error");
			lockMock.lockSync.mockImplementation(() => {
				throw error;
			});
			const callback = vi.fn();

			expect(captureError(() => storage.withLock("global", callback))).toBe(error);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(callback).not.toHaveBeenCalled();
			expect(readFileSync(globalPath, "utf8")).toBe("{ invalid json");
			expect(clock).toEqual([]);
		});

		it("retries ELOCKED 10 times and throws the final raw error", () => {
			const clock = installClock(20);
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(globalPath, "{}");
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const errors = Array.from({ length: 10 }, (_value, index) =>
				lockFailure("ELOCKED", `locked attempt ${index + 1}`),
			);
			let attempt = 0;
			lockMock.lockSync.mockImplementation(() => {
				throw errors[attempt++];
			});
			const callback = vi.fn();

			expect(captureError(() => storage.withLock("global", callback))).toBe(errors[9]);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(10);
			expect(callback).not.toHaveBeenCalled();
			expectRetryWaits(clock, 20, 9);
			expect(readFileSync(globalPath, "utf8")).toBe("{}");
		});

		it("releases exactly once and does not write when the callback throws", () => {
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(globalPath, "{}");
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const release = vi.fn();
			lockMock.lockSync.mockReturnValue(release);
			const callbackError = new Error("callback failed");

			expect(
				captureError(() =>
					storage.withLock("global", () => {
						throw callbackError;
					}),
				),
			).toBe(callbackError);
			expect(release).toHaveBeenCalledTimes(1);
			expect(readFileSync(globalPath, "utf8")).toBe("{}");
		});

		it("gives a release failure precedence over a callback failure", () => {
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(globalPath, "{}");
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const releaseError = new Error("release failed");
			lockMock.lockSync.mockReturnValue(() => {
				throw releaseError;
			});
			const callbackError = new Error("callback failed");

			expect(
				captureError(() =>
					storage.withLock("global", () => {
						throw callbackError;
					}),
				),
			).toBe(releaseError);
		});
	});

	describe("FileSettingsStorage.withWriteLock", () => {
		let agentDir: string;
		let projectDir: string;
		let globalPath: string;

		beforeEach(() => {
			agentDir = join(tempRoot, "agent");
			projectDir = join(tempRoot, "project");
			globalPath = join(agentDir, "settings.json");
		});

		it("creates the directory and acquires the lock before reading a missing file", () => {
			const clock = installClock(20);
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const next = JSON.stringify({ theme: "light" });
			const events: string[] = [];
			const release = vi.fn(() => {
				events.push("release");
				expect(readFileSync(globalPath, "utf8")).toBe(next);
			});
			lockMock.lockSync.mockImplementation(() => {
				events.push("lock");
				expect(existsSync(agentDir)).toBe(true);
				return release;
			});

			storage.withWriteLock("global", (current) => {
				events.push("callback");
				expect(current).toBeUndefined();
				expect(existsSync(globalPath)).toBe(false);
				return next;
			});

			expect(events).toEqual(["lock", "callback", "release"]);
			expect(lockMock.lockSync).toHaveBeenCalledWith(globalPath, { realpath: false });
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(release).toHaveBeenCalledTimes(1);
			expect(readFileSync(globalPath, "utf8")).toBe(next);
			expect(clock).toEqual([]);
		});

		it("reads an existing file under the lock and writes after the callback", () => {
			mkdirSync(agentDir, { recursive: true });
			const previous = JSON.stringify({ theme: "dark" });
			const next = JSON.stringify({ theme: "light" });
			writeFileSync(globalPath, previous);
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const release = vi.fn();
			lockMock.lockSync.mockReturnValue(release);
			const currentValues: Array<string | undefined> = [];

			storage.withWriteLock("global", (current) => {
				currentValues.push(current);
				return next;
			});

			expect(currentValues).toEqual([previous]);
			expect(release).toHaveBeenCalledTimes(1);
			expect(readFileSync(globalPath, "utf8")).toBe(next);
		});

		it("propagates a raw lock error without reading or writing", () => {
			const clock = installClock(20);
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const error = lockFailure("EIO", "disk error");
			lockMock.lockSync.mockImplementation(() => {
				throw error;
			});
			const callback = vi.fn();

			expect(captureError(() => storage.withWriteLock("global", callback))).toBe(error);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(callback).not.toHaveBeenCalled();
			expect(existsSync(agentDir)).toBe(true);
			expect(existsSync(globalPath)).toBe(false);
			expect(clock).toEqual([]);
		});

		it("retries ELOCKED 10 times and throws the final raw error", () => {
			const clock = installClock(20);
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const errors = Array.from({ length: 10 }, (_value, index) =>
				lockFailure("ELOCKED", `locked attempt ${index + 1}`),
			);
			let attempt = 0;
			lockMock.lockSync.mockImplementation(() => {
				throw errors[attempt++];
			});
			const callback = vi.fn();

			expect(captureError(() => storage.withWriteLock("global", callback))).toBe(errors[9]);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(10);
			expect(callback).not.toHaveBeenCalled();
			expectRetryWaits(clock, 20, 9);
			expect(existsSync(globalPath)).toBe(false);
		});

		it("releases exactly once and gives release failure precedence over callback failure", () => {
			const storage = new FileSettingsStorage(projectDir, agentDir);
			const releaseError = new Error("release failed");
			const release = vi.fn(() => {
				throw releaseError;
			});
			lockMock.lockSync.mockReturnValue(release);

			expect(
				captureError(() =>
					storage.withWriteLock("global", () => {
						throw new Error("callback failed");
					}),
				),
			).toBe(releaseError);
			expect(release).toHaveBeenCalledTimes(1);
			expect(existsSync(globalPath)).toBe(false);
		});
	});

	describe("withPluginRegistryLock", () => {
		let agentDir: string;
		let registryPath: string;
		let lockPath: string;

		beforeEach(() => {
			agentDir = join(tempRoot, "agent");
			registryPath = getPluginRegistryPath(agentDir);
			lockPath = getPluginLockPath(agentDir);
		});

		it("initializes the lock file, reads the registry under lock and releases after publishing", () => {
			const clock = installClock(25);
			const events: string[] = [];
			const release = vi.fn(() => {
				events.push("release");
				expect(jsonFile<{ revision: number }>(registryPath).revision).toBe(2);
			});
			lockMock.lockSync.mockImplementation(() => {
				events.push("lock");
				expect(existsSync(lockPath)).toBe(true);
				expect(readFileSync(lockPath, "utf8")).toBe("");
				expect(existsSync(registryPath)).toBe(false);
				return release;
			});

			const result = withPluginRegistryLock(agentDir, (current) => {
				events.push("callback");
				expect(current.revision).toBe(1);
				expect(existsSync(registryPath)).toBe(true);
				return { next: { ...current, revision: 2 }, result: "updated" };
			});

			expect(result).toBe("updated");
			expect(events).toEqual(["lock", "callback", "release"]);
			expect(lockMock.lockSync).toHaveBeenCalledWith(lockPath, { realpath: false });
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(release).toHaveBeenCalledTimes(1);
			expect(jsonFile<{ revision: number }>(registryPath).revision).toBe(2);
			expect(clock).toEqual([]);
		});

		it("propagates a raw non-ELOCKED error without reading a corrupt registry", () => {
			const clock = installClock(25);
			mkdirSync(join(agentDir, "plugins"), { recursive: true });
			writeFileSync(registryPath, "{ invalid json");
			const error = lockFailure("EIO", "disk error");
			lockMock.lockSync.mockImplementation(() => {
				throw error;
			});
			const callback = vi.fn();

			expect(captureError(() => withPluginRegistryLock(agentDir, callback))).toBe(error);
			expect(callback).not.toHaveBeenCalled();
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(existsSync(lockPath)).toBe(true);
			expect(readFileSync(registryPath, "utf8")).toBe("{ invalid json");
			expect(clock).toEqual([]);
		});

		it("retries ELOCKED 20 times and throws the final raw error without reading the registry", () => {
			const clock = installClock(25);
			const errors = Array.from({ length: 20 }, (_value, index) =>
				lockFailure("ELOCKED", `locked attempt ${index + 1}`),
			);
			let attempt = 0;
			lockMock.lockSync.mockImplementation(() => {
				throw errors[attempt++];
			});
			const callback = vi.fn();

			expect(captureError(() => withPluginRegistryLock(agentDir, callback))).toBe(errors[19]);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(20);
			expect(callback).not.toHaveBeenCalled();
			expectRetryWaits(clock, 25, 19);
			expect(existsSync(lockPath)).toBe(true);
			expect(existsSync(registryPath)).toBe(false);
		});

		it("recovers on a later ELOCKED attempt and releases exactly once", () => {
			const clock = installClock(25);
			const release = vi.fn();
			let attempt = 0;
			lockMock.lockSync.mockImplementation(() => {
				if (attempt < 2) {
					attempt++;
					throw lockFailure("ELOCKED");
				}
				return release;
			});

			const result = withPluginRegistryLock(agentDir, (current) => ({
				next: { ...current, revision: 3 },
				result: "recovered",
			}));

			expect(result).toBe("recovered");
			expect(lockMock.lockSync).toHaveBeenCalledTimes(3);
			expect(release).toHaveBeenCalledTimes(1);
			expectRetryWaits(clock, 25, 2);
			expect(jsonFile<{ revision: number }>(registryPath).revision).toBe(3);
		});

		it("releases exactly once and does not publish when the callback throws", () => {
			const release = vi.fn();
			lockMock.lockSync.mockReturnValue(release);
			const callbackError = new Error("callback failed");

			expect(
				captureError(() =>
					withPluginRegistryLock(agentDir, () => {
						throw callbackError;
					}),
				),
			).toBe(callbackError);
			expect(release).toHaveBeenCalledTimes(1);
			expect(jsonFile<{ revision: number }>(registryPath).revision).toBe(1);
		});

		it("gives a release failure precedence over a callback failure", () => {
			const releaseError = new Error("release failed");
			lockMock.lockSync.mockReturnValue(() => {
				throw releaseError;
			});

			expect(
				captureError(() =>
					withPluginRegistryLock(agentDir, () => {
						throw new Error("callback failed");
					}),
				),
			).toBe(releaseError);
		});
	});

	describe("ProjectTrustStore", () => {
		let agentDir: string;
		let trustPath: string;
		let cwd: string;

		beforeEach(() => {
			agentDir = join(tempRoot, "agent");
			trustPath = join(agentDir, "trust.json");
			cwd = join(tempRoot, "project");
		});

		function expectedLockOptions(): { realpath: false; lockfilePath: string } {
			return { realpath: false, lockfilePath: `${trustPath}.lock` };
		}

		it("locks the trust directory with the custom lockfilePath for reads", () => {
			const clock = installClock(20);
			const store = new ProjectTrustStore(agentDir);
			const release = vi.fn();
			lockMock.lockSync.mockImplementation((target: string, options: unknown) => {
				expect(target).toBe(agentDir);
				expect(options).toEqual(expectedLockOptions());
				expect(existsSync(agentDir)).toBe(true);
				return release;
			});

			expect(store.get(cwd)).toBeNull();

			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(release).toHaveBeenCalledTimes(1);
			expect(existsSync(trustPath)).toBe(false);
			expect(clock).toEqual([]);
		});

		it("writes the trust file before releasing the directory lock", () => {
			const store = new ProjectTrustStore(agentDir);
			const events: string[] = [];
			const release = vi.fn(() => {
				events.push("release");
				expect(jsonFile<Record<string, boolean>>(trustPath)).toEqual({ [cwd]: true });
			});
			lockMock.lockSync.mockImplementation((target: string, options: unknown) => {
				events.push("lock");
				expect(target).toBe(agentDir);
				expect(options).toEqual(expectedLockOptions());
				return release;
			});

			store.set(cwd, true);

			expect(events).toEqual(["lock", "release"]);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(release).toHaveBeenCalledTimes(1);
			expect(readFileSync(trustPath, "utf8")).toBe(`${JSON.stringify({ [cwd]: true }, null, 2)}\n`);
		});

		it("reads an existing trust file under the lock", () => {
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(trustPath, `${JSON.stringify({ [cwd]: false })}\n`);
			const store = new ProjectTrustStore(agentDir);
			const release = vi.fn();
			lockMock.lockSync.mockReturnValue(release);

			expect(store.get(cwd)).toBe(false);
			expect(release).toHaveBeenCalledTimes(1);
		});

		it("propagates a raw non-ELOCKED error without reading a malformed trust file", () => {
			const clock = installClock(20);
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(trustPath, "{ invalid json");
			const store = new ProjectTrustStore(agentDir);
			const error = lockFailure("EIO", "disk error");
			lockMock.lockSync.mockImplementation(() => {
				throw error;
			});

			expect(captureError(() => store.get(cwd))).toBe(error);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(1);
			expect(readFileSync(trustPath, "utf8")).toBe("{ invalid json");
			expect(clock).toEqual([]);
		});

		it("retries ELOCKED 10 times and throws the final raw error without writing", () => {
			const clock = installClock(20);
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(trustPath, "{}\n");
			const store = new ProjectTrustStore(agentDir);
			const errors = Array.from({ length: 10 }, (_value, index) =>
				lockFailure("ELOCKED", `locked attempt ${index + 1}`),
			);
			let attempt = 0;
			lockMock.lockSync.mockImplementation(() => {
				throw errors[attempt++];
			});

			expect(captureError(() => store.set(cwd, true))).toBe(errors[9]);
			expect(lockMock.lockSync).toHaveBeenCalledTimes(10);
			expectRetryWaits(clock, 20, 9);
			expect(readFileSync(trustPath, "utf8")).toBe("{}\n");
		});

		it("surfaces a release failure after the trust write has completed", () => {
			const store = new ProjectTrustStore(agentDir);
			const releaseError = new Error("release failed");
			lockMock.lockSync.mockReturnValue(() => {
				throw releaseError;
			});

			expect(captureError(() => store.set(cwd, true))).toBe(releaseError);
			expect(jsonFile<Record<string, boolean>>(trustPath)).toEqual({ [cwd]: true });
		});
	});

	describe("real child-process contention", () => {
		it("records a real ELOCKED and recovers after a child releases auth.json", async () => {
			const root = join(tempRoot, "child");
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			const authPath = join(agentDir, "auth.json");
			const readyPath = join(root, "ready");
			const lockedPath = join(root, "locked");
			const contendedPath = join(root, "contended");
			const releasedPath = join(root, "released");
			const resultPath = join(root, "result.json");
			const holderScript = fileURLToPath(new URL("./fixtures/lock-contention-holder.mjs", import.meta.url));
			const callerScript = fileURLToPath(new URL("./fixtures/lock-contention-caller.ts", import.meta.url));
			const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

			const holder = spawn(
				process.execPath,
				[holderScript, authPath, readyPath, lockedPath, contendedPath, releasedPath],
				{ cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
			);
			const caller = spawn(
				process.execPath,
				["--import", "tsx", callerScript, authPath, readyPath, lockedPath, contendedPath, releasedPath, resultPath],
				{ cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
			);
			const holderOutcome = trackChild(holder).outcome;
			const callerOutcome = trackChild(caller).outcome;
			try {
				const callerExit = await callerOutcome;
				const holderExit = await holderOutcome;
				expect(callerExit.code, callerExit.stderr).toBe(0);
				expect(holderExit.code, holderExit.stderr).toBe(0);
				const result = jsonFile<{
					ok: boolean;
					firstCode?: string;
					firstMessage?: string;
					firstCallbackRan?: boolean;
					result?: string;
					content?: string;
					code?: string;
					message?: string;
				}>(resultPath);
				expect(result).toMatchObject({
					ok: true,
					firstCode: "ELOCKED",
					firstCallbackRan: false,
					result: "callback:{}:{}",
					content: JSON.stringify({ pong: true }),
				});
			} finally {
				if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
				if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
				await Promise.allSettled([callerOutcome, holderOutcome]);
			}
		});
	});
});
