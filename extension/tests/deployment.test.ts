import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../manifest.json";
import { resolveBuildDeployment, createExtensionManifest } from "../build/deployment";

const releaseOrigin = "https://api.release-fixture.net";

describe("extension deployment configuration", () => {
  it("keeps the local development build usable", () => {
    const config = resolveBuildDeployment("production", {});
    expect(config).toEqual({ target: "local", apiOrigin: "", outDir: "dist" });
    expect(createExtensionManifest(manifest, config).host_permissions.every((host) => host.startsWith("https:"))).toBe(true);
  });

  it("builds release without a backend", () => {
    expect(resolveBuildDeployment("release", {})).toEqual({ target: "release", apiOrigin: "", outDir: "dist-release" });
  });

  it.each([
    "http://api.release-fixture.net", "https://localhost", "https://127.0.0.1",
    "https://[::1]", "https://10.0.0.1", "https://api.local", "https://api.internal",
    "https://api.test", "https://api.example.com", "https://api.invalid",
    "https://user:secret@api.release-fixture.net", `${releaseOrigin}/v1`,
    `${releaseOrigin}?key=secret`, `${releaseOrigin}#x`, `${releaseOrigin}:8443`,
    `${releaseOrigin}\\x`, "https://*.release-fixture.net", "https://api.release-fixture.net.",
  ])("does not use obsolete backend setting %s", (origin) => {
    expect(resolveBuildDeployment("release", { VEEKY_API_ORIGIN: origin }).apiOrigin).toBe("");
  });

  it("adds no backend permission in the release output", () => {
    const config = resolveBuildDeployment("release", { VEEKY_API_ORIGIN: `${releaseOrigin}/` });
    expect(config).toEqual({ target: "release", apiOrigin: "", outDir: "dist-release" });
    const generated = createExtensionManifest(manifest, config);
    expect(generated.host_permissions).toEqual([
      ...manifest.host_permissions.filter((entry) => !entry.startsWith("http:")),
    ]);
    expect(generated.host_permissions.some((entry) => entry.includes("localhost") || entry.includes("127.0.0.1"))).toBe(false);
    expect(generated.content_scripts).toEqual(manifest.content_scripts);
  });
});

describe("release API destination", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it("uses the built-in release origin and refuses runtime overrides before reading credentials", async () => {
    vi.stubGlobal("__VEEKY_DEPLOYMENT__", { target: "release", apiOrigin: releaseOrigin });
    vi.resetModules();
    const { createApi, DEFAULT_API_BASE_URL } = await import("../src/sidepanel/api");
    expect(DEFAULT_API_BASE_URL).toBe(releaseOrigin);
    const store = { loadOrCreate: vi.fn() };
    expect(() => createApi("http://127.0.0.1:8000", store)).toThrow(/backend|后端/i);
    expect(() => createApi("https://other.release-fixture.net", store)).toThrow();
    expect(store.loadOrCreate).not.toHaveBeenCalled();
  });

  it("sends requests to the release host without following redirects", async () => {
    vi.stubGlobal("__VEEKY_DEPLOYMENT__", { target: "release", apiOrigin: releaseOrigin });
    vi.resetModules();
    const { createApi } = await import("../src/sidepanel/api");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], hasMore: false })));
    vi.stubGlobal("fetch", fetchMock);
    const store = { loadOrCreate: vi.fn(async () => ({ installationId: "test", installationToken: "a".repeat(43) })) };
    await createApi(releaseOrigin, store).getHistory();
    expect(fetchMock).toHaveBeenCalledWith(`${releaseOrigin}/v1/analyses/history`, expect.objectContaining({ redirect: "error", credentials: "omit" }));
  });

  it("gives store users a service error instead of Docker installation instructions", async () => {
    vi.stubGlobal("__VEEKY_DEPLOYMENT__", { target: "release", apiOrigin: releaseOrigin });
    vi.resetModules();
    const { errorMessageForCode } = await import("../src/sidepanel/store");
    for (const code of ["api_unavailable", "worker_unavailable"]) {
      expect(errorMessageForCode(code)).not.toMatch(/docker/i);
      expect(errorMessageForCode(code)).not.toBe("分析没有完成，请稍后重试");
    }
  });
});
