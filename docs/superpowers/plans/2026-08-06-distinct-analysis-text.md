# 摘要标题与说明差异化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让章节和值得看片段的标题、说明、字幕摘录各自表达不同信息，并隐藏旧结果中的重复文字。

**Architecture:** API 在提示词中明确字段职责，并对模型明确返回的 `title` 和 `summary` 做归一化重复检查，不合格时沿用现有重试流程。扩展在展示层做最后一道去重，只隐藏重复字段，不修改接口和已保存数据。

**Tech Stack:** Python 3.12、FastAPI 服务层、Pydantic、pytest、React、TypeScript、Vitest、Testing Library

---

### Task 1: 锁定 API 的差异化质量规则

**Files:**
- Modify: `api/tests/test_analysis.py`
- Modify: `api/tests/test_llm.py`
- Modify: `api/app/services/analysis.py`

- [ ] **Step 1: 写章节和片段重复时重试的失败测试**

在 `api/tests/test_analysis.py` 增加两个测试。测试构造完整的标准响应，不使用兼容别名，确保质量检查只针对模型明确返回的标题和说明。

```python
@pytest.mark.asyncio
async def test_retries_when_chapter_title_repeats_summary_after_normalization():
    repeated = valid_payload()
    repeated["chapters"][0]["summary"] = " 基础结构。 "
    provider = FakeProvider([repeated, valid_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.chapters[0].summary == "从像素到权重"
    assert provider.calls == 2


@pytest.mark.asyncio
async def test_retries_when_highlight_title_repeats_summary_after_normalization():
    repeated = valid_payload()
    repeated["highlights"][0]["summary"] = " 权重。 "
    provider = FakeProvider([repeated, valid_payload()])

    result = await StructuredAnalysisService(provider).analyze(
        source_segments(), "zh-Hans", duration_ms=2000
    )

    assert result.highlights[0].summary == "权重决定连接强度"
    assert provider.calls == 2
```

- [ ] **Step 2: 运行新测试并确认失败原因**

Run:

```bash
cd api && uv run pytest tests/test_analysis.py::test_retries_when_chapter_title_repeats_summary_after_normalization tests/test_analysis.py::test_retries_when_highlight_title_repeats_summary_after_normalization -v
```

Expected: 两个测试都失败，`provider.calls` 仍为 `1`，证明当前服务接受了重复内容。

- [ ] **Step 3: 写提示词内容的失败测试**

在 `api/tests/test_llm.py` 的分析 Provider 测试附近增加一个捕获系统消息的测试：

```python
@pytest.mark.asyncio
async def test_analysis_prompt_requires_complementary_titles_and_summaries():
    captured = []

    class FakeClient:
        provider = "deepseek"
        model = "deepseek-v4-flash"

        async def complete_json(self, messages):
            captured.extend(messages)
            return {
                "one_line_summary": "总结",
                "summary_points": ["一", "二", "三"],
                "chapters": [
                    {
                        "start_ms": 0,
                        "end_ms": 1000,
                        "title": "设计方向",
                        "summary": "作者演示了如何从参考界面整理情绪板。",
                    }
                ],
                "highlights": [],
            }

    provider = KimiAnalysisProvider(FakeClient())
    await provider.analyze(
        [AnalysisSegment("one", 0, 1000, "Collect references", "收集参考")],
        "zh-Hans",
    )

    system_prompt = captured[0]["content"]
    assert "title names the topic" in system_prompt
    assert "summary adds specific actions, evidence, or conclusions" in system_prompt
    assert "must not repeat" in system_prompt
```

- [ ] **Step 4: 运行提示词测试并确认失败**

Run:

```bash
cd api && uv run pytest tests/test_llm.py::test_analysis_prompt_requires_complementary_titles_and_summaries -v
```

Expected: FAIL，因为现有系统提示词不包含字段职责和禁止重复规则。

- [ ] **Step 5: 实现统一提示词和重复检查**

在 `api/app/services/analysis.py` 定义供 HTTP Provider 和 OpenAI 兼容 Provider 共用的规则：

```python
ANALYSIS_CONTENT_RULES = (
    "A chapter or highlight title names the topic or viewing value briefly. "
    "Its summary adds specific actions, evidence, conclusions, or reasons to watch. "
    "The title and summary must not repeat or paraphrase the same short phrase. "
    "Highlight excerpts must quote the transcript instead of replacing the summary. "
)
```

将该常量加入 `HttpAnalysisProvider` 的 `instructions` 和 `LlmAnalysisProvider` 的 system message。

增加归一化和质量检查函数：

```python
def _comparison_key(value: str) -> str:
    return "".join(character.casefold() for character in value if character.isalnum())


def _validate_distinct_descriptions(
    raw: Mapping[str, Any], payload: AnalysisPayload
) -> None:
    for field_name in ("chapters", "highlights"):
        raw_items = raw.get(field_name, [])
        parsed_items = getattr(payload, field_name)
        if not isinstance(raw_items, Sequence) or isinstance(raw_items, (str, bytes)):
            continue
        for raw_item, parsed_item in zip(raw_items, parsed_items, strict=False):
            if not isinstance(raw_item, Mapping):
                continue
            if "title" not in raw_item or "summary" not in raw_item:
                continue
            if _comparison_key(parsed_item.title) == _comparison_key(parsed_item.summary):
                raise ValueError(f"{field_name} title and summary must be different")
```

