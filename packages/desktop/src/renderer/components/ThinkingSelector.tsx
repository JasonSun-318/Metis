import type { SessionSnapshot } from "@arcmind/app-protocol";

interface ThinkingSelectorProps {
	readonly actualThinkingLevel: SessionSnapshot["actualThinkingLevel"];
	readonly available: SessionSnapshot["availableThinkingSelections"];
	readonly disabled: boolean;
	readonly model?: SessionSnapshot["model"];
	readonly onChange: (selection: SessionSnapshot["thinkingSelection"]) => void;
	readonly value: SessionSnapshot["thinkingSelection"];
}

export function ThinkingSelector({ actualThinkingLevel, available, disabled, model, onChange, value }: ThinkingSelectorProps) {
	return (
		<label className={`thinking-control${value === "ultra" ? " thinking-ultra" : ""}`}>
			<span>Thinking</span>
			<select
				aria-describedby="thinking-selection-detail"
				disabled={disabled}
				onChange={(event) => onChange(event.target.value as SessionSnapshot["thinkingSelection"])}
				value={value}
			>
				{available.map((selection) => (
					<option key={selection} value={selection}>
						{model
							? `${model.modelId}${selection === "off" ? "" : ` · ${selection}`}`
							: selection === "ultra" ? "Ultra · Multi-agent" : selection}
					</option>
				))}
			</select>
			<span className="sr-only" id="thinking-selection-detail">
				{value === "ultra"
					? `Uses ${actualThinkingLevel}, multiple model calls, and subagent orchestration.`
					: `Provider thinking level ${actualThinkingLevel}.`}
			</span>
		</label>
	);
}
