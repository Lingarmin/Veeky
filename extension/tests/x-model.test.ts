// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWhisperModel, parseModelManifest, modelAssetUrl, WHISPER_MODEL_ID } from "../src/local/x-model";

describe("Whisper small pinned model data", () => {
  const required = ["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "generation_config.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"];
  const info = () => ({ sha: "a".repeat(40), siblings: required.map((rfilename) => ({ rfilename, blobId: "b".repeat(40), size: 100 })) });
  it("pins an immutable commit and accepts only the fixed small model's required data", () => {
    const manifest = parseModelManifest(info());
    expect(manifest.model).toBe(WHISPER_MODEL_ID);
    expect(manifest.revision).toBe("a".repeat(40));
    expect(modelAssetUrl(manifest, "config.json")).toContain(`/resolve/${manifest.revision}/config.json`);
    expect(() => modelAssetUrl(manifest, "../code.js")).toThrow("model_manifest_invalid");
  });
  it("rejects floating revisions, absent weights, oversized files and unsafe digests", () => {
    expect(() => parseModelManifest({ ...info(), sha: "main" })).toThrow();
    expect(() => parseModelManifest({ ...info(), siblings: [] })).toThrow();
    const bad = info(); bad.siblings[0].size = 2 ** 30;
    expect(() => parseModelManifest(bad)).toThrow();
    const digest = info(); digest.siblings[0].blobId = "bad";
    expect(() => parseModelManifest(digest)).toThrow();
  });
});

describe("model download failures and destinations", () => {
  const manifestKey = "https://huggingface.co/veeky-local/whisper-small-manifest-v1";
  const required = ["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "generation_config.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"];
  let entries: Map<string, Response>;
  let manifest: ReturnType<typeof parseModelManifest>;
  beforeEach(async () => {
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: 0, quota: 2 ** 30 }) } });
    entries = new Map();
    vi.stubGlobal("caches", { open: async () => ({
      match: async (url: string) => entries.get(url)?.clone(),
      put: async (url: string, response: Response) => { entries.set(url, response.clone()); },
    }) });
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([1]))), byte => byte.toString(16).padStart(2, "0")).join("");
    manifest = parseModelManifest({ sha: "a".repeat(40), siblings: required.map(rfilename => ({ rfilename, lfs: { size: 1, sha256: digest } })) });
  });
  afterEach(() => vi.unstubAllGlobals());
  const responseAt = (url: string, body: BodyInit | null = new Uint8Array([1])) => {
    const response = new Response(body);
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const install = (signal = new AbortController().signal) => ensureWhisperModel(signal, () => undefined);
  it("refuses model downloads when the browser has insufficient capacity", async () => {
    entries.set(manifestKey, Response.json(manifest));
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: 10, quota: 10 }) } });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(install()).rejects.toMatchObject({ code: "storage_quota_exceeded" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([new TypeError("Failed to fetch"), new DOMException("Timed out", "TimeoutError")])("classifies metadata transport failures: %s", async (error) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(install()).rejects.toMatchObject({ code: "model_download_failed" });
  });
  it("classifies interrupted weight response bodies", async () => {
    entries.set(manifestKey, Response.json(manifest));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => responseAt(url, new ReadableStream({
      start(controller) { controller.error(new TypeError("Connection reset")); },
    }))));
    await expect(install()).rejects.toMatchObject({ code: "model_download_failed" });
  });
  it("preserves user cancellation", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(); throw controller.signal.reason; }));
    await expect(install(controller.signal)).rejects.toMatchObject({ code: "analysis_cancelled" });
  });
  it.each(["https://evil.test/model", "https://huggingface.co.evil.test/model", "http://cdn-lfs.hf.co/model", "https://user@cdn-lfs.hf.co/model", "https://cdn-lfs.hf.co:8443/model"])("rejects an untrusted final model destination: %s", async (destination) => {
    entries.set(manifestKey, Response.json(manifest));
    vi.stubGlobal("fetch", vi.fn(async () => responseAt(destination)));
    await expect(install()).rejects.toMatchObject({ code: "model_download_failed" });
    expect(entries.size).toBe(1);
  });
  it("accepts verified weight data from the official Hugging Face CDN", async () => {
    entries.set(manifestKey, Response.json(manifest));
    vi.stubGlobal("fetch", vi.fn(async () => responseAt("https://cas-bridge.xethub.hf.co/model")));
    await expect(install()).resolves.toEqual(manifest);
    expect(entries.size).toBe(8);
  });
  it("preserves integrity errors after an approved download", async () => {
    entries.set(manifestKey, Response.json(manifest));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => responseAt(url, new Uint8Array([2]))));
    await expect(install()).rejects.toMatchObject({ code: "model_integrity_failed" });
  });
});
