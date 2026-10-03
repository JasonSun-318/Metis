import type { ItemView } from "@metis/app-protocol";
import { useTranslation } from "react-i18next";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
	return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function MessageAttachments({ attachments }: { readonly attachments: ItemView["attachments"] }) {
	const { t } = useTranslation();
	if (!attachments?.length) return null;
	return (
		<ul className="message-attachments" aria-label={t("Attached files")}>
			{attachments.map((file, index) => (
				<li className="message-file-card" key={`${index}-${file.name}`}>
					<span className="message-file-icon" aria-hidden="true">
						<WorkspaceFileIcon path={file.name} size={25} />
					</span>
					<span className="message-file-info">
						<strong title={file.name}>{file.name}</strong>
						<small>
							{file.name
								.match(/\.([^.]+)$/u)?.[1]
								?.slice(0, 10)
								.toUpperCase() ?? t("File")}{" "}
							· {fileSize(file.byteLength)}
						</small>
					</span>
				</li>
			))}
		</ul>
	);
}
