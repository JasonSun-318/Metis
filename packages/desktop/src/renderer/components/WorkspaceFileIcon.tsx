import type { DesktopWorkspaceEntry } from "../../shared/desktop-api.ts";
import {
	File,
	FileArchive,
	FileC,
	FileCode,
	FileCpp,
	FileCSharp,
	FileCss,
	FileCsv,
	FileDoc,
	FileHtml,
	FileImage,
	FileIni,
	FileJs,
	FileJsx,
	FileMd,
	FilePdf,
	FilePpt,
	FilePy,
	FileRs,
	FileSql,
	FileText,
	FileTs,
	FileTsx,
	FileVideo,
	FileXls,
	FileZip,
	Folder,
	FolderOpen,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";

interface WorkspaceFileIconProps {
	readonly expanded?: boolean;
	readonly kind?: DesktopWorkspaceEntry["kind"];
	readonly path: string;
	readonly size?: number;
}

interface IconDefinition {
	readonly Component: ComponentType<{ ariaHidden?: boolean; className?: string; size?: number }>;
	readonly type: string;
}

function iconForFile(path: string): IconDefinition {
	const name = path.split("/").at(-1)?.toLocaleLowerCase() ?? path.toLocaleLowerCase();
	if (name === "package.json" || name === "package-lock.json" || name === "npm-shrinkwrap.json") {
		return { Component: FileCode, type: "npm" };
	}
	if (name.startsWith("tsconfig") && name.endsWith(".json")) {
		return { Component: FileTs, type: "typescript" };
	}
	if (name.startsWith("biome.json") || name.startsWith("eslint.") || name.startsWith("prettier.")) {
		return { Component: FileCode, type: "config" };
	}
	if ([".gitattributes", ".gitignore", ".gitmodules"].includes(name)) {
		return { Component: FileCode, type: "git" };
	}
	if (name.startsWith("readme") || name.startsWith("license")) {
		return { Component: FileMd, type: "markdown" };
	}
	if (name === "dockerfile" || name.startsWith("docker-compose.")) {
		return { Component: FileCode, type: "docker" };
	}

	const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
	switch (extension) {
		case "ts":
		case "cts":
		case "mts":
			return { Component: FileTs, type: "typescript" };
		case "tsx":
			return { Component: FileTsx, type: "typescript" };
		case "js":
		case "cjs":
		case "mjs":
			return { Component: FileJs, type: "javascript" };
		case "jsx":
			return { Component: FileJsx, type: "javascript" };
		case "json":
		case "jsonc":
		case "yaml":
		case "yml":
		case "toml":
			return { Component: FileCode, type: "json" };
		case "ini":
			return { Component: FileIni, type: "config" };
		case "md":
		case "markdown":
		case "mdx":
			return { Component: FileMd, type: "markdown" };
		case "html":
		case "htm":
		case "xhtml":
			return { Component: FileHtml, type: "html" };
		case "css":
		case "scss":
		case "sass":
		case "less":
			return { Component: FileCss, type: "css" };
		case "py":
		case "pyw":
			return { Component: FilePy, type: "python" };
		case "rs":
			return { Component: FileRs, type: "rust" };
		case "c":
		case "h":
			return { Component: FileC, type: "c" };
		case "cpp":
		case "cc":
		case "cxx":
		case "hpp":
			return { Component: FileCpp, type: "cpp" };
		case "cs":
			return { Component: FileCSharp, type: "csharp" };
		case "sql":
		case "db":
		case "sqlite":
			return { Component: FileSql, type: "database" };
		case "csv":
		case "tsv":
			return { Component: FileCsv, type: "spreadsheet" };
		case "xls":
		case "xlsx":
			return { Component: FileXls, type: "spreadsheet" };
		case "doc":
		case "docx":
			return { Component: FileDoc, type: "document" };
		case "ppt":
		case "pptx":
			return { Component: FilePpt, type: "presentation" };
		case "pdf":
			return { Component: FilePdf, type: "pdf" };
		case "png":
		case "jpg":
		case "jpeg":
		case "gif":
		case "webp":
		case "svg":
		case "ico":
			return { Component: FileImage, type: "image" };
		case "mp4":
		case "mov":
		case "webm":
		case "mkv":
			return { Component: FileVideo, type: "video" };
		case "zip":
		case "tar":
		case "gz":
		case "tgz":
		case "bz2":
		case "xz":
		case "7z":
		case "rar":
			return { Component: FileZip, type: "archive" };
		case "sh":
		case "bash":
		case "zsh":
		case "fish":
		case "ps1":
			return { Component: FileCode, type: "shell" };
		case "txt":
		case "log":
			return { Component: FileText, type: "text" };
		default:
			return { Component: File, type: "file" };
	}
}

export function WorkspaceFileIcon({ expanded = false, kind = "file", path, size = 14 }: WorkspaceFileIconProps) {
	if (kind === "directory") {
		const FolderComponent = expanded ? FolderOpen : Folder;
		return <FolderComponent aria-hidden="true" className="file-kind-icon workspace-file-icon is-folder file-kind-folder" size={size} />;
	}
	const { Component, type } = iconForFile(path);
	return <Component aria-hidden="true" className={`file-kind-icon workspace-file-icon is-${type} file-kind-${type}`} size={size} />;
}
