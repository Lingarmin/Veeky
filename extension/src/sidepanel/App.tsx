import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileVideo2,
  History,
  Languages,
  Link2,
  Play,
  RefreshCw,
  Search,
  Settings,
} from "lucide-react";

import type {
  ActiveTabContext,
  AnalysisHistoryItem,
  AnalysisResult,
  JobStatus,
  VideoInspection,
} from "../shared/types";
import type { AnalysisApi } from "./api";
import { createApi } from "./api";
import type { BrowserBridge } from "./browser";
import { browserBridge } from "./browser";
import { errorMessageForCode, formatTime } from "./store";
import { browserLlmConfigStore, defaultLlmConfig, isLlmConfigured, LLM_PROVIDER_OPTIONS } from "./llm";
import type { LlmConfig, LlmConfigStore } from "./llm";

type Phase = "loading" | "selecting" | "checking" | "ready" | "settings" | "history" | "processing" | "complete" | "error";
type Section = "overview" | "transcript";
type VideoChoice = "current" | "replacement";

interface AppProps {
  api?: AnalysisApi;
  browser?: BrowserBridge;
  llmStore?: LlmConfigStore;
  pollIntervalMs?: number;
}

const TARGET_LANGUAGES = [
  ["zh-Hans", "简体中文"],
  ["zh-Hant", "繁体中文"],
  ["en", "English"],
  ["ja", "日本語"],
];

const defaultApi = createApi();
const HISTORY_PAGE_SIZE = 20;

function comparisonKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}

function distinctText(value: string, visibleValues: string[]): string | null {
  const key = comparisonKey(value);
  if (!key || visibleValues.some((visible) => comparisonKey(visible) === key)) return null;
  return value;
}

