export interface RecoveryFixture {
	readonly calls: {
		readonly catalog: number;
		readonly history: number;
		readonly sent: number;
	};
	disconnect(): void;
	completeWithoutEvents(): void;
	ready(changedEpoch?: boolean): void;
	setVisible(visible: boolean): void;
	rememberNodes(): void;
	nodesPreserved(): boolean;
}
