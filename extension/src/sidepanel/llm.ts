export type LlmProvider = "kimi" | "deepseek";

export interface LlmConfig {
  provider: LlmProvider;
  apiUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmConfigStore {
  load(provider?: LlmProvider): Promise<LlmConfig>;
  save(config: LlmConfig): Promise<void>;
}

const STORAGE_KEY = "llmConfigs";
const LEGACY_STORAGE_KEY = "kimiLlmConfig";

export const LLM_PROVIDER_OPTIONS: Array<{
  provider: LlmProvider;
  label: string;
  defaultUrl: string;
  defaultModel: string;
}> = [
  { provider: "kimi", label: "Kimi", defaultUrl: "https://api.moonshot.cn/v1", defaultModel: "kimi-k2.5" },
  { provider: "deepseek", label: "DeepSeek", defaultUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" },
];

export function defaultLlmConfig(provider: LlmProvider): LlmConfig {
  const option = LLM_PROVIDER_OPTIONS.find((item) => item.provider === provider)!;
  return { provider, apiUrl: option.defaultUrl, apiKey: "", model: option.defaultModel };
}

export const browserLlmConfigStore: LlmConfigStore = {
  async load(provider = "kimi") {
    const value = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
    const configs = value[STORAGE_KEY] as Record<LlmProvider, Partial<LlmConfig>> | undefined;
    const legacy = value[LEGACY_STORAGE_KEY] as Partial<LlmConfig> | undefined;
    const kimi = configs?.kimi ?? legacy;
    if (!configs && legacy) {
      const migrated = { kimi: { ...defaultLlmConfig("kimi"), ...legacy } };
      await chrome.storage.local.set({ [STORAGE_KEY]: migrated });
    }
    const config = provider === "kimi" ? kimi ?? {} : configs?.[provider] ?? {};
    return {
      provider,
      apiUrl: config.apiUrl ?? defaultLlmConfig(provider).apiUrl,
      apiKey: config.apiKey ?? "",
      model: config.model ?? defaultLlmConfig(provider).model,
    };
  },
  async save(config) {
    const value = await chrome.storage.local.get(STORAGE_KEY);
    const configs = (value[STORAGE_KEY] as Record<LlmProvider, LlmConfig> | undefined) ?? {};
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...configs, [config.provider]: config } });
  },
};

export function isLlmConfigured(config: LlmConfig): boolean {
  return Boolean(config.apiUrl.trim() && config.apiKey.trim());
}
