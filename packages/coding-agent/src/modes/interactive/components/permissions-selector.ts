import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@metis/tui";
import type { PermissionPreset } from "../../../core/permissions/settings.ts";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const PERMISSIONS_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 20,
	maxPrimaryColumnWidth: 32,
};

const PRESET_ITEMS: SelectItem[] = [
	{
		value: "ask",
		label: "Ask",
		description: "Runs in the workspace sandbox and asks you when approval is needed.",
	},
	{
		value: "auto",
		label: "Auto",
		description: "Runs in the workspace sandbox. The current model reviews risky actions when needed.",
	},
	{
		value: "full",
		label: "Full",
		description: "May run on the host. Critical actions still ask you.",
	},
];

export class PermissionsSelectorComponent extends Container {
	private selectList!: SelectList;
	private readonly current: PermissionPreset;
	private readonly onSave: (preset: PermissionPreset) => void;
	private readonly onCancel: () => void;

	constructor(current: PermissionPreset, onSave: (preset: PermissionPreset) => void, onCancel: () => void) {
		super();
		this.current = current;
		this.onSave = onSave;
		this.onCancel = onCancel;
		this.showPresets();
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

	private showPresets(): void {
		this.setItems(PRESET_ITEMS, this.current, (value) => this.onSave(value as PermissionPreset), this.onCancel);
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
