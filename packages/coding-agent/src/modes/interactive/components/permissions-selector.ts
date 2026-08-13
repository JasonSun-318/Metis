import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@metis/tui";
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
		label: "Ask",
		description: "Read ordinary workspace files; ask before Bash, writes, web, and integrations",
	},
	{
		value: "auto",
		label: "Auto",
		description: "Work in the project sandbox; ask for dangerous or boundary-crossing actions",
	},
	{
		value: "full",
		label: "Full access",
		description: "Run model tool actions directly on the host with no Metis approval",
	},
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
			(value) => this.onSave({ mode: value as PermissionMode }),
			this.onCancel,
		);
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
