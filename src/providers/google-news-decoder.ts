import { logger } from "@/lib/logger";

// Google News RSS gives wrapper URLs like:
//   https://news.google.com/rss/articles/CBMivwFB...?oc=5
// The path segment after `/articles/` is URL-safe base64 of a small protobuf
// payload. There are two formats in the wild:
//
//   OLD (pre-Aug 2024): the protobuf field 2 is a length-delimited string
//     containing the destination URL directly. Decoding by hand works.
//
//   NEW (Aug 2024+): the protobuf field 2 starts with "AU_yqL..." — that's
//     an article id token, NOT a URL. To resolve, you have to:
//       a) Fetch the wrapper page, scrape `data-n-a-sg` (signature) and
//          `data-n-a-ts` (timestamp) from the HTML
//       b) POST to https://news.google.com/_/DotsSplashUi/data/batchexecute
//          with the id+sig+ts → get back the destination URL
//
// We try old format first, fall back to new. Cache results in-memory so we
// only pay once per URL per process. Failure returns null → caller keeps the
// wrapper URL (Jina then 451s and snippet is the only material).

const log = logger.child({ provider: "google-news-decoder" });

const cache = new Map<string, string | null>();

export async function resolveGoogleNewsUrl(wrapperUrl: string): Promise<string | null> {
  if (!wrapperUrl.includes("news.google.com")) return wrapperUrl;
  if (cache.has(wrapperUrl)) return cache.get(wrapperUrl) ?? null;

  // 1. Pull the base64 token from the path.
  const match = wrapperUrl.match(/\/articles\/([^?]+)/);
  if (!match) {
    cache.set(wrapperUrl, null);
    return null;
  }
  const token = match[1];

  // 2. Try the OLD format first — direct decode.
  const direct = tryDirectDecode(token);
  if (direct) {
    cache.set(wrapperUrl, direct);
    return direct;
  }

  // 3. NEW format — call batchexecute. This is fragile (internal Google API)
  // so we wrap defensively.
  try {
    const resolved = await resolveViaBatchExecute(wrapperUrl, token);
    cache.set(wrapperUrl, resolved);
    return resolved;
  } catch (err) {
    log.warn({ wrapperUrl: wrapperUrl.slice(0, 80), err: String(err).slice(0, 200) }, "batchexecute failed");
    cache.set(wrapperUrl, null);
    return null;
  }
}

// ─── OLD format ────────────────────────────────────────────────────────────

function tryDirectDecode(token: string): string | null {
  try {
    const buf = base64UrlDecode(token);
    // Quick & dirty protobuf: look for the first length-delimited string that
    // looks like an http(s) URL.
    const url = extractFirstUrl(buf);
    if (url && url.startsWith("http")) return url;
    return null;
  } catch {
    return null;
  }
}

function base64UrlDecode(s: string): Buffer {
  // URL-safe base64 → standard base64
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function extractFirstUrl(buf: Buffer): string | null {
  // Scan for "http" prefix as a literal byte sequence. If found, read until
  // a control byte or non-URL char.
  for (let i = 0; i < buf.length - 4; i++) {
    if (
      buf[i] === 0x68 && // h
      buf[i + 1] === 0x74 && // t
      buf[i + 2] === 0x74 && // t
      buf[i + 3] === 0x70 // p
    ) {
      let end = i;
      while (end < buf.length) {
        const c = buf[end];
        // Stop at low control bytes, DEL, or anything > 0x7E (extended).
        if (c < 0x20 || c > 0x7e) break;
        end += 1;
      }
      const candidate = buf.slice(i, end).toString("utf8");
      // Sanity check: must be at least a domain.
      if (/^https?:\/\/[^\s]+\.[a-z]{2,}/i.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// ─── NEW format (batchexecute) ─────────────────────────────────────────────

const BE_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const FETCH_TIMEOUT_MS = 8_000;

async function resolveViaBatchExecute(
  wrapperUrl: string,
  token: string,
): Promise<string | null> {
  // Step 1: scrape signature + timestamp from the article HTML.
  const html = await fetchWithTimeout(wrapperUrl, FETCH_TIMEOUT_MS);
  if (!html) return null;

  const sigMatch = html.match(/data-n-a-sg="([^"]+)"/);
  const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sigMatch || !tsMatch) return null;

  const signature = sigMatch[1];
  const timestamp = tsMatch[1];

  // Step 2: POST to batchexecute with the article id + sig + ts.
  // The body shape is a quoted Google internal RPC envelope.
  const inner = JSON.stringify([
    "Fbv4je",
    `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${token}","${timestamp}","${signature}"]`,
  ]);
  const body = `f.req=${encodeURIComponent(`[[${inner}]]`)}`;

  const res = await fetch(BE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const text = await res.text();

  // The response is a Google internal RPC stream that starts with )]}'\n
  // followed by length-prefixed JSON chunks. The destination URL appears
  // inside the third chunk's payload. Pull it out with a permissive regex.
  const urlMatch = text.match(/"(https?:\/\/[^"\s]+)"/);
  if (!urlMatch) return null;
  let candidate = urlMatch[1];
  // The response JSON-escapes things — trim trailing backslash that the
  // regex captures as part of the URL, and unescape common sequences.
  candidate = candidate.replace(/\\+$/, "");
  candidate = candidate.replace(/\\u002F/g, "/");
  if (candidate.includes("news.google.com")) return null; // unresolved
  return candidate;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
