import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Clock3,
  Languages,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";

import type {
  ActiveTabContext,
  AnalysisResult,
  JobStatus,
  VideoInspection,
} from "../shared/types";
import type { AnalysisApi } from "./api";
import { createApi } from "./api";
import type { BrowserBridge } from "./browser";
import { browserBridge } from "./browser";
import { errorMessageForCode, formatTime } from "./store";

type Phase = "loading" | "ready" | "processing" | "complete" | "error";
type Section = "overview" | "transcript";

interface AppProps {
  api?: AnalysisApi;
  browser?: BrowserBridge;
  pollIntervalMs?: number;
}

const TARGET_LANGUAGES = [
  ["zh-Hans", "简体中文"],
  ["zh-Hant", "繁体中文"],
  ["en", "English"],
  ["ja", "日本語"],
];

export function App({
  api = createApi(),
  browser = browserBridge,
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
  const [section, setSection] = useState<Section>("overview");
  const [query, setQuery] = useState("");
  const timerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const poll = useCallback(async (jobId: string) => {
    try {
      const status = await api.getStatus(jobId);
      setJobStatus(status.status);
      if (status.status === "completed") {
        const analysis = await api.getResult(jobId);
        setResult(analysis);
        setPhase("complete");
        return;
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
        setPhase("error");
        return;
      }
      timerRef.current = window.setTimeout(() => void poll(jobId), pollIntervalMs);
    } catch (requestError) {
      setError(errorMessageForCode(errorCode(requestError)));
      setPhase("error");
    }
  }, [api, pollIntervalMs]);

  const inspectCurrentVideo = useCallback(async () => {
    stopPolling();
    setPhase("loading");
    setError("");
    try {
      const active = await browser.getActiveContext();
      setContext(active);
      if (!active.videoId) {
        setError("请先打开一个 YouTube 视频");
        setPhase("error");
        return;
      }
      if (
        active.analysis?.jobId
        && active.analysis.videoId === active.videoId
      ) {
        setPhase("processing");
        void poll(active.analysis.jobId);
        return;
      }
      const inspected = await api.inspect(active.url);
      setInspection(inspected);
      setSourceLanguage(inspected.selectedLanguage);
      setPhase("ready");
    } catch (requestError) {
      setError(errorMessageForCode(errorCode(requestError)));
      setPhase("error");
    }
  }, [api, browser, poll, stopPolling]);

  useEffect(() => {
    void inspectCurrentVideo();
    return stopPolling;
  }, [inspectCurrentVideo, stopPolling]);

  const startAnalysis = async () => {
    if (!context?.videoId || !sourceLanguage) return;
    stopPolling();
    setPhase("processing");
    setJobStatus("queued");
    try {
      const created = await api.createAnalysis({
        videoId: context.videoId,
        sourceLanguage,
        targetLanguage,
        title: context.title,
      });
      await browser.registerAnalysis(context.tabId, context.videoId, created.jobId);
      if (created.status === "completed") {
        setResult(await api.getResult(created.jobId));
        setPhase("complete");
      } else {
        void poll(created.jobId);
      }
    } catch (requestError) {
      setError(errorMessageForCode(errorCode(requestError)));
      setPhase("error");
    }
  };

  const seek = (startMs: number) => {
    if (context?.videoId) void browser.seek(context.tabId, context.videoId, startMs);
  };

  const transcript = useMemo(() => {
    const segments = result?.transcript ?? [];
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return segments;
    return segments.filter((item) =>
      `${item.original} ${item.translated ?? ""}`.toLocaleLowerCase().includes(normalized),
    );
  }, [query, result]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><span>先</span><div><strong>先看</strong><small>视频预览</small></div></div>
        <button className="icon-button" type="button" onClick={() => void inspectCurrentVideo()} title="重新检查" aria-label="重新检查">
          <RefreshCw size={17} strokeWidth={1.8} />
        </button>
      </header>

      {phase === "loading" && <LoadingView />}
      {phase === "ready" && inspection && (
        <ReadyView
          title={context?.title ?? "YouTube video"}
          inspection={inspection}
          sourceLanguage={sourceLanguage}
          targetLanguage={targetLanguage}
          onSourceChange={setSourceLanguage}
          onTargetChange={setTargetLanguage}
          onStart={() => void startAnalysis()}
        />
      )}
      {phase === "processing" && <ProcessingView status={jobStatus} />}
      {phase === "error" && <ErrorView message={error} onRetry={() => void inspectCurrentVideo()} />}
      {phase === "complete" && result && (
        <ResultView
          result={result}
          section={section}
          query={query}
          transcript={transcript}
          onSectionChange={setSection}
          onQueryChange={setQuery}
          onSeek={seek}
        />
      )}
    </div>
  );
}

function ReadyView({
  title, inspection, sourceLanguage, targetLanguage, onSourceChange, onTargetChange, onStart,
}: {
  title: string;
  inspection: VideoInspection;
  sourceLanguage: string;
  targetLanguage: string;
  onSourceChange(value: string): void;
  onTargetChange(value: string): void;
  onStart(): void;
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
      <p className="section-label">当前视频</p>
      <h1>{title}</h1>
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
      <button className="primary-button" type="button" onClick={onStart}>分析此视频</button>
      <p className="privacy-note">只处理当前视频公开提供的字幕。</p>
    </main>
  );
}

function ProcessingView({ status }: { status: JobStatus }) {
  const stages: Array<[JobStatus, string]> = [
    ["fetching_transcript", "读取字幕"],
    ["translating", "翻译字幕"],
    ["analyzing", "整理章节与重点"],
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

function ResultView({ result, section, query, transcript, onSectionChange, onQueryChange, onSeek }: {
  result: AnalysisResult;
  section: Section;
  query: string;
  transcript: NonNullable<AnalysisResult["transcript"]>;
  onSectionChange(section: Section): void;
  onQueryChange(query: string): void;
  onSeek(startMs: number): void;
}) {
  return (
    <main className="result-view">
      <div className="result-source"><span><i></i>{result.partial ? "仅原文可用" : "分析完成"}</span><span>{result.sourceLanguage}</span><span>译为 {result.targetLanguage}</span></div>
      {result.partial && <p className="partial-banner">原始字幕可用，翻译和摘要尚未完成。</p>}
      <div className="result-video">
        <strong>{result.videoTitle}</strong>
        <small>
          {formatTime(result.durationMs)}
          {result.isGenerated !== null && ` · ${result.isGenerated ? "YouTube 自动字幕" : "提供者字幕"}`}
        </small>
      </div>
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
            {result.chapters.map((chapter) => (
              <button className="chapter-row" type="button" key={`${chapter.start_ms}-${chapter.title}`} onClick={() => onSeek(chapter.start_ms)}>
                <span className="time">{formatTime(chapter.start_ms)}</span>
                <span><strong>{chapter.title}</strong><small>{chapter.summary}</small></span>
                <Play size={14} fill="currentColor" />
              </button>
            ))}
          </div>
          {result.highlights.length > 0 && <div className="section-heading"><h2>值得看的片段</h2></div>}
          <div className="highlight-list">
            {result.highlights.map((item) => (
              <button className="highlight-row" type="button" key={`${item.start_ms}-${item.title}`} onClick={() => onSeek(item.start_ms)}>
                <span className="time">{formatTime(item.start_ms)} - {formatTime(item.end_ms)}</span>
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
                {item.translated_excerpt && <blockquote>{item.translated_excerpt}</blockquote>}
                {item.original_excerpt && <small className="original-excerpt">{item.original_excerpt}</small>}
              </button>
            ))}
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
