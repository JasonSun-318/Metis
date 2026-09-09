import webpack, { type Configuration } from "webpack";

const updateBaseUrl =
	process.env.METIS_UPDATE_BASE_URL ||
	process.env.METIS_DOWNLOAD_BASE_URL ||
	"https://metis-release.oss-cn-shenzhen.aliyuncs.com/metis";

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
			METIS_UPDATE_BASE_URL: JSON.stringify(updateBaseUrl),
		}),
	],
};

export default config;
