/**
 * Single-slot arbitration for extension dialogs.
 *
 * Extension UI can request select/confirm/input/editor dialogs from any tool or
 * hook while another dialog is open. The slot records the one active dialog
 * settlement callback so every dialog follows the same rule: a competing dialog
 * resolves immediately with `undefined`, and only the current dialog can clear
 * the slot.
 */
export type ExtensionDialogFinish = (value?: string) => void;

export class ExtensionDialogSlot {
	private finish: ExtensionDialogFinish | undefined;

	get busy(): boolean {
		return this.finish !== undefined;
	}

	/** Registers the active dialog. Returns false when another dialog already owns the slot. */
	begin(finish: ExtensionDialogFinish): boolean {
		if (this.finish !== undefined) return false;
		this.finish = finish;
		return true;
	}

	/** Clears the slot only when the finishing dialog is the current owner. */
	end(finish: ExtensionDialogFinish): void {
		if (this.finish === finish) this.finish = undefined;
	}

	/** Settles the active dialog, if any, without touching a different dialog's callback. */
	settle(): void {
		const finish = this.finish;
		this.finish = undefined;
		finish?.();
	}
}
