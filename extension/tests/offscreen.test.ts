import { describe, expect, it, vi } from "vitest";

import {
  installOffscreenHandlers,
  uploadMediaCandidate,
  type MediaPartSpool,
  type MediaUploadApi,
} from "../src/offscreen/index";
import type { ContentRef, MediaCandidate, MediaUploadProgressMessage } from "../src/shared/types";

const MIB = 1024 * 1024;
const contentRef: ContentRef = {
  platform: "x",
  sourceContentId: "2075545587093807111",
  mediaIndex: 1,
};

function responseFromChunks(
  chunks: Uint8Array[],
  headers: HeadersInit = {},
  finalUrl?: string,
): Response {
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers });
  if (finalUrl) Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

function textResponse(body: string, finalUrl?: string): Response {
  const response = new Response(body, {
    headers: { "Content-Type": "application/vnd.apple.mpegurl" },
  });
  if (finalUrl) Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

function createSpool() {
  const parts = new Map<number, Uint8Array>();
  return {
    write: vi.fn<MediaPartSpool["write"]>(async (partNumber, bytes) => {
      parts.set(partNumber, bytes.slice());
    }),
    read: vi.fn<MediaPartSpool["read"]>(async (partNumber) => {
      const part = parts.get(partNumber);
      if (!part) throw new Error(`missing spooled part ${partNumber}`);
      return part.slice();
    }),
    dispose: vi.fn<MediaPartSpool["dispose"]>(async () => { parts.clear(); }),
  } satisfies MediaPartSpool;
}

function createApi(overrides: Partial<MediaUploadApi> = {}) {
  return {
    inspect: vi.fn<MediaUploadApi["inspect"]>(async () => ({
      contentId: "33333333-3333-4333-8333-333333333333",
      contentRef,
      videoId: null,
      durationMs: 4000,
      sourceStatus: "ready",
      transcriptSource: "faster_whisper",
      availableLanguages: [],
      tracks: [],
      selectedLanguage: "",
    })),
    createMediaSession: vi.fn<MediaUploadApi["createMediaSession"]>(async (input) => ({
      sessionId: "session-1",
      contentId: input.contentId,
      kind: input.kind,
      status: "created",
      expectedBytes: input.expectedBytes,
      receivedBytes: 0,
      partSizeBytes: 8 * MIB,
      partCount: input.partCount,
      uploadedParts: [],
    })),
    getMediaSession: vi.fn<MediaUploadApi["getMediaSession"]>(async () => ({
      sessionId: "session-1",
      contentId: "33333333-3333-4333-8333-333333333333",
      kind: "mp4",
      status: "uploading",
      expectedBytes: 18 * MIB,
      receivedBytes: 0,
      partSizeBytes: 8 * MIB,
      partCount: 3,
      uploadedParts: [],
    })),
    uploadPart: vi.fn<MediaUploadApi["uploadPart"]>(async () => undefined),
    completeMediaSession: vi.fn<MediaUploadApi["completeMediaSession"]>(async (sessionId, input) => ({
      sessionId,
      contentId: "33333333-3333-4333-8333-333333333333",
      kind: input.kind,
      status: "complete",
      totalBytes: input.totalBytes,
      partCount: input.partCount,
    })),
    ...overrides,
  } satisfies MediaUploadApi;
}

describe("offscreen X media upload", () => {
  it("streams an 18 MiB MP4 as three ordered 8 MiB parts with SHA-256", async () => {
    const bytes = new Uint8Array(18 * MIB);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const fetchMedia = vi.fn(async () => responseFromChunks([
      bytes.subarray(0, 5 * MIB),
      bytes.subarray(5 * MIB, 13 * MIB),
      bytes.subarray(13 * MIB),
    ], { "Content-Length": String(bytes.length) }));
    const api = createApi();
    const reportProgress = vi.fn<(message: MediaUploadProgressMessage) => Promise<void>>(async () => undefined);

    const sessionId = await uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-1",
      contentRef,
      candidate: {
        url: "https://video.twimg.com/amplify_video/123/vid/avc1/file.mp4?token=opaque",
        kind: "mp4",
        capturedAt: Date.now(),
      },
    }, { fetchMedia, api, reportProgress });

    expect(sessionId).toBe("session-1");
    expect(fetchMedia).toHaveBeenCalledWith(
      "https://video.twimg.com/amplify_video/123/vid/avc1/file.mp4?token=opaque",
      { credentials: "include" },
    );
    expect(vi.mocked(api.uploadPart).mock.calls.map((call) => call[1])).toEqual([0, 1, 2]);
    expect(vi.mocked(api.uploadPart).mock.calls.map((call) => call[2].byteLength)).toEqual([8 * MIB, 8 * MIB, 2 * MIB]);
    for (const [, , , sha256] of vi.mocked(api.uploadPart).mock.calls) {
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(api.completeMediaSession).toHaveBeenCalledWith("session-1", {
      kind: "mp4",
      partCount: 3,
      totalBytes: 18 * MIB,
    });
    expect(reportProgress).toHaveBeenLastCalledWith({
      type: "MEDIA_UPLOAD_PROGRESS",
      jobId: "job-1",
      uploadedBytes: 18 * MIB,
      totalBytes: 18 * MIB,
    });
  });

  it("spools an MP4 without Content-Length in bounded 8 MiB parts", async () => {
    const spool = createSpool();
    const api = createApi();
    const bytes = new Uint8Array(18 * MIB);

    await uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-no-length",
      contentRef,
      candidate: { url: "https://video.twimg.com/no-length.mp4", kind: "mp4", capturedAt: 1 },
    }, {
      fetchMedia: vi.fn(async () => responseFromChunks([
        bytes.subarray(0, 7 * MIB),
        bytes.subarray(7 * MIB, 15 * MIB),
        bytes.subarray(15 * MIB),
      ])),
      api,
      reportProgress: async () => undefined,
      createPartSpool: vi.fn(async () => spool),
    });

    expect(spool.write.mock.calls.map(([partNumber, part]) => [partNumber, part.byteLength]))
      .toEqual([[0, 8 * MIB], [1, 8 * MIB], [2, 2 * MIB]]);
    expect(spool.read.mock.calls.map(([partNumber]) => partNumber)).toEqual([0, 1, 2]);
    expect(spool.dispose).toHaveBeenCalledOnce();
    expect(vi.mocked(api.createMediaSession)).toHaveBeenCalledWith({
      contentId: "33333333-3333-4333-8333-333333333333",
      kind: "mp4",
      expectedBytes: 18 * MIB,
      partCount: 3,
    });
  });

  it("reports a stable error when browser part storage is unavailable", async () => {
    await expect(uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-no-storage",
      contentRef,
      candidate: { url: "https://video.twimg.com/no-length.mp4", kind: "mp4", capturedAt: 1 },
    }, {
      fetchMedia: vi.fn(async () => responseFromChunks([new Uint8Array([1])])),
      api: createApi(),
      reportProgress: async () => undefined,
    })).rejects.toMatchObject({ code: "media_spool_unavailable" });
  });

  it("queries session state before retrying a failed part", async () => {
    const events: string[] = [];
    const uploadPart = vi.fn<MediaUploadApi["uploadPart"]>(async (_sessionId, partNumber) => {
      events.push(`upload:${partNumber}`);
      if (uploadPart.mock.calls.length === 1) throw new Error("connection reset");
    });
    const getMediaSession = vi.fn<MediaUploadApi["getMediaSession"]>(async () => {
      events.push("status");
      return {
        sessionId: "session-1",
        contentId: "33333333-3333-4333-8333-333333333333",
        kind: "mp4",
        status: "uploading",
        expectedBytes: 4,
        receivedBytes: 0,
        partSizeBytes: 8 * MIB,
        partCount: 1,
        uploadedParts: [],
      };
    });
    const api = createApi({ uploadPart, getMediaSession });

    await uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-retry",
      contentRef,
      candidate: { url: "https://video.twimg.com/file.mp4", kind: "mp4", capturedAt: 1 },
    }, {
      fetchMedia: vi.fn(async () => responseFromChunks([new Uint8Array([1, 2, 3, 4])], {
        "Content-Length": "4",
      })),
      api,
      reportProgress: async () => undefined,
    });

    expect(events).toEqual(["upload:0", "status", "upload:0"]);
  });

  it("does not resend a part already accepted before the connection failed", async () => {
    const uploadPart = vi.fn<MediaUploadApi["uploadPart"]>(async () => {
      throw new Error("response lost");
    });
    const api = createApi({
      uploadPart,
      getMediaSession: vi.fn(async () => ({
        sessionId: "session-1",
        contentId: "33333333-3333-4333-8333-333333333333",
        kind: "mp4" as const,
        status: "uploading",
        expectedBytes: 4,
        receivedBytes: 4,
        partSizeBytes: 8 * MIB,
        partCount: 1,
        uploadedParts: [0],
      })),
    });

    await uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-resume",
      contentRef,
      candidate: { url: "https://video.twimg.com/file.mp4", kind: "mp4", capturedAt: 1 },
    }, {
      fetchMedia: vi.fn(async () => responseFromChunks([new Uint8Array([1, 2, 3, 4])], {
        "Content-Length": "4",
      })),
      api,
      reportProgress: async () => undefined,
    });

    expect(uploadPart).toHaveBeenCalledTimes(1);
    expect(api.completeMediaSession).toHaveBeenCalledOnce();
  });

  it("keeps X cookies and authorization data out of API metadata", async () => {
    const api = createApi();
    const candidate = {
      url: "https://video.twimg.com/file.mp4",
      kind: "mp4",
      capturedAt: 1,
      headers: {
        Cookie: "auth_token=x-cookie",
        Authorization: "Bearer x-token",
      },
    } as MediaCandidate;

    await uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD", jobId: "job-secret", contentRef, candidate,
    }, {
      fetchMedia: vi.fn(async (_url, init) => {
        expect(new Headers(init?.headers).has("Cookie")).toBe(false);
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return responseFromChunks([new Uint8Array([1])], { "Content-Length": "1" });
      }),
      api,
      reportProgress: async () => undefined,
    });

    const apiMetadata = JSON.stringify([
      ...vi.mocked(api.inspect).mock.calls,
      ...vi.mocked(api.createMediaSession).mock.calls,
      ...vi.mocked(api.completeMediaSession).mock.calls,
    ]);
    expect(apiMetadata).not.toContain("auth_token");
    expect(apiMetadata).not.toContain("x-token");
    expect(apiMetadata).not.toContain("Cookie");
    expect(apiMetadata).not.toContain("Authorization");
  });

  it("selects the highest-bandwidth HLS variant at or below 1080p", async () => {
    const masterUrl = "https://video.twimg.com/path/master.m3u8";
    const selectedUrl = "https://video.twimg.com/path/1080/playlist.m3u8";
    const resources = new Map<string, Response>([
      [masterUrl, textResponse([
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160",
        "2160/playlist.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080",
        "1080/playlist.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720",
        "720/playlist.m3u8",
      ].join("\n"))],
      [selectedUrl, textResponse([
        "#EXTM3U",
        "#EXT-X-MAP:URI=\"init.mp4\"",
        "#EXTINF:2.0,",
        "segment-1.m4s",
        "#EXTINF:2.0,",
        "segment-2.m4s",
      ].join("\n"))],
      ["https://video.twimg.com/path/1080/init.mp4", responseFromChunks([new Uint8Array([1, 2])])],
      ["https://video.twimg.com/path/1080/segment-1.m4s", responseFromChunks([new Uint8Array([3, 4, 5])])],
      ["https://video.twimg.com/path/1080/segment-2.m4s", responseFromChunks([new Uint8Array([6])])],
    ]);
    const fetchMedia = vi.fn(async (url: RequestInfo | URL) => {
      const response = resources.get(String(url));
      if (!response) throw new Error(`unexpected fetch ${String(url)}`);
      return response;
    });
    const api = createApi();

    await uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-hls",
      contentRef,
      candidate: { url: masterUrl, kind: "hls", capturedAt: 1 },
    }, {
      fetchMedia,
      api,
      reportProgress: async () => undefined,
      createPartSpool: async () => createSpool(),
    });

    expect(fetchMedia.mock.calls.map(([url]) => String(url))).toEqual([
      masterUrl,
      selectedUrl,
      "https://video.twimg.com/path/1080/init.mp4",
      "https://video.twimg.com/path/1080/segment-1.m4s",
      "https://video.twimg.com/path/1080/segment-2.m4s",
    ]);
    expect(Array.from(vi.mocked(api.uploadPart).mock.calls[0][2])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(api.completeMediaSession).toHaveBeenCalledWith("session-1", {
      kind: "hls",
      partCount: 1,
      totalBytes: 6,
      manifest: { parts: [0] },
    });
  });

  it.each([
    "http://video.twimg.com/path/master.m3u8",
    "https://example.com/path/master.m3u8",
  ])("rejects an unsafe HLS playlist URL: %s", async (url) => {
    await expect(uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-invalid-hls",
      contentRef,
      candidate: { url, kind: "hls", capturedAt: 1 },
    }, {
      fetchMedia: vi.fn(),
      api: createApi(),
      reportProgress: async () => undefined,
      createPartSpool: async () => createSpool(),
    })).rejects.toMatchObject({ code: "invalid_media_url" });
  });

  it("rejects HLS references outside video.twimg.com", async () => {
    await expect(uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-invalid-reference",
      contentRef,
      candidate: { url: "https://video.twimg.com/master.m3u8", kind: "hls", capturedAt: 1 },
    }, {
      fetchMedia: vi.fn(async () => textResponse([
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080",
        "https://evil.example/playlist.m3u8",
      ].join("\n"))),
      api: createApi(),
      reportProgress: async () => undefined,
    })).rejects.toMatchObject({ code: "invalid_media_url" });
  });

  it.each([
    "#EXT-X-KEY:METHOD=AES-128,URI=\"https://evil.example/key.bin\"",
    "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",URI=\"https://evil.example/audio.m3u8\"",
    "#EXT-X-MAP:URI=\"https://evil.example/init.mp4\"",
    "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI=\"https://evil.example/iframe.m3u8\"",
    "#EXT-X-SESSION-DATA:DATA-ID=\"com.example\",URI=\"https://evil.example/data.json\"",
    "#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"https://evil.example/key.bin\"",
    "#EXT-X-RENDITION-REPORT:URI=\"https://evil.example/live.m3u8\"",
    "#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"https://evil.example/next.m4s\"",
    "#EXT-X-PART:DURATION=0.333,URI=\"https://evil.example/part.m4s\"",
    "#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://evil.example/steering.json\"",
  ])("rejects an off-host URI attribute in %s", async (tag) => {
    const playlistUrl = "https://video.twimg.com/path/media.m3u8";
    await expect(uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-invalid-tag",
      contentRef,
      candidate: { url: playlistUrl, kind: "hls", capturedAt: 1 },
    }, {
      fetchMedia: vi.fn(async (url) => String(url) === playlistUrl
        ? textResponse(["#EXTM3U", tag, "segment.m4s"].join("\n"), playlistUrl)
        : responseFromChunks([new Uint8Array([1])], {}, String(url))),
      api: createApi(),
      reportProgress: async () => undefined,
    })).rejects.toMatchObject({ code: "invalid_media_url" });
  });

  it("rejects a playlist redirect outside video.twimg.com", async () => {
    await expect(uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-playlist-redirect",
      contentRef,
      candidate: {
        url: "https://video.twimg.com/path/master.m3u8",
        kind: "hls",
        capturedAt: 1,
      },
    }, {
      fetchMedia: vi.fn(async () => textResponse(
        "#EXTM3U\nhttps://video.twimg.com/path/segment.m4s",
        "https://evil.example/master.m3u8",
      )),
      api: createApi(),
      reportProgress: async () => undefined,
    })).rejects.toMatchObject({ code: "invalid_media_url" });
  });

  it("rejects a media segment redirect outside video.twimg.com", async () => {
    const playlistUrl = "https://video.twimg.com/path/media.m3u8";
    const segmentUrl = "https://video.twimg.com/path/segment.m4s";
    await expect(uploadMediaCandidate({
      type: "START_MEDIA_UPLOAD",
      jobId: "job-segment-redirect",
      contentRef,
      candidate: { url: playlistUrl, kind: "hls", capturedAt: 1 },
    }, {
      fetchMedia: vi.fn(async (url) => String(url) === playlistUrl
        ? textResponse(`#EXTM3U\n${segmentUrl}`, playlistUrl)
        : responseFromChunks([new Uint8Array([1])], {}, "https://evil.example/segment.m4s")),
      api: createApi(),
      reportProgress: async () => undefined,
      createPartSpool: async () => createSpool(),
    })).rejects.toMatchObject({ code: "invalid_media_url" });
  });
});