export function App({
  api = defaultApi,
  browser = browserBridge,
  llmStore = browserLlmConfigStore,
  pollIntervalMs = 2000,
}: AppProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [context, setContext] = useState<ActiveTabContext | null>(null);
  const [inspection, setInspection] = useState<VideoInspection | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState("");
  const [targetLanguage, setTargetLanguage] = useState("zh-Hans");
  const [jobStatus, setJobStatus] = useState<JobStatus>("queued");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<VideoChoice>("current");
  const [replacementUrl, setReplacementUrl] = useState("");
  const [inspectionUrl, setInspectionUrl] = useState("");
  const [section, setSection] = useState<Section>("overview");
  const [query, setQuery] = useState("");
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(defaultLlmConfig("kimi"));
  const [settingsError, setSettingsError] = useState("");
  const [testingLlm, setTestingLlm] = useState(false);
  const [historyItems, setHistoryItems] = useState<AnalysisHistoryItem[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [resultFromHistory, setResultFromHistory] = useState(false);
  const [settingsReturnPhase, setSettingsReturnPhase] = useState<Phase>("selecting");
  const timerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const poll = useCallback(async (jobId: string, videoId?: string) => {
    try {
      const status = await api.getStatus(jobId);
      setJobStatus(status.status);
      if (status.status === "completed") {
        const analysis = await api.getResult(jobId);
        setResult(analysis);
        setResultFromHistory(false);
        setPhase("complete");
        return;
      }
      if (status.status === "translating") {
        // The worker stores the overview before starting the long subtitle
        // translation. Show that useful result immediately while polling for
        // the completed transcript in the background.
        try {
          const analysis = await api.getResult(jobId);
          setResult(analysis);
          setSection("overview");
          setPhase("complete");
        } catch (requestError) {
          if (errorCode(requestError) !== "analysis_not_complete") throw requestError;
        }
      }
      if (status.status === "failed") {
        if (status.failureCode === "translation_failed") {
          const analysis = await api.getResult(jobId);
          setResult(analysis);
          setSection("transcript");
          setPhase("complete");
          return;
        }
        setError(errorMessageForCode(status.failureCode));
        if (videoId) {
          const history = await api.getHistory({ videoId, limit: 1, offset: 0 });
          if (history.items[0]) {
            setResult(await api.getResult(history.items[0].jobId));
            setResultFromHistory(false);
            setPhase("complete");
            return;
          }
        }
        setPhase("error");
        return;
      }
      timerRef.current = window.setTimeout(() => void poll(jobId, videoId), pollIntervalMs);
    } catch (requestError) {
      setError(errorMessageForCode(errorCode(requestError)));
      setPhase("error");
    }
  }, [api, pollIntervalMs]);

  const prepareVideoChoice = useCallback(async () => {
    stopPolling();
    setPhase("loading");
    setError("");
    setInspection(null);
    setInspectionUrl("");
    try {
      const active = await browser.getActiveContext();
      setContext(active);
      if (!active.videoId) {
        setError("请先打开一个 YouTube 视频");
        setPhase("error");
        return;
      }
      setChoice("current");
      if (active.analysis?.videoId === active.videoId) {
        const status = await api.getStatus(active.analysis.jobId);
        if (status.status === "completed") {
          setResult(await api.getResult(active.analysis.jobId));
          setResultFromHistory(false);
          setPhase("complete");
          return;
        }
        if (status.status !== "failed") {
          setJobStatus(status.status);
          setPhase("processing");
          void poll(active.analysis.jobId, active.videoId);
          return;
        }
      }
      const history = await api.getHistory({ videoId: active.videoId, limit: 1, offset: 0 });
      if (history.items[0]) {
        setResult(await api.getResult(history.items[0].jobId));
        setResultFromHistory(false);
        setPhase("complete");
        return;
      }
      setPhase("selecting");
    } catch (requestError) {
      setError(errorMessageForCode(errorCode(requestError)));
      setPhase("error");
    }
  }, [api, browser, poll, stopPolling]);

  useEffect(() => {
    void Promise.all([
      prepareVideoChoice(),
      llmStore.load().then(setLlmConfig),
    ]);
    return stopPolling;
  }, [llmStore, prepareVideoChoice, stopPolling]);

  const checkCaptions = async () => {
    const url = choice === "current" ? context?.url ?? "" : replacementUrl.trim();
    if (!url) {
      setError("请输入要检查的 YouTube 视频链接");
      return;
    }
    stopPolling();
    setError("");
    setPhase("checking");
    try {
      const inspected = await api.inspect(url);
      setInspection(inspected);
      setInspectionUrl(url);
      setSourceLanguage(inspected.selectedLanguage);
      setPhase("ready");
    } catch (requestError) {
      setError(errorMessageForCode(errorCode(requestError)));
      setPhase("selecting");
    }
  };

  const viewExistingAnalysis = () => {
    const existing = context?.analysis;
    if (!context || !existing || existing.videoId !== context.videoId) return;
    stopPolling();
    setJobStatus("queued");
    setPhase("processing");
    void poll(existing.jobId, existing.videoId);
  };

  const openHistory = async (reset = true) => {
    stopPolling();
    setPhase("history");
    setHistoryLoading(true);
    setHistoryError("");
    const offset = reset ? 0 : historyItems.length;
    try {
      const page = await api.getHistory({ limit: HISTORY_PAGE_SIZE, offset });
      setHistoryItems((current) => reset ? page.items : [...current, ...page.items]);
      setHistoryHasMore(page.hasMore);
    } catch (requestError) {
      setHistoryError(errorMessageForCode(errorCode(requestError), "历史记录加载失败，请重试"));
    } finally {
      setHistoryLoading(false);
    }
  };

  const openHistoryResult = async (item: AnalysisHistoryItem) => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      setResult(await api.getResult(item.jobId));
      setResultFromHistory(true);
      setSection("overview");
      setQuery("");
      setPhase("complete");
    } catch (requestError) {
      setHistoryError(errorMessageForCode(errorCode(requestError), "这条历史记录暂时无法打开"));
    } finally {
      setHistoryLoading(false);
    }
  };

  const startAnalysis = async () => {
    if (!context || !inspection || !sourceLanguage) return;
    if (!isLlmConfigured(llmConfig)) {
      setSettingsError("请先配置 LLM 服务，才能生成翻译和视频概览。");
      setPhase("settings");
      return;
    }
    stopPolling();
    setPhase("processing");
    setJobStatus("queued");
    try {
      const videoId = inspection.videoId;
      const created = await api.createAnalysis({
        videoId,
        sourceLanguage,
        targetLanguage,
        title: videoId === context.videoId ? context.title : `YouTube video ${videoId}`,
        llmConfig,
      });
      if (videoId !== context.videoId) {
        await browser.seek(context.tabId, videoId, 0);
      }
      await browser.registerAnalysis(context.tabId, videoId, created.jobId);
      if (created.status === "completed") {
        setResult(await api.getResult(created.jobId));
        setPhase("complete");
      } else {
        void poll(created.jobId, videoId);
      }
    } catch (requestError) {
      setError(errorMessageForCode(errorCode(requestError)));
      setPhase("error");
    }
  };

  const reanalyze = async () => {
    if (!context || !result) return;
    if (!isLlmConfigured(llmConfig)) {
      setSettingsError("请先配置 LLM 服务，才能重新生成翻译和视频概览。");
      setSettingsReturnPhase("complete");
      setPhase("settings");
      return;
    }
    stopPolling();
    setPhase("processing");
    setJobStatus("queued");
    try {
      if (result.videoId !== context.videoId) {
        await browser.seek(context.tabId, result.videoId, 0);
      }
      const created = await api.createAnalysis({
        videoId: result.videoId,
        sourceLanguage: result.sourceLanguage,
        targetLanguage: result.targetLanguage,
        title: result.videoTitle,
        llmConfig,
        force: true,
      });
      await browser.registerAnalysis(context.tabId, result.videoId, created.jobId);
      setResultFromHistory(false);
      void poll(created.jobId, result.videoId);
    } catch (requestError) {
      setError(errorMessageForCode(errorCode(requestError)));
      setPhase("error");
    }
  };

  const openSettings = () => {
    setSettingsReturnPhase(phase === "settings" ? "selecting" : phase);
    setSettingsError("");
    setPhase("settings");
  };

  const seek = (startMs: number) => {
    const videoId = result?.videoId ?? context?.videoId;
    if (context && videoId) void browser.seek(context.tabId, videoId, startMs);
  };

  const transcript = useMemo(() => {
    const segments = result?.transcript ?? [];
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return segments;
    return segments.filter((item) =>
      `${item.original} ${item.translated ?? ""}`.toLocaleLowerCase().includes(normalized),
    );
  }, [query, result]);
  const existingJobId = context?.analysis && context.analysis.videoId === context.videoId
    ? context.analysis.jobId
    : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-actions header-actions-left">
          <button className="icon-button" type="button" onClick={openSettings} title="LLM 设置" aria-label="LLM 设置">
            <Settings size={17} strokeWidth={1.8} />
          </button>
          <button className="icon-button" type="button" onClick={() => void prepareVideoChoice()} title="选择视频" aria-label="选择视频">
            <RefreshCw size={17} strokeWidth={1.8} />
          </button>
        </div>
        <div className="header-actions header-actions-right">
          <button className="icon-button" type="button" onClick={() => void openHistory()} title="历史记录" aria-label="历史记录">
            <History size={17} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {phase === "loading" && <LoadingView />}
      {phase === "selecting" && (
        <SelectionView
          context={context}
          choice={choice}
          replacementUrl={replacementUrl}
          error={error}
          onChoiceChange={setChoice}
          onReplacementUrlChange={setReplacementUrl}
          onCheck={() => void checkCaptions()}
          existingJobId={existingJobId}
          onViewExisting={viewExistingAnalysis}
          llmConfigured={isLlmConfigured(llmConfig)}
          onSettings={openSettings}
        />
      )}
      {phase === "checking" && <CheckingView />}
      {phase === "ready" && inspection && (
        <ReadyView
          title={inspection.videoId === context?.videoId ? context?.title ?? "YouTube video" : `YouTube 视频 ${inspection.videoId}`}
          inspection={inspection}
          isCurrentVideo={inspection.videoId === context?.videoId}
          inspectionUrl={inspectionUrl}
          sourceLanguage={sourceLanguage}
          targetLanguage={targetLanguage}
          onSourceChange={setSourceLanguage}
          onTargetChange={setTargetLanguage}
          onBack={() => setPhase("selecting")}
          onStart={() => void startAnalysis()}
          llmConfigured={isLlmConfigured(llmConfig)}
          onSettings={openSettings}
        />
      )}
      {phase === "settings" && (
        <SettingsView
          config={llmConfig}
          error={settingsError}
          testing={testingLlm}
          onChange={setLlmConfig}
          onProviderChange={async (provider) => {
            setLlmConfig(await llmStore.load(provider));
            setSettingsError("");
          }}
          onSave={async () => { await llmStore.save(llmConfig); setSettingsError(""); setPhase(settingsReturnPhase); }}
          onTest={async () => {
            if (!isLlmConfigured(llmConfig)) { setSettingsError("请填写 API URL 和 API Key"); return; }
            setTestingLlm(true); setSettingsError("");
            try { await api.testLlm(llmConfig); await llmStore.save(llmConfig); setSettingsError("连接成功，可以开始分析"); }
            catch (requestError) {
              setSettingsError(errorMessageForCode(
                errorCode(requestError),
                "LLM 连接测试失败，请检查 Provider、API 地址、模型和 API Key",
              ));
            }
            finally { setTestingLlm(false); }
          }}
          onBack={() => setPhase(settingsReturnPhase)}
        />
      )}
      {phase === "history" && (
        <HistoryView
          items={historyItems}
          loading={historyLoading}
          error={historyError}
          hasMore={historyHasMore}
          onOpen={(item) => void openHistoryResult(item)}
          onLoadMore={() => void openHistory(false)}
          onRetry={() => void openHistory(historyItems.length === 0)}
          onBack={() => void prepareVideoChoice()}
        />
      )}
      {phase === "processing" && <ProcessingView status={jobStatus} />}
      {phase === "error" && <ErrorView message={error} onRetry={() => void prepareVideoChoice()} />}
      {phase === "complete" && result && (
        <ResultView
          result={result}
          section={section}
          query={query}
          transcript={transcript}
          onSectionChange={setSection}
          onQueryChange={setQuery}
          onSeek={seek}
          onRetry={() => void reanalyze()}
          onBack={resultFromHistory ? () => setPhase("history") : undefined}
        />
      )}
    </div>
  );
}

