import { describe, expect, it, vi } from "vitest";
import { ExtensionDialogSlot } from "../src/modes/interactive/extension-dialog-slot.ts";

describe("extension dialog slot", () => {
	it("admits one dialog at a time", () => {
		const slot = new ExtensionDialogSlot();
		const first = vi.fn();
		expect(slot.busy).toBe(false);
		expect(slot.begin(first)).toBe(true);
		expect(slot.busy).toBe(true);
		expect(slot.begin(vi.fn())).toBe(false);
		expect(slot.busy).toBe(true);
	});

	it("only the owning dialog can clear the slot", () => {
		const slot = new ExtensionDialogSlot();
		const owner = vi.fn();
		const other = vi.fn();
		slot.begin(owner);
		slot.end(other);
		expect(slot.busy).toBe(true);
		slot.end(owner);
		expect(slot.busy).toBe(false);
	});

	it("settles the active dialog exactly once", () => {
		const slot = new ExtensionDialogSlot();
		const finish = vi.fn();
		slot.begin(finish);
		slot.settle();
		expect(finish).toHaveBeenCalledOnce();
		expect(slot.busy).toBe(false);
		slot.settle();
		expect(finish).toHaveBeenCalledOnce();
	});

	it("accepts a new dialog after the previous one settles", () => {
		const slot = new ExtensionDialogSlot();
		slot.begin(() => undefined);
		slot.settle();
		const next = vi.fn();
		expect(slot.begin(next)).toBe(true);
		slot.settle();
		expect(next).toHaveBeenCalledOnce();
	});
});
