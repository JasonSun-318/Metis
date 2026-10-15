import { Globe } from "@phosphor-icons/react";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopHistoryEntry } from "../../shared/desktop-api.ts";

interface BrowserStartPageProps {
	readonly tools: ReactNode;
	readonly history: readonly DesktopHistoryEntry[];
	readonly onNavigate: (url: string) => void;
}

export function BrowserStartPage({ tools, history, onNavigate }: BrowserStartPageProps) {
	const { t } = useTranslation();
	const toolsTitleId = useId();
	const recent: DesktopHistoryEntry[] = [];
	const seen = new Set<string>();
	for (const entry of [...history].sort((left, right) => right.visitedAt - left.visitedAt)) {
		if (!entry.url || seen.has(entry.url)) continue;
		seen.add(entry.url);
		recent.push(entry);
		if (recent.length === 4) break;
	}
	return (
		<div className="browser-start-page">
			<section aria-labelledby={toolsTitleId} className="browser-start-section">
				<h2 id={toolsTitleId}>{t("Tools")}</h2>
				{tools}
			</section>
			<section aria-label={t("Recent pages")} className="browser-start-section">
				<h2>{t("Recent pages")}</h2>
				{recent.length > 0 ? (
					<div className="browser-start-recent">
						{recent.map((entry) => (
							<button className="browser-start-recent-page" key={entry.url} onClick={() => onNavigate(entry.url)} title={entry.url} type="button">
								<span className="browser-start-favicon">
									{entry.faviconUrl?.startsWith("data:image/") ? <img alt="" src={entry.faviconUrl} /> : <Globe aria-hidden="true" size={26} weight="light" />}
								</span>
								<span className="browser-start-page-title">{entry.title || entry.url}</span>
							</button>
						))}
					</div>
				) : <p className="browser-start-empty">{t("Pages you visit will appear here")}</p>}
			</section>
		</div>
	);
}
