import type { PowerSaveBlocker } from "electron";

export function createScheduleKeepAwake(blocker: Pick<PowerSaveBlocker, "isStarted" | "start" | "stop">) {
	let id: number | undefined;
	return {
		set(enabled: boolean): void {
			if (enabled) {
				if (id === undefined || !blocker.isStarted(id)) id = blocker.start("prevent-app-suspension");
				return;
			}
			if (id !== undefined && blocker.isStarted(id)) blocker.stop(id);
			id = undefined;
		},
	};
}
