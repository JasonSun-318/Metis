import type { DesktopWorkspaceEntry } from "../../shared/desktop-api.ts";

declare const require: (path: string) => string;

const biomeIcon = require("material-icon-theme/icons/biome.svg");
const cIcon = require("material-icon-theme/icons/c.svg");
const cppIcon = require("material-icon-theme/icons/cpp.svg");
const csharpIcon = require("material-icon-theme/icons/csharp.svg");
const cssIcon = require("material-icon-theme/icons/css.svg");
const databaseIcon = require("material-icon-theme/icons/database.svg");
const dockerIcon = require("material-icon-theme/icons/docker.svg");
const eslintIcon = require("material-icon-theme/icons/eslint.svg");
const fileIcon = require("material-icon-theme/icons/file.svg");
const folderIcon = require("material-icon-theme/icons/folder.svg");
const folderOpenIcon = require("material-icon-theme/icons/folder-open.svg");
const gitIcon = require("material-icon-theme/icons/git.svg");
const htmlIcon = require("material-icon-theme/icons/html.svg");
const imageIcon = require("material-icon-theme/icons/image.svg");
const javascriptIcon = require("material-icon-theme/icons/javascript.svg");
const jsonIcon = require("material-icon-theme/icons/json.svg");
const lessIcon = require("material-icon-theme/icons/less.svg");
const licenseIcon = require("material-icon-theme/icons/license.svg");
const markdownIcon = require("material-icon-theme/icons/markdown.svg");
const npmIcon = require("material-icon-theme/icons/npm.svg");
const pdfIcon = require("material-icon-theme/icons/pdf.svg");
const playwrightIcon = require("material-icon-theme/icons/playwright.svg");
const powershellIcon = require("material-icon-theme/icons/powershell.svg");
const prettierIcon = require("material-icon-theme/icons/prettier.svg");
const pythonIcon = require("material-icon-theme/icons/python.svg");
const reactIcon = require("material-icon-theme/icons/react.svg");
const reactTsIcon = require("material-icon-theme/icons/react_ts.svg");
const readmeIcon = require("material-icon-theme/icons/readme.svg");
const rustIcon = require("material-icon-theme/icons/rust.svg");
const sassIcon = require("material-icon-theme/icons/sass.svg");
const consoleIcon = require("material-icon-theme/icons/console.svg");
const tomlIcon = require("material-icon-theme/icons/toml.svg");
const tsconfigIcon = require("material-icon-theme/icons/tsconfig.svg");
const typescriptIcon = require("material-icon-theme/icons/typescript.svg");
const vitestIcon = require("material-icon-theme/icons/vitest.svg");
const vueIcon = require("material-icon-theme/icons/vue.svg");
const webpackIcon = require("material-icon-theme/icons/webpack.svg");
const yamlIcon = require("material-icon-theme/icons/yaml.svg");
const zipIcon = require("material-icon-theme/icons/zip.svg");

interface WorkspaceFileIconProps {
	readonly expanded?: boolean;
	readonly kind?: DesktopWorkspaceEntry["kind"];
	readonly path: string;
	readonly size?: number;
}

function iconForFile(path: string): { readonly source: string; readonly type: string } {
	const name = path.split("/").at(-1)?.toLocaleLowerCase() ?? path.toLocaleLowerCase();
	if (name === "package.json" || name === "package-lock.json" || name === "npm-shrinkwrap.json") return { source: npmIcon, type: "npm" };
	if (name.startsWith("tsconfig") && name.endsWith(".json")) return { source: tsconfigIcon, type: "typescript" };
	if (name.startsWith("webpack.")) return { source: webpackIcon, type: "webpack" };
	if (name === "biome.json" || name === "biome.jsonc") return { source: biomeIcon, type: "biome" };
	if ([".gitattributes", ".gitignore", ".gitmodules"].includes(name)) return { source: gitIcon, type: "git" };
	if (name.startsWith("readme")) return { source: readmeIcon, type: "markdown" };
	if (name.startsWith("license")) return { source: licenseIcon, type: "license" };
	if (name === "dockerfile" || name.startsWith("docker-compose.")) return { source: dockerIcon, type: "docker" };
	if (name.startsWith("vitest.")) return { source: vitestIcon, type: "vitest" };
	if (name.startsWith("playwright.")) return { source: playwrightIcon, type: "playwright" };
	if (name.startsWith("eslint.")) return { source: eslintIcon, type: "eslint" };
	if (name.startsWith("prettier.")) return { source: prettierIcon, type: "prettier" };

	const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
	if (["ts", "cts", "mts"].includes(extension)) return { source: typescriptIcon, type: "typescript" };
	if (extension === "tsx") return { source: reactTsIcon, type: "typescript" };
	if (["js", "cjs", "mjs"].includes(extension)) return { source: javascriptIcon, type: "javascript" };
	if (extension === "jsx") return { source: reactIcon, type: "javascript" };
	if (["json", "jsonc"].includes(extension)) return { source: jsonIcon, type: "json" };
	if (["md", "markdown", "mdx"].includes(extension)) return { source: markdownIcon, type: "markdown" };
	if (extension === "css") return { source: cssIcon, type: "css" };
	if (["scss", "sass"].includes(extension)) return { source: sassIcon, type: "css" };
	if (extension === "less") return { source: lessIcon, type: "css" };
	if (["html", "htm", "xhtml"].includes(extension)) return { source: htmlIcon, type: "html" };
	if (["py", "pyw"].includes(extension)) return { source: pythonIcon, type: "python" };
	if (["yaml", "yml"].includes(extension)) return { source: yamlIcon, type: "yaml" };
	if (extension === "toml") return { source: tomlIcon, type: "toml" };
	if (["sh", "bash", "zsh", "fish"].includes(extension)) return { source: consoleIcon, type: "shell" };
	if (["ps1", "psm1", "psd1"].includes(extension)) return { source: powershellIcon, type: "powershell" };
	if (extension === "rs") return { source: rustIcon, type: "rust" };
	if (["c", "h"].includes(extension)) return { source: cIcon, type: "c" };
	if (["cc", "cpp", "cxx", "hh", "hpp", "hxx"].includes(extension)) return { source: cppIcon, type: "cpp" };
	if (extension === "cs") return { source: csharpIcon, type: "csharp" };
	if (["sql", "csv", "db", "sqlite"].includes(extension)) return { source: databaseIcon, type: "database" };
	if (extension === "vue") return { source: vueIcon, type: "vue" };
	if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(extension)) return { source: imageIcon, type: "image" };
	if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(extension)) return { source: zipIcon, type: "archive" };
	if (extension === "pdf") return { source: pdfIcon, type: "pdf" };
	return { source: fileIcon, type: "file" };
}

export function WorkspaceFileIcon({ expanded = false, kind = "file", path, size = 14 }: WorkspaceFileIconProps) {
	const icon = kind === "directory"
		? { source: expanded ? folderOpenIcon : folderIcon, type: "folder" }
		: iconForFile(path);
	return <img alt="" aria-hidden="true" className={`file-kind-icon is-${icon.type}`} draggable={false} height={size} src={icon.source} width={size} />;
}
