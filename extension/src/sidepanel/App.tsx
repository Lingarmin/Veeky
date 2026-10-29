import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileVideo2,
  History,
  Import,
  Languages,
  Link2,
  Play,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";

import type {
  ActiveTabContext,
  AnalysisHistoryItem,
  AnalysisResult,
  ContentRef,
  JobStatus,
  MediaCandidate,
  VideoInspection,
} from "../shared/types";
import type { AnalysisApi } from "./api";
import { SettingsHelp } from "./SettingsHelp";
import { createLocalApi, type LocalApi } from "../local/runtime";
import type { LocalAnalysisStatus } from "../local/analysis";
import type { LocalAnalysisTask } from "../local/repository";
import type { LocalStorageMetadata } from "../local/storage";
import { importLegacyHistory, type LegacyImportCounts } from "../local/legacy-import";
import { contentKey } from "../shared/content";
import type { BrowserBridge } from "./browser";
import { browserBridge } from "./browser";
import { errorMessageForCode, formatTime } from "./store";
import { browserLlmConfigStore, defaultLlmConfig, HUNYUAN_MIGRATION_NOTICE, isLlmConfigured, LLM_PROVIDER_OPTIONS } from "./llm";
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

interface RetryAnalysisInput {
  contentRef: ContentRef;
  sourceLanguage: string;
  targetLanguage: string;
  title: string;
}

const TARGET_LANGUAGES = [
  ["zh-Hans", "简体中文"],
  ["zh-Hant", "繁体中文"],
  ["en", "English"],
  ["ja", "日本語"],
];

