export type LlmProvider = "kimi" | "deepseek" | "hunyuan" | "qwen" | "glm";

export interface LlmConfig {
  provider: LlmProvider;
  apiUrl: string;
  apiKey: string;
  model: string;
  rememberOnDevice?: boolean;
  migrationNotice?: string;
}

export interface LlmConfigStore {
  load(provider?: LlmProvider): Promise<LlmConfig>;
  save(config: LlmConfig): Promise<void>;
}

const STORAGE_KEY = "llmConfigs";
const LEGACY_STORAGE_KEY = "kimiLlmConfig";
const SELECTED_PROVIDER_KEY = "selectedLlmProvider";
const sessionKey = (provider: LlmProvider) => `llmSessionConfigV2:${provider}`;
const rememberedKey = (provider: LlmProvider) => `llmRememberedConfigV2:${provider}`;

export const LLM_PROVIDER_OPTIONS: ReadonlyArray<Readonly<{
  provider: LlmProvider;
  label: string;
  defaultUrl: string;
  defaultModel: string;
}>> = Object.freeze([
  { provider: "kimi", label: "Kimi", defaultUrl: "https://api.moonshot.cn/v1", defaultModel: "kimi-k2.5" },
  { provider: "deepseek", label: "DeepSeek", defaultUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" },
  { provider: "hunyuan", label: "腾讯混元", defaultUrl: "https://tokenhub.tencentmaas.com/v1", defaultModel: "hy3" },
  { provider: "qwen", label: "通义千问", defaultUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus" },
  { provider: "glm", label: "智谱 GLM", defaultUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.7-flash" },
].map((option) => Object.freeze(option)) as ReadonlyArray<Readonly<{
  provider: LlmProvider; label: string; defaultUrl: string; defaultModel: string;
}>>);

export const HUNYUAN_MIGRATION_NOTICE = "混元旧平台已于 2026-09-30 下线，请使用新 TokenHub 平台的官方 API Key，旧 Key 不会自动复用。";
const MALFORMED_CONFIG_NOTICE = "LLM 配置存储格式无法识别，旧 API Key 已隔离。请重新填写所选服务商的官方 API Key。原始配置保留不变，不影响历史记录、身份数据或其他设置。";
const LEGACY_CONFIG_NOTICE = "旧 API Key 已隔离，不会自动恢复。请重新填写所选服务商的官方 API Key，并选择仅本次使用或记住在此设备。原始配置保留不变。";

function isProvider(value: unknown): value is LlmProvider {
  return LLM_PROVIDER_OPTIONS.some((option) => option.provider === value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function officialBaseUrl(provider: unknown, apiUrl: unknown): string | null {
  const option = LLM_PROVIDER_OPTIONS.find((item) => item.provider === provider);
  if (!option || typeof apiUrl !== "string" || /[\s\u0000-\u001f\u007f\\?#]/u.test(apiUrl)) return null;
  // Inspect the original authority/path: URL() would normalize ambiguous input.
  const supplied = /^https:\/\/([^/]+)(\/.*)?$/i.exec(apiUrl);
  const expected = new URL(option.defaultUrl);
  if (!supplied || ![expected.hostname, `${expected.hostname}:443`].includes(supplied[1].toLowerCase())) return null;
  if (!["", "/", expected.pathname, `${expected.pathname}/`, `${expected.pathname}/chat/completions`, `${expected.pathname}/chat/completions/`].includes(supplied[2] ?? "")) return null;
  return option.defaultUrl;
}

export function defaultLlmConfig(provider: LlmProvider): LlmConfig {
  const option = LLM_PROVIDER_OPTIONS.find((item) => item.provider === provider)!;
  return { provider, apiUrl: option.defaultUrl, apiKey: "", model: option.defaultModel };
}

function sanitizeStoredConfig(provider: LlmProvider, stored: unknown): LlmConfig {
  const defaults = defaultLlmConfig(provider);
  const config = record(stored) ? stored : {};
  const model = typeof config.model === "string" && config.model.trim() ? config.model : defaults.model;
  const official = officialBaseUrl(provider, config.apiUrl);
  if (official && (config.provider === undefined || config.provider === provider)
    && (config.apiKey === undefined || typeof config.apiKey === "string")
    && (config.model === undefined || (typeof config.model === "string" && Boolean(config.model.trim())))) {
    return { ...defaults, apiUrl: official, apiKey: (config.apiKey as string | undefined) ?? "", model, rememberOnDevice: config.rememberOnDevice === true };
  }
  return {
    ...defaults,
    model,
    migrationNotice: provider === "hunyuan" ? HUNYUAN_MIGRATION_NOTICE
      : "旧配置使用中转、非官方或无法确认的地址，已隔离旧 API Key。请重新填写所选服务商的官方 API Key 并保存；原始配置未被删除。",
  };
}

let saveQueue: Promise<void> = Promise.resolve();

export async function restrictCredentialStorage(storage: Pick<typeof chrome.storage, "local" | "session"> = chrome.storage): Promise<void> {
  // Never read or write a key when the browser cannot enforce trusted-only access.
  await Promise.all([
    storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
}

export const browserLlmConfigStore: LlmConfigStore = {
  async load(provider) {
    await restrictCredentialStorage();
    await saveQueue;
    const value = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY, SELECTED_PROVIDER_KEY]);
    const selected = provider ?? (isProvider(value[SELECTED_PROVIDER_KEY]) ? value[SELECTED_PROVIDER_KEY] : "kimi");
    const [session, local] = await Promise.all([
      chrome.storage.session.get(sessionKey(selected)),
      chrome.storage.local.get(rememberedKey(selected)),
    ]);
    if (Object.hasOwn(session, sessionKey(selected))) return sanitizeStoredConfig(selected, session[sessionKey(selected)]);
    if (Object.hasOwn(local, rememberedKey(selected))) {
      const stored: unknown = local[rememberedKey(selected)];
      if (record(stored) && stored.rememberOnDevice === true) return sanitizeStoredConfig(selected, stored);
      return { ...defaultLlmConfig(selected), migrationNotice: MALFORMED_CONFIG_NOTICE };
    }
    const configs: unknown = value[STORAGE_KEY];
    if (Object.hasOwn(value, STORAGE_KEY) && !record(configs)) {
      return {
        ...defaultLlmConfig(selected),
        migrationNotice: selected === "hunyuan" ? `${MALFORMED_CONFIG_NOTICE} ${HUNYUAN_MIGRATION_NOTICE}` : MALFORMED_CONFIG_NOTICE,
      };
    }
    if (record(configs) && Object.hasOwn(configs, selected)) {
      const legacy = sanitizeStoredConfig(selected, configs[selected]);
      return { ...legacy, apiKey: "", rememberOnDevice: false, migrationNotice: legacy.migrationNotice ?? LEGACY_CONFIG_NOTICE };
    }
    if (selected === "kimi" && Object.hasOwn(value, LEGACY_STORAGE_KEY)) {
      const legacy = sanitizeStoredConfig(selected, value[LEGACY_STORAGE_KEY]);
      return { ...legacy, apiKey: "", rememberOnDevice: false, migrationNotice: legacy.migrationNotice ?? LEGACY_CONFIG_NOTICE };
    }
    return defaultLlmConfig(selected);
  },
  async save(config) {
    if (!isLlmConfigured(config)) throw new Error("llm_config_invalid");
    const saved = { provider: config.provider, apiUrl: officialBaseUrl(config.provider, config.apiUrl)!, apiKey: config.apiKey, model: config.model, rememberOnDevice: config.rememberOnDevice === true };
    const operation = saveQueue.then(async () => {
      await restrictCredentialStorage();
      if (saved.rememberOnDevice) {
        await chrome.storage.local.set({ [rememberedKey(saved.provider)]: saved, [SELECTED_PROVIDER_KEY]: saved.provider });
      } else {
        // Remove the durable copy first; a failed write must never silently retain it.
        await chrome.storage.local.remove(rememberedKey(saved.provider));
        await chrome.storage.local.set({ [SELECTED_PROVIDER_KEY]: saved.provider });
      }
      await chrome.storage.session.set({ [sessionKey(saved.provider)]: saved });
    });
    saveQueue = operation.catch(() => undefined);
    await operation;
  },
};

export function isLlmConfigured(config: LlmConfig): boolean {
  return Boolean(config && officialBaseUrl(config.provider, config.apiUrl)
    && typeof config.apiKey === "string" && config.apiKey.trim()
    && typeof config.model === "string" && config.model.trim());
}
