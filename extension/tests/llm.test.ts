import { describe, expect, it } from "vitest";

import { defaultLlmConfig, isLlmConfigured } from "../src/sidepanel/llm";

describe("LLM configuration", () => {
  it("requires both an API URL and API key", () => {
    expect(isLlmConfigured({ provider: "kimi", apiUrl: "", apiKey: "secret", model: "kimi-k2.5" })).toBe(false);
    expect(isLlmConfigured({ provider: "deepseek", apiUrl: "https://api.example.com/v1", apiKey: "secret", model: "deepseek-chat" })).toBe(true);
  });

  it("provides separate defaults for Kimi and DeepSeek", () => {
    expect(defaultLlmConfig("kimi").model).toBe("kimi-k2.5");
    expect(defaultLlmConfig("deepseek")).toMatchObject({ apiUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" });
  });
});
