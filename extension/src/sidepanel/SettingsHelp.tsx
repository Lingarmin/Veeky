import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

/** Icon-only settings help; hovering previews it and clicking pins it open. */
export function SettingsHelp() {
  const [mode, setMode] = useState<"closed" | "preview" | "pinned">("closed");
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = mode !== "closed";

  function clearHideTimer() {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }

  function preview() {
    clearHideTimer();
    setMode((current) => current === "closed" ? "preview" : current);
  }

  function leave() {
    clearHideTimer();
    // 留出从图标跨过间隙移入浮层的时间，避免阅读时闪退。
    hideTimer.current = setTimeout(() => {
      setMode((current) => current === "preview" && !panelRef.current?.contains(document.activeElement) ? "closed" : current);
    }, 150);
  }

  useEffect(() => clearHideTimer, []);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !anchorRef.current?.contains(event.target)) {
        clearHideTimer();
        setMode("closed");
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      clearHideTimer();
      if (panelRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
      setMode("closed");
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const button = buttonRef.current;
      const panel = panelRef.current;
      if (!button || !panel) return;
      const rect = button.getBoundingClientRect();
      const margin = 12;
      const gap = 8;
      const above = Math.max(0, rect.top - margin - gap);
      const below = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
      const placeBelow = below >= Math.min(panel.scrollHeight + 2, 360) || below >= above;
      panel.style.maxHeight = `${Math.min(360, Math.max(1, placeBelow ? below : above))}px`;
      const { width, height } = panel.getBoundingClientRect();
      const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
      const top = Math.max(margin, placeBelow ? rect.bottom + gap : rect.top - height - gap);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);

  return (
    <div className="settings-help-anchor" ref={anchorRef} onMouseEnter={preview} onMouseLeave={leave}>
      <button ref={buttonRef} className="settings-help-toggle" type="button" aria-label="使用说明" aria-haspopup="dialog" aria-expanded={open} aria-controls="llm-settings-help" onClick={() => {
        clearHideTimer();
        setMode((current) => current === "pinned" ? "closed" : "pinned");
      }}>
        <Info size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <section ref={panelRef} id="llm-settings-help" className="settings-help" role="dialog" aria-label="LLM 使用说明" tabIndex={0} hidden={!open}>
        <h2>Key 保存</h2>
        <p>默认仅本次使用，浏览器会话结束后需要重新填写 Key。勾选后保存在此浏览器本机，不参与同步；取消勾选并保存会移除已记住的 Key。</p>
        <h2>测试与费用</h2>
        <p>测试会从插件直连所选官方服务发起最小 JSON 请求，可能产生少量费用；测试成功不保证长任务一定完成。</p>
        <h2>数据与隐私</h2>
        <p>API Key 仅由扩展内部通过 HTTPS 发送给对应官方服务商，不会交给视频网页或 Veeky 服务器。</p>
        <p>字幕会发送给你选择的官方 LLM 服务商，用于翻译和摘要，费用由你的服务商账户承担。</p>
      </section>
    </div>
  );
}
