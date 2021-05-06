import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import babel from "@rollup/plugin-babel";
import pkg from "./package.json";

const extensions = [".js", ".jsx", ".ts", ".tsx"];

const name = "KnockClient";

export default {
  input: "./src/index.ts",
  external: [/@babel\/runtime/, /node_modules/],
  plugins: [
    resolve({ extensions }),
    commonjs(),
    babel({ extensions, include: ["src/**/*"], babelHelpers: "runtime" }),
  ],
  output: [
    {
      file: pkg.main,
      format: "cjs",
      exports: "default",
    },
    {
      file: pkg.module,
      format: "es",
    },
    // {
    //   file: pkg.browser,
    //   format: "iife",
    //   name,
    //   globals: {},
    // },
  ],
};
