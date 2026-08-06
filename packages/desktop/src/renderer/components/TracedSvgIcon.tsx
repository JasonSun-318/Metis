import type { CSSProperties } from "react";

export function TracedSvgIcon({ className = "", src }: { readonly className?: string; readonly src: string }) {
	return (
		<span
			aria-hidden="true"
			className={`traced-svg-icon ${className}`.trim()}
			style={{ "--traced-svg": `url("${src}")` } as CSSProperties}
		/>
	);
}
