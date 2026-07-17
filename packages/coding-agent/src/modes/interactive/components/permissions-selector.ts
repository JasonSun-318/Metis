import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@arcmind/tui";
import type { PermissionMode, PermissionSettings } from "../../../core/permission-mode.ts";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const PERMISSIONS_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 20,
	maxPrimaryColumnWidth: 32,
};

const MODE_ITEMS: SelectItem[] = [
	{
		value: "ask",
		label: "Ask before changes",
		description: "Read in a sandbox; ask before writes, network, or risky actions",
	},
	{
		value: "auto",
		label: "Auto with review",
		description: "Read/write the workspace; review risky or external actions",
	},
	{
		value: "full",
		label: "Full access",
		description: "Run without ArcMind approvals or sandboxing",
	},
];

const REVIEWER_ITEMS: SelectItem[] = [
	{ value: "enabled", label: "Reviewer enabled", description: "Use the current session model for risky actions" },
	{ value: "disabled", label: "Reviewer disabled", description: "Ask the user instead of automatic review" },
];

export class PermissionsSelectorComponent extends Container {
	private selectList!: SelectList;
	private readonly current: PermissionSettings;
	private readonly onSave: (settings: PermissionSettings) => void;
	private readonly onCancel: () => void;

	constructor(current: PermissionSettings, onSave: (settings: PermissionSettings) => void, onCancel: () => void) {
		super();
		this.current = current;
		this.onSave = onSave;
		this.onCancel = onCancel;
		this.showModes();
	}

	private setItems(
		items: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		this.clear();
		this.addChild(new DynamicBorder());
		this.selectList = new SelectList(items, items.length, getSelectListTheme(), PERMISSIONS_SELECT_LIST_LAYOUT);
		const index = items.findIndex((item) => item.value === currentValue);
		if (index !== -1) this.selectList.setSelectedIndex(index);
		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	private showModes(): void {
		this.setItems(
			MODE_ITEMS,
			this.current.mode,
			(value) => {
				const mode = value as PermissionMode;
				if (mode === "auto") {
					this.showReviewer();
					return;
				}
				this.onSave({ mode, reviewerEnabled: this.current.reviewerEnabled });
			},
			this.onCancel,
		);
	}

	private showReviewer(): void {
		this.setItems(
			REVIEWER_ITEMS,
			this.current.reviewerEnabled ? "enabled" : "disabled",
			(value) => this.onSave({ mode: "auto", reviewerEnabled: value === "enabled" }),
			() => this.showModes(),
		);
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
