import type { ItemView } from "@metis/app-protocol";
import { useTranslation } from "react-i18next";
import { DrawerDetails } from "./DrawerDetails.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

export function MessageFileSelections({ selections }: { readonly selections: ItemView["fileSelections"] }) {
	const { t } = useTranslation();
	if (!selections?.length) return null;
	return (
		<ul className="message-attachments message-file-selections" aria-label={t("Referenced text fragments")}>
			{selections.map((file, index) => {
				const target = file.target;
				const location =
					target?.kind === "pdf"
						? t("Pages {{range}}", {
								range:
									target.endPage && target.endPage !== target.page
										? `${target.page}–${target.endPage}`
										: target.page,
							})
						: target?.kind === "pptx"
							? `${t("Slide {{page}}", { page: target.page })}${target.objectName ? ` · ${target.objectName}` : ""}`
							: target?.kind === "spreadsheet"
								? `${target.sheet}!${target.range}`
								: file.startLine === undefined
									? t("Selected text")
									: t("Lines {{start}}–{{end}}", { start: file.startLine, end: file.endLine });
				return (
					<li className="message-file-selection" key={`${index}-${file.name}`}>
						<DrawerDetails
							className="message-file-selection-details"
							summary={
								<>
									<WorkspaceFileIcon path={file.name} size={22} />
									<span className="message-file-info">
										<strong title={file.name}>{file.name}</strong>
										<small>
											{file.source === "delivered" ? `${t("Delivered version")} · ` : ""}
											{location}
										</small>
									</span>
								</>
							}
						>
							<blockquote>{file.selectedText}</blockquote>
							{file.selectedTextTruncated && (
								<small className="message-file-selection-truncated">{t("Reference preview shortened")}</small>
							)}
						</DrawerDetails>
					</li>
				);
			})}
		</ul>
	);
}
