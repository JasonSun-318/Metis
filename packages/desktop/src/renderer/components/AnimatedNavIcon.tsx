/*
SVGs adapted from lucide-animated (https://github.com/pqoqubbw/icons).
Motion is implemented with CSS for Metis; no Motion runtime is required.
MIT License

Copyright (c) 2024-2026 pqoqubbw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

interface AnimatedNavIconProps {
	readonly kind: "task" | "customize" | "folder" | "schedule";
	readonly size?: number;
	readonly className?: string;
	readonly expanded?: boolean;
}

export function AnimatedNavIcon({ kind, size = 15, className = "", expanded = false }: AnimatedNavIconProps) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={`animated-nav-icon animated-nav-icon-${kind} ${className}`}
			data-expanded={expanded || undefined}
			fill="none"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{kind === "task" && (
				<>
					<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
					<path
						className="nav-icon-motion"
						d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"
					/>
				</>
			)}
			{kind === "customize" && (
				<>
					<path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3" />
					<path className="nav-icon-motion" d="M14 3h7v7h-7z" />
				</>
			)}
			{kind === "folder" && (
				<path
					className="nav-icon-motion"
					d={
						expanded
							? "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
							: "M20 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z"
					}
				/>
			)}
			{kind === "schedule" && (
				<>
					<path d="M18 20.5 19.5 22M6 20.5 4.5 22M18 2l3.747 3.311M6 2 2.253 5.311" />
					<circle cx="12" cy="13" r="9" />
					<path className="nav-icon-motion" d="M12 8v5l3 2" />
				</>
			)}
		</svg>
	);
}
