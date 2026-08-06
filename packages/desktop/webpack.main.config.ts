import webpack, { type Configuration } from "webpack";

const config: Configuration = {
	entry: "./src/main/main.ts",
	devtool: false,
	externals: { "node-pty": "commonjs node-pty" },
	module: {
		rules: [
			{
				test: /\.tsx?$/u,
				exclude: /node_modules/u,
				use: {
					loader: "ts-loader",
					options: {
						configFile: "tsconfig.main.json",
						transpileOnly: true,
						compilerOptions: { rewriteRelativeImportExtensions: false },
					},
				},
			},
		],
	},
	resolve: { extensions: [".ts", ".tsx", ".js"] },
	plugins: [
		new webpack.DefinePlugin({
			ARCMIND_UPDATE_FEED_URL: JSON.stringify(process.env.ARCMIND_UPDATE_FEED_URL || null),
		}),
	],
};

export default config;
