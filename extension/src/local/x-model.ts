import { localError } from "./youtube-browser";
import { assertStorageCapacity } from "./storage";

export const WHISPER_MODEL_ID = "Xenova/whisper-small";
export const MODEL_CACHE = "veeky-whisper-small-q8-v1";
const MANIFEST_KEY = "https://huggingface.co/veeky-local/whisper-small-manifest-v1";
const FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "generation_config.json",
  "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"] as const;
const MAX_FILE_BYTES = 512 * 1024 ** 2;
const MODEL_DATA_HOSTS = new Set(["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co",
  "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "cas-bridge.xethub.hf.co"]);
export interface ModelAsset { name: string; size: number; digest: string; algorithm: "SHA-256" | "SHA-1" }
export interface ModelManifest { model: typeof WHISPER_MODEL_ID; revision: string; files: ModelAsset[] }
export interface ModelProgress { completed: number; total: number; file: string }

/** Resolve once on explicit installation; later runs reuse this exact commit, never a floating branch. */
export function parseModelManifest(value: unknown): ModelManifest {
  const data = value as { sha?: unknown; siblings?: unknown } | null;
  if (!data || typeof data.sha !== "string" || !/^[a-f0-9]{40}$/u.test(data.sha) || !Array.isArray(data.siblings)) throw localError("model_manifest_invalid");
  const siblings = data.siblings;
  const files = FILES.map((name): ModelAsset => {
    const item = siblings.find((row: { rfilename?: unknown }) => row?.rfilename === name) as { size?: number; blobId?: string; lfs?: { sha256?: string; size?: number } } | undefined;
    const size = item?.lfs?.size ?? item?.size;
    const digest = item?.lfs?.sha256 ?? item?.blobId;
    const algorithm = item?.lfs ? "SHA-256" : "SHA-1";
    if (!Number.isSafeInteger(size) || size! <= 0 || size! > MAX_FILE_BYTES || typeof digest !== "string"
      || !(algorithm === "SHA-256" ? /^[a-f0-9]{64}$/u : /^[a-f0-9]{40}$/u).test(digest)) throw localError("model_manifest_invalid");
    return { name, size: size!, digest, algorithm };
  });
  if (files.reduce((sum, file) => sum + file.size, 0) > 1024 ** 3) throw localError("model_manifest_invalid");
  return { model: WHISPER_MODEL_ID, revision: data.sha, files };
}

export function modelAssetUrl(manifest: ModelManifest, name: string): string {
  if (manifest.model !== WHISPER_MODEL_ID || !/^[a-f0-9]{40}$/u.test(manifest.revision)
    || !FILES.includes(name as typeof FILES[number])) throw localError("model_manifest_invalid");
  return `https://huggingface.co/${WHISPER_MODEL_ID}/resolve/${manifest.revision}/${name}`;
}

async function matchesDigest(bytes: Uint8Array, asset: ModelAsset): Promise<boolean> {
  if (bytes.length !== asset.size) return false;
  let input = bytes;
  if (asset.algorithm === "SHA-1") {
    const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
    input = new Uint8Array(prefix.length + bytes.length); input.set(prefix); input.set(bytes, prefix.length);
  }
  const hash = await crypto.subtle.digest(asset.algorithm, input as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") === asset.digest;
}

function restoreManifest(value: unknown): ModelManifest {
  const saved = value as Partial<ModelManifest>;
  if (saved?.model !== WHISPER_MODEL_ID || !Array.isArray(saved.files)) throw localError("model_manifest_invalid");
  return parseModelManifest({ sha: saved.revision, siblings: saved.files.map((file) => ({
    rfilename: file.name, size: file.size, blobId: file.algorithm === "SHA-1" ? file.digest : undefined,
    lfs: file.algorithm === "SHA-256" ? { size: file.size, sha256: file.digest } : undefined,
  })) });
}

async function boundedResponse(response: Response, limit: number, signal: AbortSignal, progress: (bytes: number) => void): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw localError("model_download_failed");
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let total = 0;
  const abort = () => { void reader.cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) throw localError("model_manifest_invalid");
      parts.push(part.value); progress(total);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(total); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); }
}

async function downloadModelData(url: string, limit: number, signal: AbortSignal, progress: (bytes: number) => void, allowCdn = false): Promise<Uint8Array> {
  try {
    signal.throwIfAborted();
    const response = await fetch(url, { credentials: "omit", redirect: allowCdn ? "follow" : "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(allowCdn ? 10 * 60_000 : 30_000)]) });
    // Browser fetch hides intermediate redirects. Validate the final response before consuming any data.
    const destination = new URL(response.url);
    if (destination.protocol !== "https:" || destination.username || destination.password || destination.port
      || !MODEL_DATA_HOSTS.has(destination.hostname) || !allowCdn && destination.href !== url) {
      await response.body?.cancel().catch(() => undefined);
      throw localError("model_download_failed");
    }
    return await boundedResponse(response, limit, signal, progress);
  } catch (error) {
    if (signal.aborted) throw localError("analysis_cancelled");
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string"
      && error.code.startsWith("model_")) throw error;
    throw localError("model_download_failed");
  }
}

/** No audio/keys are sent. Downloads consist exclusively of allowlisted JSON and ONNX data. */
export async function ensureWhisperModel(signal: AbortSignal, onProgress: (progress: ModelProgress) => void): Promise<ModelManifest> {
  const cache = await caches.open(MODEL_CACHE);
  const saved = await cache.match(MANIFEST_KEY);
  let manifest: ModelManifest;
  if (saved) manifest = restoreManifest(await saved.json());
  else {
    const bytes = await downloadModelData(`https://huggingface.co/api/models/${WHISPER_MODEL_ID}?blobs=true`, 2 * 1024 ** 2, signal, () => undefined);
    manifest = parseModelManifest(JSON.parse(new TextDecoder().decode(bytes)));
    // Pin before downloading so an interrupted install resumes the same revision.
    await cache.put(MANIFEST_KEY, Response.json(manifest));
  }
  const total = manifest.files.reduce((sum, item) => sum + item.size, 0); let completed = 0;
  for (const asset of manifest.files) {
    signal.throwIfAborted();
    const url = modelAssetUrl(manifest, asset.name);
    const cached = await cache.match(url);
    if (cached && await matchesDigest(new Uint8Array(await cached.arrayBuffer()), asset)) {
      completed += asset.size; onProgress({ completed, total, file: asset.name }); continue;
    }
    // HF redirects large weight data to its official CDN; no Authorization/cookies are used.
    await assertStorageCapacity(asset.size);
    const bytes = await downloadModelData(url, asset.size, signal, (loaded) => onProgress({ completed: completed + loaded, total, file: asset.name }), true);
    if (!await matchesDigest(bytes, asset)) throw localError("model_integrity_failed");
    await cache.put(url, new Response(bytes as Uint8Array<ArrayBuffer>));
    completed += asset.size; onProgress({ completed, total, file: asset.name });
  }
  return manifest;
}
