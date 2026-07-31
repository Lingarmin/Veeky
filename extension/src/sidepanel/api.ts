import type {
  AnalysisResult,
  AnalysisStatus,
  JobStatus,
  VideoInspection,
} from "../shared/types";

export interface AnalysisCreateResponse {
  jobId: string;
  cacheHit: boolean;
  status: JobStatus;
}

export interface AnalysisApi {
  inspect(url: string): Promise<VideoInspection>;
  createAnalysis(input: {
    videoId: string;
    sourceLanguage: string;
    targetLanguage: string;
    title: string;
  }): Promise<AnalysisCreateResponse>;
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

export function createApi(baseUrl = "http://127.0.0.1:8000"): AnalysisApi {
  return {
    inspect: (url) => request(`${baseUrl}/v1/videos/inspect`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
    createAnalysis: (input) => request(`${baseUrl}/v1/analyses`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
    getStatus: (jobId) => request(`${baseUrl}/v1/analyses/${jobId}`),
    getResult: (jobId) => request(`${baseUrl}/v1/analyses/${jobId}/result`),
  };
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch (error) {
    throw new ApiError("api_unavailable", "无法连接分析服务", 0, { cause: error });
  }
  const body = await response.json().catch(() => ({}));
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
