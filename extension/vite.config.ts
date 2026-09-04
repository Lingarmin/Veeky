import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
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
      name: "copy-extension-manifest",
      closeBundle() {
        copyFileSync(resolve(__dirname, "manifest.json"), resolve(__dirname, "dist/manifest.json"));
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
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
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: "./tests/setup.ts",
  },
});
