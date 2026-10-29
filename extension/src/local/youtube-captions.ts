import { parseContentRef } from "../shared/content";
import type { CaptionTrack, TranscriptSegment } from "../shared/types";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export interface YouTubeCaptionTrack extends CaptionTrack {
  baseUrl: string;
}

interface CaptionRow {
  startMs: number;
  durationMs: number;
  original: string;
}

/** Normalize a YouTube video ID or supported watch/short/share URL. */
export function normalizeYouTubeVideoId(input: string): string | null {
  const candidate = input.trim();
  if (VIDEO_ID_PATTERN.test(candidate)) return candidate;

  const ref = parseContentRef(candidate);
  return ref?.platform === "youtube" ? ref.sourceContentId : null;
}

/**
 * Pick a readable track, honoring an explicit language preference. Without a
 * preference, prefer creator-provided captions, then the first available
 * auto-generated track.
 */
export function selectYouTubeCaptionTrack(
  tracks: readonly YouTubeCaptionTrack[],
  preferredLanguage?: string,
): YouTubeCaptionTrack | null {
  const usable = tracks.filter((track) =>
    isYouTubeCaptionUrl(track.baseUrl)
    && typeof track.languageCode === "string"
    && track.languageCode.length > 0,
  );
  if (usable.length === 0) return null;

  if (preferredLanguage?.trim()) {
    const preferred = normalizeLanguageCode(preferredLanguage);
    const exactMatch = usable.filter((track) => normalizeLanguageCode(track.languageCode) === preferred);
    if (exactMatch.length > 0) return preferHumanTrack(exactMatch);

    const baseLanguage = preferred.split("-")[0];
    const baseMatches = usable.filter((track) => normalizeLanguageCode(track.languageCode).split("-")[0] === baseLanguage);
    if (baseMatches.length > 0) return preferHumanTrack(baseMatches);
  }

  return preferHumanTrack(usable);
}

/** Convert non-negative seconds to rounded integer milliseconds. */
export function secondsToMilliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError("Seconds must be a finite, non-negative number");
  }
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError("Timestamp exceeds the supported millisecond range");
  }
  return milliseconds;
}

/** Parse YouTube JSON3 or timed-text XML into timestamped transcript rows. */
export function parseYouTubeCaptions(payload: string, video: string): TranscriptSegment[] {
  const videoId = normalizeYouTubeVideoId(video);
  if (!videoId || typeof payload !== "string") return [];

  const trimmed = payload.trim();
  if (!trimmed) return [];

  let rows: CaptionRow[];
  if (trimmed.startsWith("{")) {
    rows = parseJson3(trimmed);
  } else if (trimmed.startsWith("<")) {
    rows = parseTimedTextXml(trimmed);
  } else {
    return [];
  }

  return toTranscriptSegments(rows, videoId);
}

function normalizeLanguageCode(code: string): string {
  return code.trim().replaceAll("_", "-").toLowerCase();
}

function isYouTubeCaptionUrl(candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && (hostname === "youtube.com" || hostname.endsWith(".youtube.com"));
  } catch {
    return false;
  }
}

function preferHumanTrack(tracks: YouTubeCaptionTrack[]): YouTubeCaptionTrack {
  return tracks.find((track) => !track.isGenerated) ?? tracks[0]!;
}

function parseJson3(payload: string): CaptionRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.events)) return [];

  const events = parsed.events;
  const rows: CaptionRow[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isRecord(event) || !Number.isFinite(event.tStartMs) || !Array.isArray(event.segs)) continue;

    const startMs = nonNegativeRounded(event.tStartMs);
    if (startMs === null) continue;

    const original = event.segs
      .filter(isRecord)
      .map((segment) => typeof segment.utf8 === "string" ? segment.utf8 : "")
      .join("");
    const text = normalizeCaptionText(original);
    if (!text) continue;

    const explicitDuration = nonNegativeRounded(event.dDurationMs);
    const nextStartMs = findNextJsonStart(events, index + 1);
    const durationMs = explicitDuration ?? (nextStartMs === null ? 0 : Math.max(0, nextStartMs - startMs));
    rows.push({ startMs, durationMs, original: text });
  }

  return rows;
}

function findNextJsonStart(events: unknown[], fromIndex: number): number | null {
  for (let index = fromIndex; index < events.length; index += 1) {
    const event = events[index];
    if (!isRecord(event)) continue;
    const startMs = nonNegativeRounded(event.tStartMs);
    if (startMs !== null) return startMs;
  }
  return null;
}

function parseTimedTextXml(xml: string): CaptionRow[] {
  if (!isWellFormedXml(xml)) return [];

  const rows: CaptionRow[] = [];
  const cuePattern = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of xml.matchAll(cuePattern)) {
    const tagName = match[1]!.toLowerCase();
    const attributes = parseXmlAttributes(match[2]!);
    const startValue = tagName === "p" ? attributes.t : attributes.start;
    const durationValue = tagName === "p" ? attributes.d : attributes.dur;
    const start = parseFiniteNumber(startValue);
    const duration = parseFiniteNumber(durationValue);
    if (start === null || duration === null || start < 0 || duration < 0) continue;

    let startMs: number;
    let durationMs: number;
    try {
      startMs = tagName === "p" ? Math.round(start) : secondsToMilliseconds(start);
      durationMs = tagName === "p" ? Math.round(duration) : secondsToMilliseconds(duration);
    } catch {
      continue;
    }
    const original = normalizeCaptionText(decodeXmlEntities(match[3]!
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, "")));
    if (original) rows.push({ startMs, durationMs, original });
  }

  return rows;
}

function isWellFormedXml(xml: string): boolean {
  const stack: string[] = [];
  const tokenPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?[A-Za-z_][\w:.-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  let lastIndex = 0;
  let rootCount = 0;

  for (const match of xml.matchAll(tokenPattern)) {
    const between = xml.slice(lastIndex, match.index);
    if (between.includes("<")) return false;
    lastIndex = match.index! + match[0].length;

    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!")) {
      if ((token.startsWith("<!--") && !token.endsWith("-->")) || (token.startsWith("<?") && !token.endsWith("?>")) || (token.startsWith("<![CDATA[") && !token.endsWith("]]>"))) return false;
      continue;
    }

    const closing = /^<\//.test(token);
    const selfClosing = /\/\s*>$/.test(token);
    const name = /^<\/?([A-Za-z_][\w:.-]*)/.exec(token)?.[1];
    if (!name) return false;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else if (!selfClosing) {
      if (stack.length === 0) rootCount += 1;
      stack.push(name);
    } else if (stack.length === 0) {
      rootCount += 1;
    }
  }

  const remaining = xml.slice(lastIndex);
  return !remaining.includes("<") && stack.length === 0 && rootCount === 1;
}

function parseXmlAttributes(attributes: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
  for (const match of attributes.matchAll(pattern)) result[match[1]!] = decodeXmlEntities(match[3]!);
  return result;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";

    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}

function toTranscriptSegments(rows: CaptionRow[], videoId: string): TranscriptSegment[] {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const textHash = stableTextHash(row.original);
    const identity = `${row.startMs}:${textHash}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return {
      id: `youtube:${videoId}:${row.startMs}:${textHash}:${occurrence}`,
      startMs: row.startMs,
      durationMs: row.durationMs,
      original: row.original,
      translated: null,
    };
  });
}

function stableTextHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function normalizeCaptionText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function nonNegativeRounded(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