const defaultApi = createLocalApi();
const HISTORY_PAGE_SIZE = 20;
const EXPERIMENTAL_ASR_KEY = "veeky.experimentalLocalAsr.v1";
const LEGACY_IMPORT_COMPLETED_KEY = "veeky.legacyHistoryImportCompleted.v1";

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
  const [phase, setPhaseState] = useState<Phase>("loading");
  const [context, setContext] = useState<ActiveTabContext | null>(null);
  const [inspection, setInspection] = useState<VideoInspection | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState("");
  const [targetLanguage, setTargetLanguage] = useState("zh-Hans");
  const [jobStatus, setJobStatus] = useState<JobStatus>("queued");
  const [localProgress, setLocalProgress] = useState<Partial<LocalAnalysisStatus> | null>(null);
  const [recoverable, setRecoverable] = useState<LocalAnalysisTask[]>([]);
  const [pendingDiscardId, setPendingDiscardId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [experimentalAsr, setExperimentalAsr] = useState(false);
  const [importConsent, setImportConsent] = useState(false);
  const [importCompleted, setImportCompleted] = useState(false);
  const [importPreferenceLoaded, setImportPreferenceLoaded] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<{ message: string } | null>(null);
  const importController = useRef<AbortController | null>(null);
  const localApi = api as Partial<LocalApi>;
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
  const [savingLlm, setSavingLlm] = useState(false);
  const [loadingLlm, setLoadingLlm] = useState(true);
  const [llmLoadError, setLlmLoadError] = useState("");
  const llmGenerationRef = useRef(0);
  const llmActionGenerationRef = useRef(0);
  const [historyItems, setHistoryItems] = useState<AnalysisHistoryItem[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [storageMetadata, setStorageMetadata] = useState<LocalStorageMetadata | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [resultFromHistory, setResultFromHistory] = useState(false);
  const [settingsReturnPhase, setSettingsReturnPhase] = useState<Phase>("selecting");
  const [failedAnalysis, setFailedAnalysis] = useState<RetryAnalysisInput | null>(null);
  const [errorCodeValue, setErrorCodeValue] = useState<string | null>(null);
  const [mediaCandidates, setMediaCandidates] = useState<MediaCandidate[]>([]);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [processingPlatform, setProcessingPlatform] = useState<ContentRef["platform"]>("youtube");
  const timerRef = useRef<number | null>(null);
  const pollGenerationRef = useRef(0);
  const analysisOperationGenerationRef = useRef(0);
  const pendingAnalysisOperationRef = useRef<number | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const activeTabIdRef = useRef<number | null>(null);
  const activeContentRef = useRef<ContentRef | null>(null);
  const uploadStartedJobsRef = useRef(new Set<string>());
  const phaseRef = useRef<Phase>("loading");
  const completedResultRef = useRef<AnalysisResult | null>(null);

  const setPhase = useCallback((nextPhase: Phase) => {
    if (phaseRef.current === "settings" && nextPhase !== "settings") {
      llmActionGenerationRef.current += 1;
      setTestingLlm(false);
      setSavingLlm(false);
    }
    phaseRef.current = nextPhase;
    setPhaseState(nextPhase);
  }, []);

  const stopPolling = useCallback(() => {
    pollGenerationRef.current += 1;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    activeJobRef.current = null;
  }, []);

  const isCurrentGeneration = useCallback((generation: number) => (
    pollGenerationRef.current === generation
  ), []);

  const isCurrentPoll = useCallback((jobId: string, generation: number) => (
    activeJobRef.current === jobId && pollGenerationRef.current === generation
  ), []);

  const cancelAnalysisOperation = useCallback(() => {
    analysisOperationGenerationRef.current += 1;
    pendingAnalysisOperationRef.current = null;
  }, []);

  const beginAnalysisOperation = useCallback(() => {
    cancelAnalysisOperation();
    stopPolling();
    const generation = analysisOperationGenerationRef.current;
    pendingAnalysisOperationRef.current = generation;
    return generation;
  }, [cancelAnalysisOperation, stopPolling]);

  const isCurrentAnalysisOperation = useCallback((generation: number) => (
    analysisOperationGenerationRef.current === generation
  ), []);

  const finishAnalysisOperation = useCallback((generation: number) => {
    if (pendingAnalysisOperationRef.current === generation) {
      pendingAnalysisOperationRef.current = null;
    }
  }, []);

  const showResult = useCallback((analysis: AnalysisResult, fromHistory = false) => {
    completedResultRef.current = analysis;
    setResult(analysis);
    setResultFromHistory(fromHistory);
    if (phaseRef.current === "settings") {
      setSettingsReturnPhase("complete");
    } else {
      setPhase("complete");
    }
    activeJobRef.current = null;
    if (
      analysis.contentRef.platform === "x"
      && activeTabIdRef.current !== null
      && activeContentRef.current
      && sameContentRef(activeContentRef.current, analysis.contentRef)
    ) {
      const translated = analysis.transcript.filter((segment) => Boolean(segment.translated));
      void browser.showSubtitles(activeTabIdRef.current, analysis.contentRef, translated)
        .catch(() => undefined);
    }
  }, [browser, setPhase]);

  const poll = useCallback(async (
    jobId: string,
    contentRef: ContentRef,
    tabId: number,
    canUploadFromCurrentTab: boolean,
    generation: number,
  ) => {
    if (!isCurrentPoll(jobId, generation)) return;
    try {
      const status = await api.getStatus(jobId);
      if (!isCurrentPoll(jobId, generation)) return;
      setJobStatus(status.status);
      if ("stage" in status) setLocalProgress(status as LocalAnalysisStatus);
      if (status.status === "completed") {
        const analysis = await api.getResult(jobId);
        if (!isCurrentPoll(jobId, generation)) return;
        showResult(analysis);
        return;
      }
      if (status.status === "waiting_for_media" && contentRef.platform === "x") {
        if (!canUploadFromCurrentTab) {
          throw Object.assign(new Error("Historical X video is not open"), { code: "x_video_context_required" });
        }
        if (!uploadStartedJobsRef.current.has(jobId)) {
          const candidates = await browser.getMediaCandidates(tabId, contentRef);
          if (!isCurrentPoll(jobId, generation)) return;
          if (!candidates.length) {
            throw Object.assign(new Error("No current X media candidate"), { code: "x_media_not_detected" });
          }
          const started = await browser.startMediaUpload({ tabId, jobId, contentRef, candidates });
          if (!isCurrentPoll(jobId, generation)) return;
          if (started) uploadStartedJobsRef.current.add(jobId);
        }
      }
      if (status.status === "translating") {
        // The worker stores the overview before starting the long subtitle
        // translation. Show that useful result immediately while polling for
        // the completed transcript in the background.
        try {
          const analysis = await api.getResult(jobId);
          if (!isCurrentPoll(jobId, generation)) return;
          setResult(analysis);
          if ("stage" in status) {
            // Local pipeline translates first; do not display an empty overview.
          } else {
          setSection("overview");
          setPhase("complete");
          }
        } catch (requestError) {
          if (errorCode(requestError) !== "analysis_not_complete") throw requestError;
        }
      }
      if (status.status === "failed") {
        if ("stage" in status) {
          const partial = await api.getResult(jobId);
          if (!isCurrentPoll(jobId, generation)) return;
          setError(errorMessageForCode(status.failureCode));
          setErrorCodeValue(status.failureCode);
          if (partial.transcript.length) {
            setResult(partial); setSection("transcript"); setPhase("complete");
          } else setPhase("error");
          return;
        }
        if (status.failureCode === "translation_failed") {
          const analysis = await api.getResult(jobId);
          if (!isCurrentPoll(jobId, generation)) return;
          setResult(analysis);
          setSection("transcript");
          setPhase("complete");
          return;
        }
        setError(errorMessageForCode(status.failureCode));
        setErrorCodeValue(status.failureCode);
        if (contentRef.platform === "youtube") {
          const history = await api.getHistory({ videoId: contentRef.sourceContentId, limit: 1, offset: 0 });
          if (!isCurrentPoll(jobId, generation)) return;
          if (history.items[0]) {
            const analysis = await api.getResult(history.items[0].jobId);
            if (!isCurrentPoll(jobId, generation)) return;
            showResult(analysis);
            return;
          }
        }
        setPhase("error");
        return;
      }
      if (!isCurrentPoll(jobId, generation)) return;
      timerRef.current = window.setTimeout(
        () => void poll(jobId, contentRef, tabId, canUploadFromCurrentTab, generation),
        pollIntervalMs,
      );
    } catch (requestError) {
      if (!isCurrentPoll(jobId, generation)) return;
      uploadStartedJobsRef.current.delete(jobId);
      const code = errorCode(requestError);
      setError(errorMessageForCode(code));
      setErrorCodeValue(code);
      setPhase("error");
    }
  }, [api, browser, isCurrentPoll, pollIntervalMs, showResult]);

  const prepareVideoChoice = useCallback(async ({ restoreAnalysis = true }: { restoreAnalysis?: boolean } = {}) => {
    cancelAnalysisOperation();
    stopPolling();
    const generation = pollGenerationRef.current;
    setPhase("loading");
    setError("");
    setErrorCodeValue(null);
    setFailedAnalysis(null);
    setInspection(null);
    setInspectionUrl("");
    setMediaCandidates([]);
    setUploadPercent(null);
    activeJobRef.current = null;
    try {
      const active = await browser.getActiveContext();
      if (!isCurrentGeneration(generation)) return;
      activeTabIdRef.current = active.tabId;
      const activeRef = active.contentRef ?? (active.videoId
        ? { platform: "youtube" as const, sourceContentId: active.videoId, mediaIndex: 1 }
        : null);
      const normalized = { ...active, contentRef: activeRef };
      activeContentRef.current = activeRef;
      setContext(normalized);
      if (!activeRef) {
        const code = isBareXStatusUrl(active.url) ? "x_video_play_required" : null;
        setError(code ? errorMessageForCode(code) : "请先打开一个 YouTube 或 X 视频");
        setErrorCodeValue(code);
        setPhase("error");
        return;
      }
      setChoice("current");
      // Explicit navigation starts a new choice flow. Only initial loading and
      // recovery should automatically reopen work saved for the active video.
      if (!restoreAnalysis) {
        setPhase("selecting");
        return;
      }
      if (active.analysis && analysisMatches(active.analysis, activeRef)) {
        const status = await api.getStatus(active.analysis.jobId).catch((failure) => {
          if (localApi.resume && errorCode(failure) === "analysis_not_found") return { status: "failed" as const };
          throw failure;
        });
        if (!isCurrentGeneration(generation)) return;
        if (status.status === "completed") {
          const analysis = await api.getResult(active.analysis.jobId);
          if (!isCurrentGeneration(generation)) return;
          showResult(analysis, true);
          return;
        }
        if (status.status !== "failed") {
          setJobStatus(status.status);
          setProcessingPlatform(activeRef.platform);
          setPhase("processing");
          activeJobRef.current = active.analysis.jobId;
          void poll(active.analysis.jobId, activeRef, active.tabId, true, generation);
          return;
        }
      }
      if (activeRef.platform === "youtube") {
        const history = await api.getHistory({ videoId: activeRef.sourceContentId, limit: 1, offset: 0 });
        if (!isCurrentGeneration(generation)) return;
        if (history.items[0]) {
          const analysis = await api.getResult(history.items[0].jobId);
          if (!isCurrentGeneration(generation)) return;
          showResult(analysis, true);
          return;
        }
      } else {
        if (localApi.resume) {
          const history = await api.getHistory({ contentId: contentKey(activeRef), limit: 1 });
          if (!isCurrentGeneration(generation)) return;
          if (history.items[0]) {
            const analysis = await api.getResult(history.items[0].jobId);
            if (!isCurrentGeneration(generation)) return;
            showResult(analysis, true);
            return;
          }
          setPhase("selecting"); return;
        }
        const candidates = await browser.getMediaCandidates(active.tabId, activeRef);
        if (!isCurrentGeneration(generation)) return;
        const inspected = await api.inspect({
          url: active.url,
          activeMediaIndex: activeRef.mediaIndex,
          ...(active.durationMs != null ? { clientDurationMs: active.durationMs } : {}),
          mediaCandidates: candidates,
        });
        if (!isCurrentGeneration(generation)) return;
        const history = await api.getHistory({ contentId: inspected.contentId, limit: 1, offset: 0 });
        if (!isCurrentGeneration(generation)) return;
        if (history.items[0]) {
          const analysis = await api.getResult(history.items[0].jobId);
          if (!isCurrentGeneration(generation)) return;
          showResult(analysis, true);
          return;
        }
      }
      setPhase("selecting");
    } catch (requestError) {
      if (!isCurrentGeneration(generation)) return;
      const code = errorCode(requestError);
      setError(errorMessageForCode(code));
      setErrorCodeValue(code);
      setPhase("error");
    }
  }, [api, browser, cancelAnalysisOperation, isCurrentGeneration, poll, showResult, stopPolling]);

  useEffect(() => {
    let disposed = false;
    if (localApi.getRecoverableTasks) void localApi.getRecoverableTasks().then((tasks) => {
      if (!disposed) setRecoverable(tasks);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [api, phase]);

  const resumeLocalTask = async (task: LocalAnalysisTask) => {
    if (!localApi.resume || !context) return;
    const operation = beginAnalysisOperation();
    setError(""); setLocalProgress(null);
    try {
      const created = await localApi.resume(task.jobId);
      // Registration is only a tab shortcut: failure must not hide a task that
      // the local engine has already resumed successfully.
      if (context.contentRef && sameContentRef(context.contentRef, task.contentRef)) {
        await browser.registerAnalysis(context.tabId, task.contentRef, created.jobId).catch(() => undefined);
      }
      if (!isCurrentAnalysisOperation(operation)) return;
      activeJobRef.current = created.jobId;
      setProcessingPlatform(task.contentRef.platform); setJobStatus(created.status); setPhase("processing");
      setRecoverable((items) => items.filter((item) => item.jobId !== task.jobId));
      void poll(task.jobId, task.contentRef, context.tabId, false, pollGenerationRef.current);
    } catch (failure) {
      if (isCurrentAnalysisOperation(operation)) {
        setError(errorMessageForCode(errorCode(failure))); setPhase("error");
      }
    } finally { finishAnalysisOperation(operation); }
  };

  const cancelLocalTask = async () => {
    if (!localApi.cancel || !activeJobRef.current) return;
    try { await localApi.cancel(activeJobRef.current); }
    catch (failure) { setError(errorMessageForCode(errorCode(failure))); }
  };

  const discardLocalTask = async (jobId: string) => {
    if (!localApi.discardRecoverableTask || discarding) return;
    setDiscarding(true);
    try {
      await localApi.discardRecoverableTask(jobId);
      setRecoverable((tasks) => tasks.filter((task) => task.jobId !== jobId));
      setPendingDiscardId(null);
      if (localApi.getStorageMetadata) setStorageMetadata(await localApi.getStorageMetadata());
    } catch (failure) {
      setError(errorMessageForCode(errorCode(failure), "无法删除此任务，请重试"));
      setPhase("error");
    } finally { setDiscarding(false); }
  };

  useEffect(() => {
    let disposed = false;
    if (localApi.resume) void chrome.storage.local.get([EXPERIMENTAL_ASR_KEY, LEGACY_IMPORT_COMPLETED_KEY])
      .then((stored) => {
        if (disposed) return;
        setExperimentalAsr(stored[EXPERIMENTAL_ASR_KEY] === true);
        if (stored[LEGACY_IMPORT_COMPLETED_KEY] === true) setImportCompleted(true);
      }).catch(() => {}).finally(() => {
        if (!disposed) setImportPreferenceLoaded(true);
      });
    return () => { disposed = true; importController.current?.abort(); };
  }, []);

  const changeExperimentalAsr = async (enabled: boolean) => {
    try {
      await chrome.storage.local.set({ [EXPERIMENTAL_ASR_KEY]: enabled });
      setExperimentalAsr(enabled);
    } catch { setSettingsError("无法保存实验功能设置，请重新打开插件重试。"); }
  };

  const importHistory = async () => {
    if ((!importConsent && !importCompleted) || !importPreferenceLoaded || importing) return;
    setImporting(true); setImportNotice({ message: "正在导入旧历史记录…" });
    const controller = new AbortController(); importController.current = controller;
    const format = (counts: LegacyImportCounts) => `已导入 ${counts.imported} 条，已存在 ${counts.skipped} 条，不兼容 ${counts.rejected} 条。`;
    const origins = ["http://127.0.0.1:8000/*"];
    let granted = false;
    try {
      // Request from the user's click; normal operation never requests loopback access.
      granted = await chrome.permissions.request({ origins });
      if (!granted) { setImportNotice({ message: "未授权访问旧本地服务，未导入记录。" }); return; }
      const counts = await importLegacyHistory({ confirmed: true, apiOrigin: "http://127.0.0.1:8000", signal: controller.signal,
        onProgress: (value) => setImportNotice({ message: format(value) }) });
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      setImportCompleted(true);
      let preferenceNotice = "";
      try { await chrome.storage.local.set({ [LEGACY_IMPORT_COMPLETED_KEY]: true }); }
      catch { preferenceNotice = "导入状态未保存，下次打开可能需要再次确认。"; }
      setImportNotice({ message: `导入完成。${format(counts)}旧记录保持不变。${preferenceNotice}` });
      if (phaseRef.current === "history") void openHistory(true);
    } catch (failure) {
      setImportNotice({ message: controller.signal.aborted ? "导入已停止，已导入的记录保留。" : errorMessageForCode(errorCode(failure), "导入未完成。请确认旧本地服务已启动，且此插件保留原安装身份。已导入记录保留，可再次导入。") });
    } finally {
      if (granted) await chrome.permissions.remove({ origins }).catch(() => {});
      importController.current = null; setImporting(false);
    }
  };

  useEffect(() => {
    if (!importNotice || importing) return;
    const timer = window.setTimeout(() => setImportNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [importNotice, importing]);

  useEffect(() => {
    const generation = ++llmGenerationRef.current;
    setLoadingLlm(true);
    void prepareVideoChoice();
    void llmStore.load().then((config) => {
      if (llmGenerationRef.current === generation) setLlmConfig(config);
    }).catch(() => {
      if (llmGenerationRef.current !== generation) return;
      setLlmConfig(defaultLlmConfig("kimi"));
      setLlmLoadError("配置读取失败，请重新选择服务商重试，或重新填写官方 API Key 后保存。");
    }).finally(() => {
      if (llmGenerationRef.current === generation) setLoadingLlm(false);
    });
    return () => {
      llmGenerationRef.current += 1;
      cancelAnalysisOperation();
      stopPolling();
    };
  }, [cancelAnalysisOperation, llmStore, prepareVideoChoice, stopPolling]);

  useEffect(() => browser.onMediaUpload((message) => {
    if (message.jobId !== activeJobRef.current) return;
    if (message.type === "MEDIA_UPLOAD_PROGRESS") {
      const percent = message.totalBytes && message.totalBytes > 0
        ? Math.min(100, Math.round((message.uploadedBytes / message.totalBytes) * 100))
        : 0;
      setUploadPercent(percent);
    } else if (message.type === "MEDIA_UPLOAD_FAILED") {
      uploadStartedJobsRef.current.delete(message.jobId);
      cancelAnalysisOperation();
      stopPolling();
      setError(errorMessageForCode(message.code));
      setErrorCodeValue(message.code);
      setPhase("error");
    }
  }), [browser, cancelAnalysisOperation, stopPolling]);

  const checkCaptions = async () => {
    const url = choice === "current" ? context?.url ?? "" : replacementUrl.trim();
    if (!url) {
      setError("请输入要检查的 YouTube 视频链接");
      return;
    }
    cancelAnalysisOperation();
    stopPolling();
    const generation = pollGenerationRef.current;
    setError("");
    setErrorCodeValue(null);
    setPhase("checking");
    try {
      const activeRef = choice === "current" ? context?.contentRef : null;
      const candidates = context && activeRef?.platform === "x"
        ? await browser.getMediaCandidates(context.tabId, activeRef)
        : [];
      if (!isCurrentGeneration(generation)) return;
      const inspected = await api.inspect(activeRef?.platform === "x" ? {
        url,
        activeMediaIndex: activeRef.mediaIndex,
        ...(context?.durationMs != null ? { clientDurationMs: context.durationMs } : {}),
        mediaCandidates: candidates,
      } : url);
      if (!isCurrentGeneration(generation)) return;
      if (inspected.sourceStatus !== "ready") {
        const code = inspected.sourceStatus === "play_required"
          ? "x_video_play_required"
          : "x_media_not_detected";
        setError(errorMessageForCode(code));
        setErrorCodeValue(code);
        setPhase("selecting");
        return;
      }
      setInspection(inspected);
      setMediaCandidates(candidates);
      setInspectionUrl(url);
      setSourceLanguage(inspected.selectedLanguage);
      if (inspected.contentRef.platform === "x") {
        const history = await api.getHistory({ contentId: inspected.contentId, limit: 1, offset: 0 });
        if (!isCurrentGeneration(generation)) return;
        if (history.items[0]) {
          const analysis = await api.getResult(history.items[0].jobId);
          if (!isCurrentGeneration(generation)) return;
          showResult(analysis);
          return;
        }
      }
      setPhase("ready");
    } catch (requestError) {
      if (!isCurrentGeneration(generation)) return;
      const code = errorCode(requestError);
      setError(errorMessageForCode(code));
      setErrorCodeValue(code);
      setPhase("selecting");
    }
  };

  const viewExistingAnalysis = () => {
    const existing = context?.analysis;
    if (!context?.contentRef || !existing || !analysisMatches(existing, context.contentRef)) return;
    cancelAnalysisOperation();
    stopPolling();
    const generation = pollGenerationRef.current;
    setJobStatus("queued");
    setProcessingPlatform(context.contentRef.platform);
    setPhase("processing");
    activeJobRef.current = existing.jobId;
    void poll(existing.jobId, context.contentRef, context.tabId, true, generation);
  };

  const openHistory = async (reset = true) => {
    cancelAnalysisOperation();
    stopPolling();
    const generation = pollGenerationRef.current;
    setPhase("history");
    setHistoryLoading(true);
    setHistoryError("");
    const offset = reset ? 0 : historyItems.length;
    try {
      const page = await api.getHistory({ limit: HISTORY_PAGE_SIZE, offset });
      if (!isCurrentGeneration(generation)) return;
      setHistoryItems((current) => reset ? page.items : [...current, ...page.items]);
      setHistoryHasMore(page.hasMore);
      setPendingDeleteId(null);
      // Older versions had no completion preference. Existing imported records
      // establish prior consent; do not request migration access automatically.
      if (localApi.resume && !importCompleted && !importController.current && page.items.some((item) => item.jobId.startsWith("import:"))) {
        setImportCompleted(true);
        void chrome.storage.local.set({ [LEGACY_IMPORT_COMPLETED_KEY]: true }).catch(() => {});
      }
      if (localApi.getStorageMetadata) {
        const metadata = await localApi.getStorageMetadata();
        if (isCurrentGeneration(generation)) setStorageMetadata(metadata);
      }
    } catch (requestError) {
      if (!isCurrentGeneration(generation)) return;
      setHistoryError(errorMessageForCode(errorCode(requestError), "历史记录加载失败，请重试"));
    } finally {
      if (isCurrentGeneration(generation)) setHistoryLoading(false);
    }
  };

  const deleteHistoryRecord = async (jobId: string) => {
    if (!localApi.deleteCompletedAnalysis || historyLoading) return;
    const generation = pollGenerationRef.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      await localApi.deleteCompletedAnalysis(jobId);
      setHistoryItems((items) => items.filter((item) => item.jobId !== jobId));
      if (isCurrentGeneration(generation) && phaseRef.current === "history") await openHistory(true);
      else setHistoryLoading(false);
    } catch (failure) {
      if (isCurrentGeneration(generation)) setHistoryError(errorMessageForCode(errorCode(failure), "删除失败，请重试"));
      setHistoryLoading(false);
    }
  };

  const openHistoryResult = async (item: AnalysisHistoryItem) => {
    cancelAnalysisOperation();
    stopPolling();
    const generation = pollGenerationRef.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const analysis = await api.getResult(item.jobId);
      if (!isCurrentGeneration(generation)) return;
      setSection("overview");
      setQuery("");
      showResult(analysis, true);
    } catch (requestError) {
      if (!isCurrentGeneration(generation)) return;
      setHistoryError(errorMessageForCode(errorCode(requestError), "这条历史记录暂时无法打开"));
    } finally {
      if (isCurrentGeneration(generation)) setHistoryLoading(false);
    }
  };

  const startAnalysis = async () => {
    if (!context || !inspection || !sourceLanguage) return;
    if (!isLlmConfigured(llmConfig)) {
      setSettingsError("请先配置 LLM 服务，才能生成翻译和视频概览。");
      setPhase("settings");
      return;
    }
    const operationGeneration = beginAnalysisOperation();
    setProcessingPlatform(inspection.contentRef.platform);
    setLocalProgress(null);
    setPhase("processing");
    setJobStatus("queued");
    try {
      const contentRef = inspection.contentRef;
      const title = contentRef.platform === "youtube" && contentRef.sourceContentId !== context.videoId
        ? `YouTube video ${contentRef.sourceContentId}`
        : context.title;
      setFailedAnalysis({
        contentRef,
        sourceLanguage,
        targetLanguage,
        title,
      });
      const created = await api.createAnalysis({
        ...(contentRef.platform === "youtube"
          ? { videoId: contentRef.sourceContentId }
          : { contentRef, mediaUrl: mediaCandidates[0]?.url }),
        sourceLanguage,
        targetLanguage,
        title,
        llmConfig,
      });
      if (!isCurrentAnalysisOperation(operationGeneration)) return;
      if (contentRef.platform === "youtube" && contentRef.sourceContentId !== context.videoId) {
        await browser.seek(context.tabId, contentRef, 0);
        if (!isCurrentAnalysisOperation(operationGeneration)) return;
      }
      await browser.registerAnalysis(context.tabId, contentRef, created.jobId);
      if (!isCurrentAnalysisOperation(operationGeneration)) return;
      activeJobRef.current = created.jobId;
      finishAnalysisOperation(operationGeneration);
      const pollGeneration = pollGenerationRef.current;
      if (created.status === "completed") {
        const analysis = await api.getResult(created.jobId);
        if (!isCurrentPoll(created.jobId, pollGeneration)) return;
        showResult(analysis);
        setFailedAnalysis(null);
      } else {
        void poll(created.jobId, contentRef, context.tabId, true, pollGeneration);
      }
    } catch (requestError) {
      if (!isCurrentAnalysisOperation(operationGeneration)) return;
      finishAnalysisOperation(operationGeneration);
      const code = errorCode(requestError);
      setError(errorMessageForCode(code));
      setErrorCodeValue(code);
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
    const contentRef = result.contentRef;
    const matchesCurrentTab = Boolean(
      context.contentRef && sameContentRef(context.contentRef, contentRef),
    );
    if (contentRef.platform === "x" && !matchesCurrentTab) {
      setError(errorMessageForCode("x_video_context_required"));
      setErrorCodeValue("x_video_context_required");
      setPhase("error");
      return;
    }
    const operationGeneration = beginAnalysisOperation();
    setProcessingPlatform(result.contentRef.platform);
    setLocalProgress(null);
    setPhase("processing");
    setJobStatus("queued");
    try {
      const currentCandidate = matchesCurrentTab
        && inspection?.contentRef
        && sameContentRef(inspection.contentRef, contentRef)
        ? mediaCandidates[0]
        : undefined;
      if (contentRef.platform === "youtube" && contentRef.sourceContentId !== context.videoId) {
        await browser.seek(context.tabId, contentRef, 0);
        if (!isCurrentAnalysisOperation(operationGeneration)) return;
      }
      const created = await api.createAnalysis({
        ...(contentRef.platform === "youtube"
          ? { videoId: contentRef.sourceContentId }
          : { contentRef, ...(currentCandidate ? { mediaUrl: currentCandidate.url } : {}) }),
        sourceLanguage: result.sourceLanguage,
        targetLanguage: result.targetLanguage,
        title: result.videoTitle,
        llmConfig,
        force: true,
      });
      if (!isCurrentAnalysisOperation(operationGeneration)) return;
      if (contentRef.platform === "youtube" || matchesCurrentTab) {
        await browser.registerAnalysis(context.tabId, contentRef, created.jobId);
        if (!isCurrentAnalysisOperation(operationGeneration)) return;
      }
      activeJobRef.current = created.jobId;
      finishAnalysisOperation(operationGeneration);
      setResultFromHistory(false);
      void poll(created.jobId, contentRef, context.tabId, matchesCurrentTab, pollGenerationRef.current);
    } catch (requestError) {
      if (!isCurrentAnalysisOperation(operationGeneration)) return;
      finishAnalysisOperation(operationGeneration);
      setError(errorMessageForCode(errorCode(requestError)));
      setPhase("error");
    }
  };

  const retryExpiredCredentials = async () => {
    if (!context || !failedAnalysis) {
      await prepareVideoChoice();
      return;
    }
    if (!isLlmConfigured(llmConfig)) {
      setSettingsError("请先配置 LLM 服务，才能重新提交任务。");
      setSettingsReturnPhase("error");
      setPhase("settings");
      return;
    }
    const operationGeneration = beginAnalysisOperation();
    setProcessingPlatform(failedAnalysis.contentRef.platform);
    setPhase("processing");
    setJobStatus("queued");
    setErrorCodeValue(null);
    try {
      const matchesCurrentTab = Boolean(
        context.contentRef && sameContentRef(context.contentRef, failedAnalysis.contentRef),
      );
      const currentCandidate = matchesCurrentTab
        && inspection?.contentRef
        && sameContentRef(inspection.contentRef, failedAnalysis.contentRef)
        ? mediaCandidates[0]
        : undefined;
      const created = await api.createAnalysis({
        ...(failedAnalysis.contentRef.platform === "youtube"
          ? { videoId: failedAnalysis.contentRef.sourceContentId }
          : {
            contentRef: failedAnalysis.contentRef,
            ...(currentCandidate ? { mediaUrl: currentCandidate.url } : {}),
          }),
        sourceLanguage: failedAnalysis.sourceLanguage,
        targetLanguage: failedAnalysis.targetLanguage,
        title: failedAnalysis.title,
        llmConfig,
        force: true,
      });
      if (!isCurrentAnalysisOperation(operationGeneration)) return;
      if (failedAnalysis.contentRef.platform === "youtube" || matchesCurrentTab) {
        await browser.registerAnalysis(
          context.tabId,
          failedAnalysis.contentRef,
          created.jobId,
        );
        if (!isCurrentAnalysisOperation(operationGeneration)) return;
      }
      activeJobRef.current = created.jobId;
      finishAnalysisOperation(operationGeneration);
      void poll(created.jobId, failedAnalysis.contentRef, context.tabId, matchesCurrentTab, pollGenerationRef.current);
    } catch (requestError) {
      if (!isCurrentAnalysisOperation(operationGeneration)) return;
      finishAnalysisOperation(operationGeneration);
      const code = errorCode(requestError);
      setError(errorMessageForCode(code));
      setErrorCodeValue(code);
      setPhase("error");
    }
  };

  const openSettings = () => {
    setSettingsReturnPhase(phase === "settings" ? "selecting" : phase);
    setSettingsError("");
    setPhase("settings");
  };

  const closeSettings = () => {
    if (
      settingsReturnPhase === "processing"
      && activeJobRef.current === null
      && pendingAnalysisOperationRef.current === null
      && completedResultRef.current
    ) {
      setPhase("complete");
      return;
    }
    setPhase(settingsReturnPhase);
  };

  const changeLlmConfig = (config: LlmConfig) => {
    llmGenerationRef.current += 1;
    setLlmConfig(config);
    setSettingsError("");
    setLlmLoadError("");
    setTestingLlm(false);
    setSavingLlm(false);
  };

  const changeLlmProvider = async (provider: LlmConfig["provider"]) => {
    const generation = ++llmGenerationRef.current;
    setLlmConfig(defaultLlmConfig(provider));
    setSettingsError("");
    setLlmLoadError("");
    setTestingLlm(false);
    setSavingLlm(false);
    setLoadingLlm(true);
    try {
      const config = await llmStore.load(provider);
      if (llmGenerationRef.current === generation) setLlmConfig(config);
    } catch {
      if (llmGenerationRef.current === generation) setLlmLoadError("配置读取失败，请重新选择服务商重试，或重新填写官方 API Key 后保存。");
    } finally {
      if (llmGenerationRef.current === generation) setLoadingLlm(false);
    }
  };

  const saveLlmSettings = async (testFirst: boolean) => {
    if (loadingLlm || savingLlm || testingLlm) return;
    if (!isLlmConfigured(llmConfig)) {
      setSettingsError(errorMessageForCode("llm_config_invalid"));
      return;
    }
    const generation = ++llmGenerationRef.current;
    const config = { ...defaultLlmConfig(llmConfig.provider), apiKey: llmConfig.apiKey, model: llmConfig.model };
    const actionGeneration = ++llmActionGenerationRef.current;
    const current = () => llmGenerationRef.current === generation
      && llmActionGenerationRef.current === actionGeneration && phaseRef.current === "settings";
    setSettingsError("");
    setLlmLoadError("");
    if (testFirst) {
      setTestingLlm(true);
      try {
        await api.testLlm(config);
      } catch (requestError) {
        if (current()) {
          setSettingsError(errorMessageForCode(errorCode(requestError), "LLM 连接测试失败，请检查官方 API Key、模型 ID 和网络"));
          setTestingLlm(false);
        }
        return;
      }
      if (!current()) return;
    }
    setSavingLlm(true);
    try {
      await llmStore.save({ ...config, rememberOnDevice: llmConfig.rememberOnDevice === true });
      if (!current()) return;
      setLlmConfig({ ...config, rememberOnDevice: llmConfig.rememberOnDevice === true });
      if (testFirst) setSettingsError("连接成功，配置已保存");
      else closeSettings();
    } catch {
      if (current()) setSettingsError("配置保存失败，请检查浏览器存储后重试。");
    } finally {
      if (llmGenerationRef.current === generation) {
        setTestingLlm(false);
        setSavingLlm(false);
      }
    }
  };

  const seek = (startMs: number) => {
    const contentRef = result?.contentRef ?? context?.contentRef;
    if (context && contentRef) void browser.seek(context.tabId, contentRef, startMs);
  };

  const transcript = useMemo(() => {
    const segments = result?.transcript ?? [];
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return segments;
    return segments.filter((item) =>
      `${item.original} ${item.translated ?? ""}`.toLocaleLowerCase().includes(normalized),
    );
  }, [query, result]);
  const existingJobId = context?.analysis && context.contentRef && analysisMatches(context.analysis, context.contentRef)
    ? context.analysis.jobId
    : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-actions header-actions-left">
          <button className="icon-button" type="button" onClick={openSettings} title="LLM 设置" aria-label="LLM 设置">
            <Settings size={17} strokeWidth={1.8} />
          </button>
          <button className="icon-button" type="button" onClick={() => void prepareVideoChoice({ restoreAnalysis: false })} title="选择视频" aria-label="选择视频">
            <RefreshCw size={17} strokeWidth={1.8} />
          </button>
        </div>
        <div className="header-actions header-actions-right">
          <button className="icon-button" type="button" onClick={() => void openHistory()} title="历史记录" aria-label="历史记录">
            <History size={17} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {phase !== "processing" && recoverable.length > 0 && <aside className="privacy-note" aria-label="可恢复任务">
        <p>以下任务已暂停，已完成的内容保存在本机。继续会使用任务原来的服务商和模型；如未保存 Key，请先在设置中填写。</p>
        {recoverable.map((task) => <div key={task.jobId}>
          <span>{task.videoTitle} · {errorMessageForCode(task.failureCode ?? "analysis_interrupted")}</span>
          <button className="secondary-button" type="button" disabled={discarding} onClick={() => void resumeLocalTask(task)}>继续此任务</button>
          {localApi.discardRecoverableTask && (pendingDiscardId === task.jobId ? <div>
            <p>放弃此任务并删除已保存的字幕和进度？此操作无法撤销。</p>
            <button className="secondary-button" disabled={discarding} onClick={() => void discardLocalTask(task.jobId)}>确认放弃任务</button>
            <button className="secondary-button" disabled={discarding} onClick={() => setPendingDiscardId(null)}>取消</button>
          </div> : <button className="secondary-button" disabled={discarding} onClick={() => setPendingDiscardId(task.jobId)}>放弃任务</button>)}
        </div>)}
      </aside>}
      {phase === "complete" && result?.partial && error && <p role="status" className="settings-message">{error}。已读取的字幕保留在下方。</p>}

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
          title={inspection.contentRef.platform === "x"
            ? context?.title ?? "X video"
            : inspection.videoId === context?.videoId ? context?.title ?? "YouTube video" : `YouTube 视频 ${inspection.videoId}`}
          inspection={inspection}
          isCurrentVideo={Boolean(context?.contentRef && sameContentRef(inspection.contentRef, context.contentRef))}
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
          error={settingsError || llmLoadError}
          testing={testingLlm}
          saving={savingLlm}
          loading={loadingLlm}
          onChange={changeLlmConfig}
          onProviderChange={changeLlmProvider}
          onSave={() => void saveLlmSettings(false)}
          onTest={() => void saveLlmSettings(true)}
          onBack={closeSettings}
          experimentalAsr={localApi.resume ? experimentalAsr : undefined}
          onExperimentalAsr={(enabled) => void changeExperimentalAsr(enabled)}
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
          onBack={() => void prepareVideoChoice({ restoreAnalysis: false })}
          storageMetadata={storageMetadata}
          pendingDeleteId={pendingDeleteId}
          onRequestDelete={localApi.deleteCompletedAnalysis ? setPendingDeleteId : undefined}
          onConfirmDelete={(jobId) => void deleteHistoryRecord(jobId)}
          importAction={localApi.resume ? <button className="history-import-button" type="button"
            title="从旧本地服务导入历史记录（只读，不删除原记录）"
            disabled={!importPreferenceLoaded || (!importConsent && !importCompleted) || importing || historyLoading}
            onClick={() => void importHistory()}><Import size={16} strokeWidth={1.8} aria-hidden="true" />导入</button> : undefined}
          migration={localApi.resume && !importCompleted && importPreferenceLoaded ? <section className="privacy-note history-import-note">
              <label><input type="checkbox" checked={importConsent} disabled={importing} onChange={(event) => setImportConsent(event.target.checked)} />从旧本地服务导入当前安装的已完成记录（只读，不删除原记录）</label>
              <p>仅迁移时需要启动原本地服务。关闭此侧边栏会停止导入，可再次导入而不重复。</p>
          </section> : undefined}
        />
      )}
      {phase === "processing" && <><ProcessingView platform={processingPlatform} status={jobStatus} uploadPercent={uploadPercent} localProgress={localProgress} />
        {localApi.cancel && <button className="secondary-button" type="button" onClick={() => void cancelLocalTask()}>暂停任务</button>}
      </>}
      {phase === "error" && <ErrorView
        message={error}
        retryLabel={errorCodeValue === "llm_credentials_expired" ? "重试" : "重新检查"}
        onRetry={errorCodeValue === "llm_credentials_expired"
          ? () => void retryExpiredCredentials()
          : () => void prepareVideoChoice()}
      />}
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
          onBack={resultFromHistory
            ? () => void openHistory()
            : () => void prepareVideoChoice({ restoreAnalysis: false })}
        />
      )}
      {importNotice && <aside className="import-toast" aria-label="历史导入提示">
        <Import size={18} strokeWidth={1.8} aria-hidden="true" />
        <div className="import-toast-content">
          <p role="status" aria-atomic="true">{importNotice.message}</p>
          {importing && <button className="secondary-button" type="button" onClick={() => importController.current?.abort()}>停止导入</button>}
        </div>
        {!importing && <button className="icon-button" type="button" aria-label="关闭导入提示" onClick={() => setImportNotice(null)}><X size={16} strokeWidth={1.8} aria-hidden="true" /></button>}
      </aside>}
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
  const isX = context?.contentRef?.platform === "x";
  return (
    <main className="selection-view">
      <p className="section-label">开始前</p>
      <h1>选择要分析的视频</h1>
      {!isX && <div className="choice-switch" role="tablist" aria-label="视频来源">
        <button type="button" role="tab" aria-selected={usingCurrentVideo} className={usingCurrentVideo ? "active" : ""} onClick={() => onChoiceChange("current")}>当前视频</button>
        <button type="button" role="tab" aria-selected={!usingCurrentVideo} className={!usingCurrentVideo ? "active" : ""} onClick={() => onChoiceChange("replacement")}>输入其他 YouTube 链接</button>
      </div>}
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
      <button className="primary-button" type="button" onClick={onCheck}>{usingCurrentVideo ? (isX ? "检查当前视频" : "检查当前视频字幕") : "检查此链接字幕"}</button>
      {usingCurrentVideo && existingJobId && <button className="secondary-button" type="button" onClick={onViewExisting}>查看当前分析</button>}
      {!llmConfigured && <button className="setup-link" type="button" onClick={onSettings}><Settings size={14} />先配置 LLM，再生成翻译和概览</button>}
      <p className="privacy-note">{isX ? "视频会在浏览器本机提取音频并识别语音。首次使用需要下载 Whisper small 模型。" : "先确认公开字幕是否可读，再决定是否开始分析。"}</p>
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
  const [modelConsent, setModelConsent] = useState(false);
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
  const isX = inspection.contentRef.platform === "x";
  return (
    <main className="ready-view">
      <p className="section-label">{isX ? "当前 X 视频" : isCurrentVideo ? "当前视频字幕" : "已检测替换视频"}</p>
      <h1>{title}</h1>
      <p className="inspection-url">{inspectionUrl}</p>
      <div className="caption-status"><Check size={14} /><span>{isX ? "语音将自动识别" : "检测到可读取字幕"}</span></div>
      <div className="form-row">
        <label htmlFor="source-language">源字幕</label>
        <select id="source-language" value={sourceLanguage} onChange={(event) => onSourceChange(event.target.value)}>
          {isX && <option value="auto">自动检测</option>}
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
        <Languages size={16} /><span>{isX ? "自动识别语音" : selected?.isGenerated ? "YouTube 自动字幕" : "提供者字幕"}</span>
        <Clock3 size={16} /><span>{formatTime(inspection.durationMs)}</span>
      </div>
      {isX && <label className="privacy-note"><input type="checkbox" checked={modelConsent} onChange={(event) => setModelConsent(event.target.checked)} />允许下载并缓存 Whisper small 模型（首次约数百 MB），使用本机 CPU 识别。识别可能慢于视频播放，不保证实时。</label>}
      <button className="primary-button" type="button" onClick={onStart} disabled={isX && !modelConsent}>{isCurrentVideo ? "分析此视频" : "分析并打开此视频"}</button>
      {!llmConfigured && <button className="setup-link" type="button" onClick={onSettings}><Settings size={14} />配置 LLM 后开始</button>}
      <button className="secondary-button" type="button" onClick={onBack}>更换视频</button>
      <p className="privacy-note">{isX ? "音频只在本机识别；识别后的字幕直接发送给所选官方 LLM 服务商，用于翻译和摘要。" : "公开字幕直接发送给所选官方 LLM 服务商，用于翻译和摘要。"}分析结果与历史记录保存在此浏览器。</p>
    </main>
  );
}

function SettingsView({
  config, error, testing, saving, loading, onChange, onProviderChange, onSave, onTest, onBack, experimentalAsr, onExperimentalAsr,
}: {
  config: LlmConfig;
  error: string;
  testing: boolean;
  saving: boolean;
  loading: boolean;
  onChange(config: LlmConfig): void;
  onProviderChange(provider: LlmConfig["provider"]): void;
  onSave(): void;
  onTest(): void;
  onBack(): void;
  experimentalAsr?: boolean;
  onExperimentalAsr(enabled: boolean): void;
}) {
  return (
    <main className="settings-view">
      <p className="section-label">LLM 设置</p>
      <h1>配置 LLM</h1>
      <p className="settings-copy">仅支持以下服务商的官方 API，不支持自定义地址或第三方中转。请填写对应服务商的官方 API Key。</p>
      <label className="settings-field" htmlFor="llm-provider"><span>Provider</span><select id="llm-provider" value={config.provider} onChange={(event) => {
        const provider = event.target.value as LlmConfig["provider"];
        onProviderChange(provider);
      }}>{LLM_PROVIDER_OPTIONS.map((option) => <option key={option.provider} value={option.provider}>{option.label}</option>)}</select></label>
      <label className="settings-field" htmlFor="llm-api-url"><span>API URL</span><input id="llm-api-url" value={config.apiUrl} readOnly inputMode="url" /></label>
      <label className="settings-field" htmlFor="llm-model"><span>模型</span><input id="llm-model" value={config.model} disabled={loading} onChange={(event) => onChange({ ...config, model: event.target.value })} placeholder={defaultLlmConfig(config.provider).model} /></label>
      <label className="settings-field" htmlFor="llm-api-key"><span>API Key</span><input id="llm-api-key" type="password" value={config.apiKey} disabled={loading} onChange={(event) => onChange({ ...config, apiKey: event.target.value })} placeholder="官方 API Key" /></label>
      <div className="settings-preferences">
        <label className="settings-remember"><input type="checkbox" checked={config.rememberOnDevice === true} disabled={loading} onChange={(event) => onChange({ ...config, rememberOnDevice: event.target.checked })} /> 记住在此设备</label>
        <SettingsHelp />
      </div>
      {experimentalAsr !== undefined && <label className="privacy-note settings-asr-option"><input type="checkbox" checked={experimentalAsr} onChange={(event) => onExperimentalAsr(event.target.checked)} /><span>启用实验性 X 本机语音识别。使用 CPU Whisper small；尚未完成真实模型和性能验收，可能无法完成或速度较慢。首次使用需下载模型。</span></label>}
      {(config.migrationNotice || config.provider === "hunyuan") && <p className="settings-copy">{config.migrationNotice || HUNYUAN_MIGRATION_NOTICE}</p>}
      {loading && <p className="settings-copy">正在读取此服务商的独立配置…</p>}
      {error && <p className={`settings-message ${error.includes("成功") ? "success" : ""}`} role="status">{error}</p>}
      <button className="primary-button" type="button" onClick={onTest} disabled={testing || saving || loading}>{testing ? "测试中..." : "测试连通"}</button>
      <button className="secondary-button" type="button" onClick={onSave} disabled={testing || saving || loading}>{saving && !testing ? "保存中..." : "保存配置"}</button>
      <button className="secondary-button" type="button" onClick={onBack}>返回</button>
    </main>
  );
}

function ProcessingView({
  platform,
  status,
  uploadPercent,
  localProgress,
}: {
  platform: ContentRef["platform"];
  status: JobStatus;
  uploadPercent: number | null;
  localProgress?: Partial<LocalAnalysisStatus> | null;
}) {
  const stages: Array<[JobStatus, string]> = platform === "x"
    ? [
      ["downloading_media", "获取视频"],
      ["extracting_audio", "提取音频"],
      ["transcribing", "识别语音"],
      ["translating", "翻译字幕"],
      ["analyzing", "整理章节与重点"],
    ]
    : [
      ["fetching_transcript", "读取字幕"],
      ["translating", "翻译字幕"],
      ["analyzing", "整理章节与重点"],
    ];
  const activeIndex = status === "queued" || status === "waiting_for_media"
    ? 0
    : stages.findIndex(([key]) => key === status);
  const title = platform === "youtube"
    ? "正在读这条视频"
    : uploadPercent !== null && status === "waiting_for_media"
    ? `正在上传视频 ${uploadPercent}%`
    : status === "waiting_for_media" || status === "downloading_media"
      ? "正在获取 X 视频"
      : status === "extracting_audio"
        ? "正在提取音频"
        : status === "transcribing"
          ? "正在识别语音"
          : "正在读这条视频";
  return (
    <main className="processing-view">
      <div className="processing-mark"><span></span><span></span><span></span></div>
      <p className="section-label">后台处理中</p>
      <h1>{localProgress?.stage === "downloading_model" ? "正在下载并校验语音模型" : title}</h1>
      {localProgress?.progressTotal != null && <p role="status">进度 {Math.min(100, Math.floor((localProgress.progressCompleted ?? 0) / Math.max(1, localProgress.progressTotal) * 100))}%</p>}
      <p>可以关闭侧边栏。关闭浏览器会暂停任务；下次打开后可手动继续，已完成的步骤保留。</p>
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

function HistoryView({ items, loading, error, hasMore, onOpen, onLoadMore, onRetry, onBack, importAction, migration, storageMetadata, pendingDeleteId, onRequestDelete, onConfirmDelete }: {
  items: AnalysisHistoryItem[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  onOpen(item: AnalysisHistoryItem): void;
  onLoadMore(): void;
  onRetry(): void;
  onBack(): void;
  importAction?: import("react").ReactNode;
  migration?: import("react").ReactNode;
  storageMetadata: LocalStorageMetadata | null;
  pendingDeleteId: string | null;
  onRequestDelete?: (jobId: string | null) => void;
  onConfirmDelete(jobId: string): void;
}) {
  const historyNearLimit = storageMetadata !== null && (
    storageMetadata.history.recordCount >= storageMetadata.history.maxRecords * 0.9
    || storageMetadata.history.bytes >= storageMetadata.history.maxBytes * 0.9
  );
  const taskDataNearLimit = storageMetadata !== null
    && storageMetadata.taskData.bytes >= storageMetadata.taskData.maxBytes * 0.9;

  return (
    <main className="history-view">
      <div className="view-heading history-heading">
        <button className="icon-button" type="button" onClick={onBack} aria-label="返回当前视频"><ChevronLeft size={18} /></button>
        <div><h1>历史记录</h1></div>
        {importAction}
      </div>
      {migration}
      {historyNearLimit && <p className="privacy-note" role="status">历史记录存储空间不足，请清理不再需要的记录。</p>}
      {taskDataNearLimit && <p className="privacy-note" role="status">任务与进度存储空间不足，请在上方放弃不再需要的暂停任务。</p>}
      {items.length === 0 && !loading && !error && <p className="empty-state">还没有分析记录</p>}
      <div className="history-list">
        {items.map((item) => (
          <div className="history-item" key={item.jobId}>
            <div className="history-entry">
              <button className="history-row" type="button" disabled={loading} onClick={() => onOpen(item)} aria-label={`打开 ${item.videoTitle}`}>
                <span><strong>{item.videoTitle}</strong><small>视频时长 {formatTime(item.durationMs)} · {formatCompletedAt(item.completedAt)}</small></span>
                <ChevronRight size={16} />
              </button>
              {onRequestDelete && <button
                className="icon-button history-delete-action"
                type="button"
                disabled={loading || pendingDeleteId === item.jobId}
                aria-label={`删除 ${item.videoTitle}`}
                title="删除记录"
                onClick={() => onRequestDelete(item.jobId)}
              ><Trash2 size={16} strokeWidth={1.8} aria-hidden="true" /></button>}
            </div>
            {onRequestDelete && pendingDeleteId === item.jobId && <div className="privacy-note">
              <p>删除“{item.videoTitle}”及其本机任务数据？此操作无法撤销，旧服务中的原记录不受影响。</p>
              <button className="secondary-button" disabled={loading} onClick={() => onConfirmDelete(item.jobId)}>确认删除</button>
              <button className="secondary-button" disabled={loading} onClick={() => onRequestDelete(null)}>取消</button>
            </div>}
          </div>
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
  onBack(): void;
}) {
  return (
    <main className="result-view">
      <div className="result-toolbar">
        <button className="result-back" type="button" onClick={onBack}><ChevronLeft size={15} />返回</button>
        <button className="secondary-button retry-analysis" type="button" onClick={onRetry}>重新分析</button>
      </div>
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

function ErrorView({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry(): void }) {
  return (
    <main className="error-view">
      <AlertCircle size={30} strokeWidth={1.5} />
      <h1>{message}</h1>
      <p>检查当前视频后重试，已有后台任务不会受到影响。</p>
      <button type="button" onClick={onRetry}>{retryLabel}</button>
    </main>
  );
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.platform === right.platform
    && left.sourceContentId === right.sourceContentId
    && left.mediaIndex === right.mediaIndex;
}

function analysisMatches(analysis: NonNullable<ActiveTabContext["analysis"]>, contentRef: ContentRef): boolean {
  if (analysis.contentRef) return sameContentRef(analysis.contentRef, contentRef);
  return contentRef.platform === "youtube" && analysis.videoId === contentRef.sourceContentId;
}

function isBareXStatusUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === "https:"
      && (url.hostname === "x.com" || url.hostname === "www.x.com")
      && /^\/[^/]+\/status\/[0-9]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
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
