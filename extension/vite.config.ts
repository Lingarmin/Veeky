import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { resolve } from "node:path";
import manifest from "./manifest.json";
import { resolveBuildDeployment, createExtensionManifest } from "./build/deployment";

export default defineConfig(({ mode }) => {
  const deployment = resolveBuildDeployment(mode);
  const { outDir } = deployment;
  return {
  define: mode === "test" ? {} : {
    __VEEKY_DEPLOYMENT__: JSON.stringify(deployment),
  },
  plugins: [
    react(),
    {
      name: "assert-content-script-is-self-contained",
      generateBundle(_options, bundle) {
        const contentChunk = Object.values(bundle).find(
          (entry) => entry.type === "chunk" && entry.name === "content",
        );
        if (!contentChunk || contentChunk.type !== "chunk") {
          throw new Error("Content script build entry is missing");
        }
        if (contentChunk.imports.length > 0 || contentChunk.dynamicImports.length > 0) {
          throw new Error("Content script must not import external chunks");
        }
      },
    },
    {
      name: "generate-extension-manifest",
      closeBundle() {
        writeFileSync(resolve(__dirname, outDir, "manifest.json"), JSON.stringify(createExtensionManifest(manifest, deployment), null, 2) + "\n");
        const require = createRequire(import.meta.url);
        const transformersRequire = createRequire(require.resolve("@huggingface/transformers"));
        const runtimeDir = dirname(transformersRequire.resolve("onnxruntime-web"));
        const destination = resolve(__dirname, outDir, "wasm");
        mkdirSync(destination, { recursive: true });
        for (const file of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
          copyFileSync(resolve(runtimeDir, file), resolve(destination, file));
        }
      },
    },
  ],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
        offscreen: resolve(__dirname, "offscreen.html"),
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background.js";
          if (chunk.name === "content") return "content.js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
  worker: { format: "es" },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: "./tests/setup.ts",
  },
  };
});
