import type { ContentRef } from "./types";

const MAX_X_SOURCE_CONTENT_ID = 18_446_744_073_709_551_615n;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const X_STATUS_PATH_PATTERN = /^\/[^/]+\/status\/([0-9]+)(?:\/video\/([0-9]+))?\/?$/;

export interface XStatusRoute {
  sourceContentId: string;
  mediaIndex: number | null;
}

export function parseContentRef(url?: string): ContentRef | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
  ) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    const match = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname);
    return match ? youtubeRef(match[1]) : null;
  }

  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (parsed.pathname === "/watch") {
      return youtubeRef(parsed.searchParams.get("v"));
    }
    const match = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname);
    return match ? youtubeRef(match[1]) : null;
  }

  if (host !== "x.com" && host !== "www.x.com") return null;
  const route = xStatusRouteFromUrl(parsed);
  if (!route || route.mediaIndex === null) return null;

  return {
    platform: "x",
    sourceContentId: route.sourceContentId,
    mediaIndex: route.mediaIndex,
  };
}

export function parseXStatusRoute(
  candidate: string | undefined,
  baseUrl?: string,
): XStatusRoute | null {
  if (!candidate) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate, baseUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
    || (parsed.hostname !== "x.com" && parsed.hostname !== "www.x.com")
  ) {
    return null;
  }
  return xStatusRouteFromUrl(parsed);
}

export function contentKey(ref: ContentRef): string {
  return `${ref.platform}:${ref.sourceContentId}:${ref.mediaIndex}`;
}

function youtubeRef(candidate: string | null): ContentRef | null {
  if (!candidate || !YOUTUBE_ID_PATTERN.test(candidate)) return null;
  return { platform: "youtube", sourceContentId: candidate, mediaIndex: 1 };
}

function isValidXSourceContentId(candidate: string): boolean {
  if (candidate.length > 20) return false;
  const value = BigInt(candidate);
  return value > 0n && value <= MAX_X_SOURCE_CONTENT_ID;
}

function xStatusRouteFromUrl(url: URL): XStatusRoute | null {
  const match = X_STATUS_PATH_PATTERN.exec(url.pathname);
  if (!match || !isValidXSourceContentId(match[1])) return null;
  if (!match[2]) return { sourceContentId: match[1], mediaIndex: null };

  const mediaIndex = Number(match[2]);
  if (!Number.isSafeInteger(mediaIndex) || mediaIndex < 1 || mediaIndex > MAX_DATABASE_INTEGER) {
    return null;
  }
  return { sourceContentId: match[1], mediaIndex };
}