function SelectionView({
  context, choice, replacementUrl, error, onChoiceChange, onReplacementUrlChange, onCheck, existingJobId, onViewExisting, llmConfigured, onSettings,
}: {
  context: ActiveTabContext | null;
  choice: VideoChoice;
  replacementUrl: string;
  error: string;
  onChoiceChange(choice: VideoChoice): void;
  onReplacementUrlChange(url: string): void;
  onCheck(): void;
  existingJobId: string | null;
  onViewExisting(): void;
  llmConfigured: boolean;
  onSettings(): void;
}) {
  const usingCurrentVideo = choice === "current";
  return (
    <main className="selection-view">
      <p className="section-label">开始前</p>
      <h1>选择要分析的视频</h1>
      <div className="choice-switch" role="tablist" aria-label="视频来源">
        <button type="button" role="tab" aria-selected={usingCurrentVideo} className={usingCurrentVideo ? "active" : ""} onClick={() => onChoiceChange("current")}>当前视频</button>
        <button type="button" role="tab" aria-selected={!usingCurrentVideo} className={!usingCurrentVideo ? "active" : ""} onClick={() => onChoiceChange("replacement")}>输入其他 YouTube 链接</button>
      </div>
      {usingCurrentVideo ? (
        <div className="current-video">
          <FileVideo2 size={17} />
          <div><small>当前标签页</small><strong>{context?.title}</strong><code>{context?.url}</code></div>
        </div>
      ) : (
        <label className="link-field" htmlFor="replacement-url">
          <span><Link2 size={15} />YouTube 链接</span>
          <input id="replacement-url" value={replacementUrl} onChange={(event) => onReplacementUrlChange(event.target.value)} placeholder="粘贴 YouTube 视频链接" inputMode="url" />
        </label>
      )}
      {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{error}</p>}
      <button className="primary-button" type="button" onClick={onCheck}>{usingCurrentVideo ? "检查当前视频字幕" : "检查此链接字幕"}</button>
      {usingCurrentVideo && existingJobId && <button className="secondary-button" type="button" onClick={onViewExisting}>查看当前分析</button>}
      {!llmConfigured && <button className="setup-link" type="button" onClick={onSettings}><Settings size={14} />先配置 LLM，再生成翻译和概览</button>}
      <p className="privacy-note">先确认公开字幕是否可读，再决定是否开始分析。</p>
    </main>
  );
}

