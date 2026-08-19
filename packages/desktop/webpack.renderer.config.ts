import CopyWebpackPlugin from "copy-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import { createRequire } from "node:module";
import path from "node:path";
import type { Configuration } from "webpack";

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));

const config: Configuration = {
	devtool: false,
	module: {
		rules: [
			// The package omits its worker entry from sideEffects, so production tree shaking would emit an empty worker.
			{ test: /@pierre\/diffs\/dist\/worker\/worker\.js$/u, sideEffects: true },
			{
				test: /\.tsx?$/u,
				exclude: /node_modules/u,
				use: {
					loader: "ts-loader",
					options: {
						configFile: "tsconfig.renderer.json",
						transpileOnly: true,
						compilerOptions: { rewriteRelativeImportExtensions: false },
					},
				},
			},
			{ test: /\.css$/u, use: [MiniCssExtractPlugin.loader, "css-loader"] },
			{ test: /\.(?:png|svg)$/u, type: "asset/resource" },
			{ test: /pdf\.worker\.min\.mjs$/u, type: "asset/resource" },
		],
	},
	plugins: [
		new MiniCssExtractPlugin(),
		new CopyWebpackPlugin({
			patterns: [
				{ from: path.join(pdfjsRoot, "build/pdf.worker.min.mjs"), to: "pdf.worker.min.mjs" },
				{ from: path.join(pdfjsRoot, "cmaps"), to: "pdfjs/cmaps" }, // pdfjs-dist/cmaps
				{ from: path.join(pdfjsRoot, "standard_fonts"), to: "pdfjs/standard_fonts" }, // pdfjs-dist/standard_fonts
			],
		}),
	],
	resolve: { extensions: [".ts", ".tsx", ".js"] },
	output: { publicPath: "auto" },
};

export default config;
