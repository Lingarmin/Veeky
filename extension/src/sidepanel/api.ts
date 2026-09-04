import type {
  AnalysisResult,
  AnalysisHistoryResponse,
  AnalysisStatus,
  ContentContext,
  ContentRef,
  JobStatus,
  VideoInspection,
} from "../shared/types";
import {
  browserInstallationIdentityStore,
  type InstallationIdentity,
  type InstallationIdentityStore,
} from "./identity";

export interface AnalysisCreateResponse extends ContentContext {
  jobId: string;
  cacheHit: boolean;
  status: JobStatus;
}

export interface MediaCandidateInput {
  url: string;
  kind: "mp4" | "hls" | "segment";
  capturedAt: number;
}

export interface InspectInput {
  url: string;
  preferredLanguages?: string[];
  activeMediaIndex?: number;
  clientDurationMs?: number;
  mediaCandidates?: MediaCandidateInput[];
}

type ContentLocator =
  | { contentId: string; contentRef?: never; videoId?: never }
  | { contentRef: ContentRef; contentId?: never; videoId?: never }
  | { videoId: string; contentId?: never; contentRef?: never };

export type AnalysisCreateInput = ContentLocator & {
  sourceLanguage?: string;
  targetLanguage?: string;
  title?: string;
  llmConfig: { provider: string; apiUrl: string; apiKey: string; model: string };
  mediaUrl?: string;
  mediaSessionId?: string;
  force?: boolean;
};

export interface AnalysisHistoryInput {
  contentId?: string;
  videoId?: string;
  limit?: number;
  offset?: number;
}

export interface AnalysisApi {
  testLlm(config: { provider: string; apiUrl: string; apiKey: string; model: string }): Promise<{ ok: boolean; message: string }>;
  inspect(input: string | InspectInput): Promise<VideoInspection>;
  createAnalysis(input: AnalysisCreateInput): Promise<AnalysisCreateResponse>;
  getHistory(input?: AnalysisHistoryInput): Promise<AnalysisHistoryResponse>;
  getStatus(jobId: string): Promise<AnalysisStatus>;
  getResult(jobId: string): Promise<AnalysisResult>;
}

export interface MediaSession {
  sessionId: string;
  contentId: string;
  kind: "mp4" | "hls";
  status: string;
  expectedBytes: number;
  receivedBytes: number;
  partSizeBytes: number;
  partCount: number;
  uploadedParts: number[];
}

export interface MediaArtifact {
  sessionId: string;
  contentId: string;
  kind: "mp4" | "hls";
  status: "complete";
  totalBytes: number;
  partCount: number;
}

export interface MediaSessionCompleteInput {
  kind: "mp4" | "hls";
  partCount: number;
  totalBytes: number;
  manifest?: { parts: number[] };
}

export interface MediaUploadApi {
  inspect(input: string | InspectInput): Promise<VideoInspection>;
  createMediaSession(input: {
    contentId: string;
    kind: "mp4" | "hls";
    expectedBytes: number;
    partCount: number;
  }): Promise<MediaSession>;
  getMediaSession(sessionId: string): Promise<MediaSession>;
  uploadPart(sessionId: string, partNumber: number, bytes: Uint8Array, sha256: string): Promise<void>;
  completeMediaSession(sessionId: string, input: MediaSessionCompleteInput): Promise<MediaArtifact>;
  cancelMediaSession(sessionId: string): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryAfter: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

export function createApi(
  baseUrl = "http://127.0.0.1:8000",
  identityStore: InstallationIdentityStore = browserInstallationIdentityStore,
): AnalysisApi & MediaUploadApi {
  return {
    testLlm: (config) => request(`${baseUrl}/v1/llm/test`, identityStore, {
      method: "POST",
      body: JSON.stringify(config),
    }),
    inspect: (input) => request(`${baseUrl}/v1/videos/inspect`, identityStore, {
      method: "POST",
      body: JSON.stringify(typeof input === "string" ? { url: input } : input),
    }),
    createAnalysis: (input) => request(`${baseUrl}/v1/analyses`, identityStore, {
      method: "POST",
      body: JSON.stringify(input),
    }),
    getHistory: (input = {}) => {
      const query = new URLSearchParams();
      if (input.contentId) query.set("contentId", input.contentId);
      if (input.videoId) query.set("videoId", input.videoId);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      if (input.offset !== undefined) query.set("offset", String(input.offset));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request(`${baseUrl}/v1/analyses/history${suffix}`, identityStore);
    },
    getStatus: (jobId) => request(`${baseUrl}/v1/analyses/${jobId}`, identityStore),
    getResult: (jobId) => request(`${baseUrl}/v1/analyses/${jobId}/result`, identityStore),
    createMediaSession: (input) => request(`${baseUrl}/v1/media-sessions`, identityStore, {
      method: "POST",
      body: JSON.stringify(input),
    }),
    getMediaSession: (sessionId) => request(`${baseUrl}/v1/media-sessions/${sessionId}`, identityStore),
    uploadPart: (sessionId, partNumber, bytes, sha256) => {
      const body = new Uint8Array(bytes.byteLength);
      body.set(bytes);
      return request(
        `${baseUrl}/v1/media-sessions/${sessionId}/parts/${partNumber}`,
        identityStore,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Content-SHA256": sha256,
          },
          body: body.buffer,
        },
      );
    },
    completeMediaSession: (sessionId, { kind: _kind, ...input }) => request(
      `${baseUrl}/v1/media-sessions/${sessionId}/complete`,
      identityStore,
      { method: "POST", body: JSON.stringify(input) },
    ),
    cancelMediaSession: (sessionId) => request(
      `${baseUrl}/v1/media-sessions/${sessionId}`,
      identityStore,
      { method: "DELETE" },
    ),
  };
}

async function request<T>(
  url: string,
  identityStore: InstallationIdentityStore,
  init: RequestInit = {},
): Promise<T> {
  const identity = await identityStore.loadOrCreate();
  const response = await authenticatedFetch(url, init, identity);
  const body = await parseResponse(response);
  if (response.status === 401 && body.detail?.code === "installation_auth_required") {
    await registerInstallation(url, identity);
    const retriedResponse = await authenticatedFetch(url, init, identity);
    return parseApiResponse<T>(retriedResponse, await parseResponse(retriedResponse));
  }
  return parseApiResponse<T>(response, body);
}

async function authenticatedFetch(
  url: string,
  init: RequestInit,
  identity: InstallationIdentity,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
        "Authorization": `Bearer ${identity.installationToken}`,
        "X-Veeky-Installation-Id": identity.installationId,
      },
    });
  } catch (error) {
    throw new ApiError("api_unavailable", "无法连接分析服务", 0, null, { cause: error });
  }
  return response;
}

async function registerInstallation(url: string, identity: InstallationIdentity): Promise<void> {
  const registrationUrl = new URL("/v1/installations/register", url).toString();
  const response = await authenticatedFetch(registrationUrl, {
    method: "POST",
    body: JSON.stringify(identity),
  }, identity);
  await parseApiResponse(response, await parseResponse(response));
}

async function parseResponse(response: Response): Promise<Record<string, any>> {
  return response.json().catch(() => ({}));
}

function parseApiResponse<T>(response: Response, body: Record<string, any>): T {
  if (!response.ok) {
    const detail = body.detail ?? {};
    throw new ApiError(
      detail.code ?? "api_error",
      detail.message ?? "分析请求失败",
      response.status,
      parseRetryAfter(response.headers.get("Retry-After")),
    );
  }
  return body as T;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
