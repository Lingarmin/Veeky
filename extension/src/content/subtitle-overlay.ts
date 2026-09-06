import type { TranscriptSegment } from "../shared/types";

type SubtitleSegment = Pick<TranscriptSegment, "startMs" | "durationMs" | "translated">;

export function findActiveSubtitle(
  currentTimeMs: number,
  segments: readonly SubtitleSegment[],
): string | null {
  let low = 0;
  let high = segments.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (segments[middle].startMs <= currentTimeMs) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate < 0) return null;
  const segment = segments[candidate];
  return currentTimeMs < segment.startMs + segment.durationMs
    ? segment.translated
    : null;
}

export class SubtitleOverlay {
  private video: HTMLVideoElement | null = null;
  private container: HTMLElement | null = null;
  private overlay: HTMLDivElement | null = null;
  private segments: readonly SubtitleSegment[] = [];
  private observer: MutationObserver | null = null;
  private frameId: number | null = null;

  constructor(private readonly pageDocument: Document = document) {}

  mount(video: HTMLVideoElement, segments: readonly SubtitleSegment[]): void {
    this.clear();
    this.segments = [...segments].sort((left, right) => left.startMs - right.startMs);
    this.container = subtitleContainer(video);
    this.attach(video);
    this.observer = new MutationObserver(() => {
      if (this.video?.isConnected) return;
      const replacement = this.container?.querySelector<HTMLVideoElement>("video");
      if (replacement) this.attach(replacement);
    });
    this.observer.observe(this.container, { childList: true, subtree: true });
    this.scheduleFrame();
  }

  clear(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.frameId !== null) {
      this.pageDocument.defaultView?.cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.video?.removeEventListener("timeupdate", this.update);
    this.video = null;
    this.overlay?.remove();
    this.overlay = null;
    this.container = null;
  }

  destroy(): void {
    this.clear();
  }

  private attach(video: HTMLVideoElement): void {
    this.video?.removeEventListener("timeupdate", this.update);
    this.video = video;
    const container = this.container ?? subtitleContainer(video);
    for (const duplicate of container.querySelectorAll(".veeky-subtitle-overlay")) {
      duplicate.remove();
    }
    const overlay = this.pageDocument.createElement("div");
    overlay.className = "veeky-subtitle-overlay";
    Object.assign(overlay.style, {
      position: "absolute",
      left: "8%",
      right: "8%",
      bottom: "10%",
      zIndex: "2147483647",
      display: "-webkit-box",
      overflow: "hidden",
      WebkitBoxOrient: "vertical",
      WebkitLineClamp: "2",
      color: "#fff",
      fontFamily: "system-ui, sans-serif",
      fontSize: "20px",
      fontWeight: "600",
      lineHeight: "1.35",
      textAlign: "center",
      textShadow: "0 1px 2px #000, 0 2px 8px #000",
      pointerEvents: "none",
    });
    container.append(overlay);
    this.overlay = overlay;
    video.addEventListener("timeupdate", this.update);
    this.update();
  }

  private readonly update = (): void => {
    if (!this.video || !this.overlay) return;
    const text = findActiveSubtitle(this.video.currentTime * 1000, this.segments);
    this.overlay.textContent = text ?? "";
    this.overlay.style.visibility = text ? "visible" : "hidden";
  };

  private readonly onFrame = (): void => {
    this.frameId = null;
    this.update();
    this.scheduleFrame();
  };

  private scheduleFrame(): void {
    const pageWindow = this.pageDocument.defaultView;
    if (!pageWindow || this.frameId !== null || !this.overlay) return;
    this.frameId = pageWindow.requestAnimationFrame(this.onFrame);
  }
}

function subtitleContainer(video: HTMLVideoElement): HTMLElement {
  return video.closest<HTMLElement>('[data-testid="videoPlayer"], [data-testid="tweetPhoto"]')
    ?? video.parentElement
    ?? video;
}