在 `StructuredAnalysisService.analyze` 和 `_analyze_chunks` 中，结构与时间戳校验成功后调用 `_validate_distinct_descriptions(raw, payload)`。兼容响应只提供 `text`、`quote` 或 `description` 时跳过该质量检查，继续保持现有解析能力。

- [ ] **Step 6: 运行 API 定向测试**

Run:

```bash
cd api && uv run pytest tests/test_analysis.py tests/test_llm.py -v
```

Expected: PASS。原有 Kimi 和 DeepSeek 别名兼容测试继续通过。

### Task 2: 隐藏侧边栏中的重复说明和摘录

**Files:**
- Modify: `extension/tests/App.test.tsx`
- Modify: `extension/src/sidepanel/App.tsx`

- [ ] **Step 1: 写旧结果重复文字隐藏的失败测试**

在 `extension/tests/App.test.tsx` 增加测试。复用现有的 `createApi`、`createBrowser` 和 `createLlmStore`，让结果中的章节和片段包含重复文字：

```tsx
it("shows repeated title, summary, and excerpts only once", async () => {
  const api = createApi();
  api.getResult.mockResolvedValueOnce({
    ...(await createApi().getResult("job-1")),
    chapters: [
      { start_ms: 0, end_ms: 1000, title: "构建设计系统", summary: "构建设计系统。" },
    ],
    highlights: [
      {
        start_ms: 0,
        end_ms: 1000,
        title: "整理参考界面",
        summary: "整理参考界面。",
        translated_excerpt: "整理参考界面",
        original_excerpt: "整理参考界面",
      },
    ],
  });
  const user = userEvent.setup();
  render(<App api={api} browser={createBrowser()} llmStore={createLlmStore()} pollIntervalMs={1} />);

  await user.click(await screen.findByRole("button", { name: "检查当前视频字幕" }));
  await user.click(screen.getByRole("button", { name: "分析此视频" }));

  expect(await screen.findByText("构建设计系统")).toBeInTheDocument();
  expect(screen.getAllByText(/构建设计系统/)).toHaveLength(1);
  expect(screen.getAllByText(/整理参考界面/)).toHaveLength(1);
});
```

- [ ] **Step 2: 运行组件测试并确认失败**

Run:

```bash
cd extension && pnpm test -- --run tests/App.test.tsx
```

Expected: FAIL，重复文本的匹配数量大于 `1`。

- [ ] **Step 3: 实现展示层去重**

在 `extension/src/sidepanel/App.tsx` 增加两个文件内辅助函数：

```tsx
function comparisonKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}

function distinctText(value: string, visibleValues: string[]): string | null {
  const key = comparisonKey(value);
  if (!key || visibleValues.some((visible) => comparisonKey(visible) === key)) return null;
  return value;
}
```

章节渲染时只在 `summary` 与 `title` 不同时显示 `<small>`。片段渲染时按 `title`、`summary`、`translated_excerpt`、`original_excerpt` 的顺序维护已显示文字，后面的字段与前面重复时不再渲染。

- [ ] **Step 4: 增加不同内容正常展示的断言**

在同一测试文件增加一条测试或扩充现有结果测试，确认 `title="输入层"` 和 `summary="从像素开始"` 都存在，防止去重逻辑误删正常内容。

- [ ] **Step 5: 运行扩展定向测试和类型检查**

Run:

```bash
cd extension && pnpm test -- --run tests/App.test.tsx
cd extension && pnpm typecheck
```

Expected: 两条命令均通过，无 TypeScript 错误。

### Task 3: 完整回归和维护记录

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-distinct-analysis-text-design.md`，仅在实现与设计发生偏差时更新
- Create: `docs/superpowers/decisions/2026-08-06-distinct-analysis-text.md`

- [ ] **Step 1: 运行完整 API 测试**

Run:

```bash
cd api && uv run pytest -q
```

Expected: 全部测试通过。

- [ ] **Step 2: 运行完整扩展测试和构建**

Run:

```bash
cd extension && pnpm test -- --run
cd extension && pnpm typecheck
cd extension && pnpm build
```

Expected: 测试、类型检查和构建全部通过。

- [ ] **Step 3: 检查补丁质量**

Run:

```bash
git diff --check
git diff -- api/app/services/analysis.py api/tests/test_analysis.py api/tests/test_llm.py extension/src/sidepanel/App.tsx extension/tests/App.test.tsx
```

Expected: `git diff --check` 无输出，差异仅包含本需求相关修改。

- [ ] **Step 4: 记录决策与回退方式**

创建 `docs/superpowers/decisions/2026-08-06-distinct-analysis-text.md`，内容包括：

```markdown
# 摘要文本差异化决策

提示词负责生成质量，API 拒绝模型明确返回的重复标题和说明，扩展负责隐藏历史数据中的重复字段。接口和数据库保持不变。

没有采用只改提示词的方案，因为模型仍可能忽略约束。也没有只做前端隐藏，因为它无法改善新摘要的内容质量。

若严格检查导致模型失败率升高，可以撤回 API 的重复拒绝逻辑，保留提示词和前端去重。
```

- [ ] **Step 5: 手动验证侧边栏**

重新构建并在 `chrome://extensions` 重新加载解压缩扩展。打开此前出现重复内容的视频，先确认旧结果只显示一次重复文字，再点击“重新分析”，确认新结果的章节标题与说明表达不同信息，片段标题、说明和字幕摘录也不再重复。

本计划不执行 Git commit。工作区包含用户已有修改，最终只报告本次涉及的文件和验证结果。
