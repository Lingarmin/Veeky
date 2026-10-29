import { describe, expect, it } from "vitest";
import {
  createAnalysisMessages,
  createTranslationMessages,
  parseAnalysisResult,
  parseTranslationResult,
} from "../src/local/prompts";

const segments = [
  { id: "segment-1", startMs: 0, durationMs: 1_200, original: "First thought." },
  { id: "segment-2", startMs: 1_200, durationMs: 800, original: "Second thought." },
];

describe("provider-neutral transcript prompts", () => {
  it("sends stable segment IDs and target-language instructions for translation", () => {
    const messages = createTranslationMessages(segments, "English", "简体中文");

    expect(messages[0].content).toContain("segment_id");
    expect(messages[1].content).toContain('"target_language":"简体中文"');
    expect(messages[1].content).toContain('"segment_id":"segment-1"');
    expect(messages[1].content).toContain('"segment_id":"segment-2"');
  });

  it("reconciles translation output by identity while preserving timing and original text", () => {
    const translated = parseTranslationResult(JSON.stringify({ translations: [
      { segment_id: "segment-2", text: "第二句。" },
      { segment_id: "segment-1", translation: "第一句。" },
    ] }), segments);

    expect(translated).toEqual([
      { ...segments[0], translated: "第一句。" },
      { ...segments[1], translated: "第二句。" },
    ]);
  });

  it.each([
    { translations: [{ segment_id: "segment-1", text: "第一句。" }] },
    { translations: [{ segment_id: "segment-1", text: "第一句。" }, { segment_id: "segment-1", text: "重复。" }] },
    { translations: [{ segment_id: "segment-1", text: "第一句。" }, { segment_id: "other", text: "额外。" }] },
  ])("rejects incomplete or ambiguous translation mappings", (payload) => {
    expect(() => parseTranslationResult(JSON.stringify(payload), segments)).toThrow(/translation/i);
  });

  it("asks for a distinct summary, chronological chapters, and transcript-grounded highlights", () => {
    const messages = createAnalysisMessages(segments, "简体中文", 2_000);

    expect(messages[0].content).toContain("must not repeat");
    expect(messages[0].content).toContain("original_excerpt");
    expect(messages[1].content).toContain('"duration_ms":2000');
  });

  it("accepts valid structured analysis and normalizes exact result fields", () => {
    const result = parseAnalysisResult(JSON.stringify({
      one_line_summary: "解释了两步处理流程。",
      summary_points: ["先读取输入。", "再验证输出。", "最后保存结果。"],
      chapters: [{ start_ms: 0, end_ms: 2_000, title: "处理流程", summary: "讲者先读入数据，再逐步验证并保存最终结果。" }],
      highlights: [{ start_ms: 500, end_ms: 1_200, title: "关键验证", summary: "这段说明验证可避免无效结果被保存。", original_excerpt: "Second thought.", translated_excerpt: "第二句。" }],
    }), 2_000);

    expect(result).toMatchObject({ one_line_summary: "解释了两步处理流程。", summary_points: expect.arrayContaining([expect.any(String)]), chapters: [{ title: "处理流程" }] });
  });

  it.each([
    { start_ms: -1, end_ms: 2_000, title: "章节", summary: "讲者先介绍输入，然后解释输出验证。" },
    { start_ms: 0, end_ms: 2_001, title: "章节", summary: "讲者先介绍输入，然后解释输出验证。" },
    { start_ms: 900, end_ms: 100, title: "章节", summary: "讲者先介绍输入，然后解释输出验证。" },
    { start_ms: 0, end_ms: 2_000, title: "重复标题", summary: "重复标题" },
  ])("rejects invalid chapter timing or duplicate descriptions", (chapter) => {
    const payload = {
      one_line_summary: "概览内容。",
      summary_points: ["观点一。", "观点二。", "观点三。"],
      chapters: [chapter],
      highlights: [],
    };
    expect(() => parseAnalysisResult(JSON.stringify(payload), 2_000)).toThrow(/analysis/i);
  });

  it("rejects malformed analysis JSON and too few summary points", () => {
    expect(() => parseAnalysisResult("not JSON", 2_000)).toThrow(/analysis/i);
    expect(() => parseAnalysisResult(JSON.stringify({
      one_line_summary: "概览内容。", summary_points: ["只有一点。"], chapters: [], highlights: [],
    }), 2_000)).toThrow(/analysis/i);
  });
});
