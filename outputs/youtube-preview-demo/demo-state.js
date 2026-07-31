(function registerDemoState(root) {
  const ANALYSIS_STAGES = ["checking", "translating", "summarizing", "complete"];

  function createDemoState() {
    return {
      activeTab: "youtube",
      analyzedTab: "youtube",
      panelVisible: true,
      videoId: "aircAruvnKk",
      duration: 1159,
      currentTime: 0,
      analysisStatus: "complete",
      section: "overview",
    };
  }

  function switchTab(state, tabId) {
    return {
      ...state,
      activeTab: tabId,
      panelVisible: tabId === state.analyzedTab,
    };
  }

  function selectSection(state, section) {
    return { ...state, section };
  }

  function advanceAnalysis(state) {
    const index = ANALYSIS_STAGES.indexOf(state.analysisStatus);
    if (index < 0 || index === ANALYSIS_STAGES.length - 1) return state;
    return { ...state, analysisStatus: ANALYSIS_STAGES[index + 1] };
  }

  function seekTo(state, seconds) {
    return {
      ...state,
      currentTime: Math.min(state.duration, Math.max(0, seconds)),
    };
  }

  function filterTranscript(segments, query) {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return segments;
    return segments.filter((segment) =>
      `${segment.original} ${segment.translated}`.toLocaleLowerCase().includes(normalized),
    );
  }

  function formatTime(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }

  const api = {
    ANALYSIS_STAGES,
    advanceAnalysis,
    createDemoState,
    filterTranscript,
    formatTime,
    seekTo,
    selectSection,
    switchTab,
  };

  root.DemoState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