function ReadyView({
  title, inspection, isCurrentVideo, inspectionUrl, sourceLanguage, targetLanguage, onSourceChange, onTargetChange, onBack, onStart, llmConfigured, onSettings,
}: {
  title: string;
  inspection: VideoInspection;
  isCurrentVideo: boolean;
  inspectionUrl: string;
  sourceLanguage: string;
  targetLanguage: string;
  onSourceChange(value: string): void;
  onTargetChange(value: string): void;
  onBack(): void;
  onStart(): void;
  llmConfigured: boolean;
  onSettings(): void;
}) {
  const tracks = inspection.tracks.reduce<typeof inspection.tracks>((result, track) => {
    const existingIndex = result.findIndex((item) => item.languageCode === track.languageCode);
    if (existingIndex === -1) {
      result.push(track);
    } else if (result[existingIndex].isGenerated && !track.isGenerated) {
      result[existingIndex] = track;
    }
    return result;
  }, []);
  const selected = tracks.find((track) => track.languageCode === sourceLanguage);
  return (
    <main className="ready-view">
      <p className="section-label">{isCurrentVideo ? "当前视频字幕" : "已检测替换视频"}</p>
      <h1>{title}</h1>
      <p className="inspection-url">{inspectionUrl}</p>
      <div className="caption-status"><Check size={14} /><span>检测到可读取字幕</span></div>
      <div className="form-row">
        <label htmlFor="source-language">源字幕</label>
        <select id="source-language" value={sourceLanguage} onChange={(event) => onSourceChange(event.target.value)}>
          {tracks.map((track) => (
            <option key={`${track.languageCode}-${track.isGenerated}`} value={track.languageCode}>
              {track.languageName}{track.isGenerated ? "（自动生成）" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor="target-language">翻译为</label>
        <select id="target-language" value={targetLanguage} onChange={(event) => onTargetChange(event.target.value)}>
          {TARGET_LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </div>
      <div className="ready-meta">
        <Languages size={16} /><span>{selected?.isGenerated ? "YouTube 自动字幕" : "提供者字幕"}</span>
        <Clock3 size={16} /><span>{formatTime(inspection.durationMs)}</span>
      </div>
      <button className="primary-button" type="button" onClick={onStart}>{isCurrentVideo ? "分析此视频" : "分析并打开此视频"}</button>
      {!llmConfigured && <button className="setup-link" type="button" onClick={onSettings}><Settings size={14} />配置 LLM 后开始</button>}
      <button className="secondary-button" type="button" onClick={onBack}>更换视频</button>
      <p className="privacy-note">只处理公开提供的字幕。</p>
    </main>
  );
}

function SettingsView({
  config, error, testing, onChange, onProviderChange, onSave, onTest, onBack,
}: {
  config: LlmConfig;
  error: string;
  testing: boolean;
  onChange(config: LlmConfig): void;
  onProviderChange(provider: LlmConfig["provider"]): void;
  onSave(): void;
  onTest(): void;
  onBack(): void;
}) {
  return (
    <main className="settings-view">
      <p className="section-label">LLM 设置</p>
      <h1>配置 LLM</h1>
      <p className="settings-copy">翻译字幕和生成视频概览都需要你自己的 LLM API。</p>
      <label className="settings-field" htmlFor="llm-provider"><span>Provider</span><select id="llm-provider" value={config.provider} onChange={(event) => {
        const provider = event.target.value as LlmConfig["provider"];
        onProviderChange(provider);
      }}>{LLM_PROVIDER_OPTIONS.map((option) => <option key={option.provider} value={option.provider}>{option.label}</option>)}</select></label>
      <label className="settings-field" htmlFor="llm-api-url"><span>API URL</span><input id="llm-api-url" value={config.apiUrl} onChange={(event) => onChange({ ...config, apiUrl: event.target.value })} placeholder="https://api.moonshot.cn/v1" inputMode="url" /></label>
      <label className="settings-field" htmlFor="llm-model"><span>模型</span><input id="llm-model" value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })} placeholder="kimi-k2.5" /></label>
      <label className="settings-field" htmlFor="llm-api-key"><span>API Key</span><input id="llm-api-key" type="password" value={config.apiKey} onChange={(event) => onChange({ ...config, apiKey: event.target.value })} placeholder="sk-..." /></label>
      {error && <p className={`settings-message ${error.includes("成功") ? "success" : ""}`} role="status">{error}</p>}
      <button className="primary-button" type="button" onClick={onTest} disabled={testing}>{testing ? "测试中..." : "测试连通"}</button>
      <button className="secondary-button" type="button" onClick={onSave}>保存配置</button>
      <button className="secondary-button" type="button" onClick={onBack}>返回</button>
      <p className="privacy-note">API Key 会发送到本地 API，用于后台翻译和概览任务。</p>
    </main>
  );
}

function ProcessingView({ status }: { status: JobStatus }) {
  const stages: Array<[JobStatus, string]> = [
    ["fetching_transcript", "读取字幕"],
    ["analyzing", "整理章节与重点"],
    ["translating", "翻译字幕"],
  ];
  const activeIndex = status === "queued" ? 0 : stages.findIndex(([key]) => key === status);
  return (
    <main className="processing-view">
      <div className="processing-mark"><span></span><span></span><span></span></div>
      <p className="section-label">后台处理中</p>
      <h1>正在读这条视频</h1>
      <p>切换网页不会中断任务。回到这个 YouTube 标签页后，结果仍会保留。</p>
      <div className="stage-list">
        {stages.map(([key, label], index) => (
          <div className={`stage ${index < activeIndex ? "done" : ""} ${index === activeIndex ? "active" : ""}`} key={key}>
            <i>{index < activeIndex ? <Check size={11} /> : index + 1}</i>
            <span>{label}</span>
            <small>{index < activeIndex ? "完成" : index === activeIndex ? "进行中" : "等待"}</small>
          </div>
        ))}
      </div>
    </main>
  );
}

function HistoryView({ items, loading, error, hasMore, onOpen, onLoadMore, onRetry, onBack }: {
  items: AnalysisHistoryItem[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  onOpen(item: AnalysisHistoryItem): void;
  onLoadMore(): void;
  onRetry(): void;
  onBack(): void;
}) {
  return (
    <main className="history-view">
      <div className="view-heading">
        <button className="icon-button" type="button" onClick={onBack} aria-label="返回当前视频"><ChevronLeft size={18} /></button>
        <div><p className="section-label">已完成</p><h1>历史记录</h1></div>
      </div>
      {items.length === 0 && !loading && !error && <p className="empty-state">还没有分析记录</p>}
      <div className="history-list">
        {items.map((item) => (
          <button className="history-row" type="button" key={item.jobId} onClick={() => onOpen(item)} aria-label={`打开 ${item.videoTitle}`}>
            <span><strong>{item.videoTitle}</strong><small>视频时长 {formatTime(item.durationMs)} · {formatCompletedAt(item.completedAt)}</small></span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      {error && <div className="history-error" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>重试</button></div>}
      {loading && <p className="history-loading" role="status">正在加载历史记录...</p>}
      {hasMore && !loading && <button className="secondary-button history-more" type="button" onClick={onLoadMore}>加载更多</button>}
    </main>
  );
}

function ResultView({ result, section, query, transcript, onSectionChange, onQueryChange, onSeek, onRetry, onBack }: {
  result: AnalysisResult;
  section: Section;
  query: string;
  transcript: NonNullable<AnalysisResult["transcript"]>;
  onSectionChange(section: Section): void;
  onQueryChange(query: string): void;
  onSeek(startMs: number): void;
  onRetry(): void;
  onBack?(): void;
}) {
  return (
    <main className="result-view">
      {onBack && <button className="result-back" type="button" onClick={onBack}><ChevronLeft size={15} />返回历史记录</button>}
      <div className="result-source"><span><i></i>{result.partial ? (result.failureCode ? "仅原文可用" : "概览已生成") : "分析完成"}</span><span>{result.sourceLanguage}</span><span>译为 {result.targetLanguage}</span></div>
      {result.partial && <p className="partial-banner">
        {result.failureCode === "translation_failed"
          ? "原始字幕可用，翻译暂时失败。"
          : "概览已生成，逐字稿仍在翻译。"}
      </p>}
      <div className="result-video">
        <strong>{result.videoTitle}</strong>
        <small>
          {formatTime(result.durationMs)}
          {result.isGenerated !== null && ` · ${result.isGenerated ? "YouTube 自动字幕" : "提供者字幕"}`}
        </small>
      </div>
      <button className="secondary-button retry-analysis" type="button" onClick={onRetry}>重新分析</button>
      <div className="result-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={section === "overview"} className={section === "overview" ? "active" : ""} onClick={() => onSectionChange("overview")}>概览</button>
        <button type="button" role="tab" aria-selected={section === "transcript"} className={section === "transcript" ? "active" : ""} onClick={() => onSectionChange("transcript")}>逐字稿</button>
      </div>
      {section === "overview" ? (
        <div className="overview-content">
          <p className="section-label">视频在讲什么</p>
          <h1>{result.oneLineSummary}</h1>
          <ul className="summary-points">{result.summaryPoints.map((point) => <li key={point}>{point}</li>)}</ul>
          <div className="section-heading"><h2>章节与重点</h2><span>点击时间跳转</span></div>
          <div className="chapter-list">
            {result.chapters.map((chapter) => {
              const summary = distinctText(chapter.summary, [chapter.title]);
              return (
                <button className="chapter-row" type="button" key={`${chapter.start_ms}-${chapter.title}`} onClick={() => onSeek(chapter.start_ms)}>
                  <span className="time">{formatTime(chapter.start_ms)}</span>
                  <span><strong>{chapter.title}</strong>{summary && <small>{summary}</small>}</span>
                  <Play size={14} fill="currentColor" />
                </button>
              );
            })}
          </div>
          {result.highlights.length > 0 && <div className="section-heading"><h2>值得看的片段</h2></div>}
          <div className="highlight-list">
            {result.highlights.map((item) => {
              const summary = distinctText(item.summary, [item.title]);
              const translatedExcerpt = distinctText(
                item.translated_excerpt,
                [item.title, ...(summary ? [summary] : [])],
              );
              const originalExcerpt = distinctText(
                item.original_excerpt,
                [item.title, ...(summary ? [summary] : []), ...(translatedExcerpt ? [translatedExcerpt] : [])],
              );
              return (
                <button className="highlight-row" type="button" key={`${item.start_ms}-${item.title}`} onClick={() => onSeek(item.start_ms)}>
                  <span className="time">{formatTime(item.start_ms)} - {formatTime(item.end_ms)}</span>
                  <strong>{item.title}</strong>
                  {summary && <p>{summary}</p>}
                  {translatedExcerpt && <blockquote>{translatedExcerpt}</blockquote>}
                  {originalExcerpt && <small className="original-excerpt">{originalExcerpt}</small>}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="transcript-content">
          <label className="search-box"><Search size={15} /><input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索原文或译文" /></label>
          {transcript.length > 0 ? transcript.map((segment) => (
            <article className="transcript-row" key={segment.id}>
              <button type="button" onClick={() => onSeek(segment.startMs)}>{formatTime(segment.startMs)}</button>
              <div><p>{segment.translated ?? "译文暂不可用"}</p><small>{segment.original}</small></div>
            </article>
          )) : <p className="empty-state">没有找到匹配的字幕</p>}
        </div>
      )}
    </main>
  );
}

function LoadingView() {
  return <main className="loading-view" aria-label="正在检查视频"><div></div><div></div><div></div><div></div></main>;
}

function CheckingView() {
  return <main className="checking-view" aria-live="polite"><RefreshCw size={25} /><p>正在检查公开字幕</p></main>;
}

function ErrorView({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <main className="error-view">
      <AlertCircle size={30} strokeWidth={1.5} />
      <h1>{message}</h1>
      <p>检查当前视频后重试，已有后台任务不会受到影响。</p>
      <button type="button" onClick={onRetry}>重新检查</button>
    </main>
  );
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

function formatCompletedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}