describe("offscreen message handling", () => {
  function createRuntime() {
    const listeners: Array<(message: unknown) => void> = [];
    return {
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => { listeners.push(listener); }),
      },
      sendMessage: vi.fn(async () => undefined),
      dispatch(message: unknown) {
        for (const listener of listeners) listener(message);
      },
    };
  }

  const startMessage = {
    type: "START_MEDIA_UPLOAD" as const,
    jobId: "job-handler",
    contentRef,
    candidate: { url: "https://video.twimg.com/file.mp4", kind: "mp4" as const, capturedAt: 1 },
  };

  it("sends MEDIA_UPLOAD_COMPLETE after a successful upload", async () => {
    const runtime = createRuntime();
    installOffscreenHandlers({ runtime } as never, {
      fetchMedia: vi.fn(async () => responseFromChunks([new Uint8Array([1])], {
        "Content-Length": "1",
      })),
      api: createApi(),
      reportProgress: async () => undefined,
    });

    runtime.dispatch(startMessage);

    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: "MEDIA_UPLOAD_COMPLETE",
      jobId: "job-handler",
      mediaSessionId: "session-1",
    }));
  });

  it("sends MEDIA_UPLOAD_FAILED with the upload error code", async () => {
    const runtime = createRuntime();
    installOffscreenHandlers({ runtime } as never, {
      fetchMedia: vi.fn(async () => new Response(null, { status: 403 })),
      api: createApi(),
      reportProgress: async () => undefined,
    });

    runtime.dispatch(startMessage);

    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: "MEDIA_UPLOAD_FAILED",
      jobId: "job-handler",
      code: "media_fetch_failed",
    }));
  });

  it("runs only one upload for concurrent START messages for the same job", async () => {
    const runtime = createRuntime();
    let releaseFetch: ((response: Response) => void) | undefined;
    const fetchMedia = vi.fn(() => new Promise<Response>((resolve) => { releaseFetch = resolve; }));
    const api = createApi();
    installOffscreenHandlers({ runtime } as never, {
      fetchMedia,
      api,
      reportProgress: async () => undefined,
    });

    runtime.dispatch(startMessage);
    runtime.dispatch(startMessage);
    await vi.waitFor(() => expect(fetchMedia).toHaveBeenCalledOnce());
    releaseFetch?.(responseFromChunks([new Uint8Array([1])], { "Content-Length": "1" }));
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "MEDIA_UPLOAD_COMPLETE",
      jobId: "job-handler",
    })));

    expect(api.inspect).toHaveBeenCalledOnce();
    expect(api.createMediaSession).toHaveBeenCalledOnce();
  });
});
