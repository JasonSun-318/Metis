import type { Configuration } from "webpack";
import MiniCssExtractPlugin from "mini-css-extract-plugin";

const config: Configuration = {
	devtool: false,
	module: {
		rules: [
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
		],
	},
	plugins: [new MiniCssExtractPlugin()],
	resolve: { extensions: [".ts", ".tsx", ".js"] },
	output: { publicPath: "auto" },
};

export default config;
