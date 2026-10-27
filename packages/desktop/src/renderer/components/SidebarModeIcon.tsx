import { ChatDots, Programming } from "../icons.tsx";
import { useSidebarIconMotion } from "./AnimatedNavIcon.tsx";

interface SidebarModeIconProps {
	readonly kind: "chat" | "code";
	readonly size?: number;
	readonly className?: string;
}

export function SidebarModeIcon({ kind, size = 15, className = "" }: SidebarModeIconProps) {
	const ref = useSidebarIconMotion(kind);
	const Icon = kind === "chat" ? ChatDots : Programming;
	return (
		<Icon
			aria-hidden="true"
			className={`sidebar-semantic-icon sidebar-mode-icon sidebar-mode-icon-${kind} ${className}`}
			ref={ref}
			size={size}
		/>
	);
}
