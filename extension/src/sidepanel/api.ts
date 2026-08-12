import type {
  AnalysisResult,
  AnalysisHistoryResponse,
  AnalysisStatus,
  JobStatus,
  VideoInspection,
} from "../shared/types";
import {
  browserInstallationIdentityStore,
  type InstallationIdentity,
  type InstallationIdentityStore,
} from "./identity";

export interface AnalysisCreateResponse {
  jobId: string;
  cacheHit: boolean;
  status: JobStatus;
}

export interface AnalysisApi {
  testLlm(config: { provider: string; apiUrl: string; apiKey: string; model: string }): Promise<{ ok: boolean; message: string }>;
  inspect(url: string): Promise<VideoInspection>;
  createAnalysis(input: {
    videoId: string;
    sourceLanguage: string;
    targetLanguage: string;
    title: string;
    llmConfig: { provider: string; apiUrl: string; apiKey: string; model: string };
    force?: boolean;
  }): Promise<AnalysisCreateResponse>;
  getHistory(input?: { videoId?: string; limit?: number; offset?: number }): Promise<AnalysisHistoryResponse>;
  getStatus(jobId: string): Promise<AnalysisStatus>;
  getResult(jobId: string): Promise<AnalysisResult>;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

export function createApi(
  baseUrl = "http://127.0.0.1:8000",
  identityStore: InstallationIdentityStore = browserInstallationIdentityStore,
): AnalysisApi {
  return {
    testLlm: (config) => request(`${baseUrl}/v1/llm/test`, identityStore, {
      method: "POST",
      body: JSON.stringify(config),
    }),
    inspect: (url) => request(`${baseUrl}/v1/videos/inspect`, identityStore, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
    createAnalysis: (input) => request(`${baseUrl}/v1/analyses`, identityStore, {
      method: "POST",
      body: JSON.stringify(input),
    }),
    getHistory: (input = {}) => {
      const query = new URLSearchParams();
      if (input.videoId) query.set("videoId", input.videoId);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      if (input.offset !== undefined) query.set("offset", String(input.offset));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request(`${baseUrl}/v1/analyses/history${suffix}`, identityStore);
    },
    getStatus: (jobId) => request(`${baseUrl}/v1/analyses/${jobId}`, identityStore),
    getResult: (jobId) => request(`${baseUrl}/v1/analyses/${jobId}/result`, identityStore),
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
    throw new ApiError("api_unavailable", "无法连接分析服务", 0, { cause: error });
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
    );
  }
  return body as T;
}
