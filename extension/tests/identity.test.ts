import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, createApi } from "../src/sidepanel/api";
import { browserInstallationIdentityStore } from "../src/sidepanel/identity";

const installationIdentity = {
  installationId: "11111111-1111-4111-8111-111111111111",
  installationToken: "a".repeat(43),
};

function createIdentityStore() {
  return { loadOrCreate: vi.fn(async () => installationIdentity) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("installation identity", () => {
  beforeEach(() => {
    const values: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => key in values ? { [key]: values[key] } : {}),
          set: vi.fn(async (next: Record<string, unknown>) => Object.assign(values, next)),
        },
      },
    });
  });

  it("creates and retains a stable identity in local storage", async () => {
    const first = await browserInstallationIdentityStore.loadOrCreate();
    const second = await browserInstallationIdentityStore.loadOrCreate();

    expect(second).toEqual(first);
    expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.installationToken.length).toBeGreaterThanOrEqual(43);
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it("authenticates an API request with the installation headers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      videoId: "aircAruvnKk", durationMs: 1000, tracks: [], selectedLanguage: "en",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createIdentityStore();

    await createApi("http://api.test", store).inspect("https://www.youtube.com/watch?v=aircAruvnKk");

    const [, firstInit] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const headers = new Headers(firstInit.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${installationIdentity.installationToken}`);
    expect(headers.get("X-Veeky-Installation-Id")).toBe(installationIdentity.installationId);
  });

  it("registers once and retries once when the installation is unknown", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ detail: { code: "installation_auth_required" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ installationId: installationIdentity.installationId }, 201))
      .mockResolvedValueOnce(jsonResponse({
        videoId: "aircAruvnKk", durationMs: 1000, tracks: [], selectedLanguage: "en",
      }));
    vi.stubGlobal("fetch", fetchMock);
    const store = createIdentityStore();

    await createApi("http://api.test", store).inspect("https://www.youtube.com/watch?v=aircAruvnKk");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("http://api.test/v1/installations/register");
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      installationId: installationIdentity.installationId,
      installationToken: installationIdentity.installationToken,
    });
    for (const call of fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>) {
      const [, init] = call;
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${installationIdentity.installationToken}`);
      expect(headers.get("X-Veeky-Installation-Id")).toBe(installationIdentity.installationId);
    }
  });

  it("surfaces a second installation authentication failure without another registration", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ detail: { code: "installation_auth_required" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ installationId: installationIdentity.installationId }, 201))
      .mockResolvedValueOnce(jsonResponse({ detail: { code: "installation_auth_required", message: "invalid" } }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const store = createIdentityStore();

    await expect(
      createApi("http://api.test", store).inspect("https://www.youtube.com/watch?v=aircAruvnKk"),
    ).rejects.toMatchObject({ code: "installation_auth_required", status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/v1/installations/register"))).toHaveLength(1);
  });

  it("preserves Retry-After on API errors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      detail: { code: "rate_limit_exceeded", message: "slow down" },
    }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "37" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createApi("http://api.test", createIdentityStore()).getHistory(),
    ).rejects.toMatchObject({
      code: "rate_limit_exceeded",
      status: 429,
      retryAfter: 37,
    });
  });
});
