import type { Configuration } from "webpack";
import MiniCssExtractPlugin from "mini-css-extract-plugin";

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
		],
	},
	plugins: [new MiniCssExtractPlugin()],
	resolve: { extensions: [".ts", ".tsx", ".js"] },
	output: { publicPath: "auto" },
};

export default config;
