import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

// Stamp src/version.ts with a fresh timestamp on every compilation
class StampPlugin {
  apply(compiler) {
    compiler.hooks.beforeCompile.tap('StampPlugin', () => {
      const ts = Date.now();
      const out = `// Auto-generated — do not edit.\nexport const BUILD_TIME = ${ts};\n`;
      fs.writeFileSync(path.join(dirname, 'src/version.ts'), out);
    });
  }
}

export default {
  entry: "./src/index.tsx",
  output: {
    filename: "bundle.js",
    path: path.resolve(dirname, "public"),
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".json"],
  },
  module: {
    rules: [
      {
        test: /\.(ts|tsx)$/,
        exclude: /node_modules/,
        use: "ts-loader",
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [new StampPlugin()],
  watchOptions: {
    ignored: /src\/version\.ts$/,
  },
  devServer: {
    static: [{ directory: path.join(dirname, "public") }],
    compress: true,
    port: 3000,
  },
};
