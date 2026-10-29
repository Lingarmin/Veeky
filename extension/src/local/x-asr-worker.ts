import type { ModelManifest } from "./x-model";
import { MODEL_CACHE, modelAssetUrl, WHISPER_MODEL_ID } from "./x-model";

const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown): void };
type Recognizer = (samples: Float32Array, options: Record<string, unknown>) => Promise<unknown>;
let recognizer: Recognizer | null = null;

scope.onmessage = (event: MessageEvent) => {
  void (async () => {
    const message = event.data;
    if (message.type === "initialize") {
      const manifest = message.manifest as ModelManifest;
      if (manifest.model !== WHISPER_MODEL_ID) throw new Error("model_manifest_invalid");
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = "/verified-model-cache/";
      env.useBrowserCache = false;
      env.useFSCache = false;
      env.useCustomCache = true;
      const cache = await caches.open(MODEL_CACHE);
      env.customCache = {
        async match(request: string) {
          const asset = manifest.files.find((file) => request === modelAssetUrl(manifest, file.name));
          return asset ? cache.match(modelAssetUrl(manifest, asset.name)) : undefined;
        },
        async put() { /* Only the verified downloader can populate model data. */ },
      };
      const wasm = env.backends.onnx.wasm!;
      wasm.wasmPaths = message.runtimeUrl;
      wasm.numThreads = 1;
      wasm.proxy = false;
      recognizer = await pipeline("automatic-speech-recognition", WHISPER_MODEL_ID, {
        device: "wasm", dtype: "q8", revision: manifest.revision, local_files_only: true,
      }) as unknown as Recognizer;
      scope.postMessage({ type: "ready" });
    } else if (message.type === "recognize" && recognizer) {
      const result = await recognizer(message.samples, {
        return_timestamps: true, task: "transcribe",
        ...(message.language && message.language !== "auto" ? { language: message.language } : {}),
        chunk_length_s: 30, stride_length_s: 0,
      });
      scope.postMessage({ type: "result", result });
    }
  })().catch(() => scope.postMessage({ type: "error", code: "local_asr_failed" }));
};
