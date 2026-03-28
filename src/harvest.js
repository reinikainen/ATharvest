import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_API_BASE_URLS = [
  "https://api.bsky.app",
  "https://public.api.bsky.app",
];
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_REQUESTS = 64;
const DEFAULT_MIN_WINDOW_MS = 15 * 60 * 1000;

export function normalizeHashtag(input) {
  if (typeof input !== "string") {
    throw new Error("Hashtag must be a string.");
  }

  const trimmed = input.trim();
  const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  if (!withoutHash) {
    throw new Error("Hashtag cannot be empty.");
  }

  const canonicalTag = withoutHash.toLowerCase();

  return {
    input: trimmed,
    tag: canonicalTag,
    display: `#${canonicalTag}`,
    slug: canonicalTag.replace(/[^a-z0-9._-]+/g, "-"),
  };
}

export async function harvestHashtagLinks(options) {
  const {
    hashtag,
    days,
    now = new Date(),
    fetchImpl = fetch,
    apiBaseUrl,
    auth,
    maxRequests = DEFAULT_MAX_REQUESTS,
    minWindowMs = DEFAULT_MIN_WINDOW_MS,
    pageSize = DEFAULT_PAGE_SIZE,
  } = options;

  if (!hashtag?.tag || !hashtag?.display) {
    throw new Error("Normalized hashtag is required.");
  }

  if (!Number.isInteger(days) || days < 1) {
    throw new Error("Days must be a positive integer.");
  }

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const posts = [];
  const seenPostUris = new Set();
  const authContext = await createAuthContext({ auth, fetchImpl });
  const apiBaseUrls = resolveApiBaseUrls(apiBaseUrl, authContext);
  let requestsMade = 0;
  let complete = true;
  let apiBaseUrlUsed = apiBaseUrls[0];
  const windows = [{ since: cutoff, until: now }];

  while (windows.length > 0 && requestsMade < maxRequests) {
    const window = windows.shift();
    const page = await searchPostsPage({
      fetchImpl,
      apiBaseUrls,
      hashtag,
      since: window.since,
      until: window.until,
      limit: pageSize,
      headers: authContext?.headers,
    });

    requestsMade += 1;
    apiBaseUrlUsed = page.apiBaseUrl ?? apiBaseUrlUsed;

    const pagePosts = Array.isArray(page.posts) ? page.posts : [];

    if (pagePosts.length >= pageSize) {
      const windowMs = window.until.getTime() - window.since.getTime();
      if (windowMs > minWindowMs) {
        const midpoint = new Date(window.since.getTime() + Math.floor(windowMs / 2));
        const nextStart = new Date(midpoint.getTime() + 1);
        windows.unshift(
          { since: nextStart, until: window.until },
          { since: window.since, until: midpoint },
        );
        continue;
      }

      complete = false;
    }

    for (const post of pagePosts) {
      if (!postMatchesHashtag(post, hashtag)) {
        continue;
      }

      const postDate = getPostDate(post);
      if (!postDate || postDate < cutoff || postDate > now) {
        continue;
      }

      if (seenPostUris.has(post.uri)) {
        continue;
      }

      seenPostUris.add(post.uri);
      posts.push(post);
    }
  }

  if (windows.length > 0) {
    complete = false;
  }

  const entries = flattenHarvestedEntries(posts);

  return {
    hashtag: hashtag.display,
    tag: hashtag.tag,
    generatedAt: now.toISOString(),
    since: cutoff.toISOString(),
    until: now.toISOString(),
    postCount: posts.length,
    linkCount: entries.length,
    entries,
    complete,
    apiBaseUrl: apiBaseUrlUsed,
  };
}

export async function searchPostsPage(options) {
  const { fetchImpl, apiBaseUrls, hashtag, since, until, limit, headers } = options;
  const failures = [];

  for (const apiBaseUrl of apiBaseUrls) {
    const url = new URL("/xrpc/app.bsky.feed.searchPosts", apiBaseUrl);

    url.searchParams.set("q", hashtag.display);
    url.searchParams.set("tag", hashtag.tag);
    url.searchParams.set("sort", "latest");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("since", since.toISOString());
    url.searchParams.set("until", until.toISOString());

    try {
      const data = await requestJson(url, fetchImpl, {
        headers,
      });
      return {
        ...data,
        apiBaseUrl,
      };
    } catch (error) {
      failures.push(`${apiBaseUrl} -> ${error.message}`);
    }
  }

  throw new Error(`All Bluesky API hosts failed: ${failures.join("; ")}`);
}

async function requestJson(url, fetchImpl, requestOptions = {}) {
  if (fetchImpl && fetchImpl !== fetch) {
    return requestJsonWithFetch(url, fetchImpl, requestOptions);
  }

  try {
    return await requestJsonWithCurl(url, requestOptions);
  } catch (error) {
    if (!shouldFallbackToFetch(error)) {
      throw error;
    }
  }

  return requestJsonWithFetch(url, fetchImpl ?? fetch, requestOptions);
}

function shouldFallbackToFetch(error) {
  return error?.code === "ENOENT";
}

async function requestJsonWithCurl(url, requestOptions = {}) {
  const method = requestOptions.method ?? "GET";
  const headers = {
    accept: "application/json",
    "user-agent": "atharvest/0.1.0",
    ...(requestOptions.headers ?? {}),
  };

  const args = [
    "--ipv4",
    "--silent",
    "--show-error",
    "--location",
    "--retry",
    "2",
    "--retry-all-errors",
    "--max-time",
    "20",
    "--request",
    method,
  ];

  for (const [name, value] of Object.entries(headers)) {
    args.push("--header", `${name}: ${value}`);
  }

  if (requestOptions.body !== undefined) {
    args.push("--data", requestOptions.body);
  }

  args.push("--write-out", "\nATHARVEST_STATUS:%{http_code}", url.toString());

  const { stdout } = await execFile("curl", args);

  const marker = "\nATHARVEST_STATUS:";
  const markerIndex = stdout.lastIndexOf(marker);

  if (markerIndex === -1) {
    throw new Error("curl response did not include an HTTP status marker.");
  }

  const body = stdout.slice(0, markerIndex);
  const status = Number.parseInt(stdout.slice(markerIndex + marker.length).trim(), 10);

  if (!Number.isInteger(status)) {
    throw new Error("curl response included an invalid HTTP status.");
  }

  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}: ${truncateBody(body)}`);
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Invalid JSON from Bluesky API: ${error.message}`);
  }
}

async function requestJsonWithFetch(url, fetchImpl, requestOptions = {}) {
  const response = await fetchImpl(url, {
    method: requestOptions.method ?? "GET",
    headers: {
      accept: "application/json",
      "user-agent": "atharvest/0.1.0",
      ...(requestOptions.headers ?? {}),
    },
    body: requestOptions.body,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`HTTP ${response.status}: ${truncateBody(body)}`);
  }

  return response.json();
}

async function safeReadBody(response) {
  try {
    const text = await response.text();
    return text || response.statusText;
  } catch {
    return response.statusText;
  }
}

function truncateBody(body) {
  return String(body).replace(/\s+/g, " ").trim().slice(0, 200);
}

export function postMatchesHashtag(post, hashtag) {
  const tagLower = hashtag.tag.toLowerCase();
  const recordTags = Array.isArray(post?.record?.tags)
    ? post.record.tags.map((value) => String(value).toLowerCase())
    : [];

  if (recordTags.includes(tagLower)) {
    return true;
  }

  const text = typeof post?.record?.text === "string" ? post.record.text : "";
  return hashtagRegex(tagLower).test(text);
}

function hashtagRegex(tag) {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])#${escapeRegex(tag)}(?![\\p{L}\\p{N}_])`, "iu");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getPostDate(post) {
  const raw = post?.record?.createdAt ?? post?.indexedAt;
  if (!raw) {
    return null;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

export function flattenHarvestedEntries(posts) {
  return posts.flatMap((post) => {
    const seen = new Set();
    const links = extractLinksFromPost(post).filter((url) => {
      if (seen.has(url)) {
        return false;
      }
      seen.add(url);
      return true;
    });

    return links.map((url) => ({
      url,
      postUrl: buildPostUrl(post),
      postUri: post.uri,
      authorHandle: post.author?.handle ?? null,
      authorDid: post.author?.did ?? null,
      authorDisplayName: post.author?.displayName ?? null,
      createdAt: post.record?.createdAt ?? post.indexedAt ?? null,
      text: post.record?.text ?? "",
    }));
  });
}

export function extractLinksFromPost(post) {
  const links = new Set();

  addFacetLinks(post?.record?.facets, links);
  addEmbedLinks(post?.embed, links);
  addEmbedLinks(post?.record?.embed, links);
  addTextLinks(post?.record?.text, links);

  return [...links];
}

function addFacetLinks(facets, links) {
  if (!Array.isArray(facets)) {
    return;
  }

  for (const facet of facets) {
    if (!Array.isArray(facet?.features)) {
      continue;
    }

    for (const feature of facet.features) {
      const type = feature?.$type;
      if (type === "app.bsky.richtext.facet#link" && typeof feature.uri === "string") {
        links.add(feature.uri);
      }
    }
  }
}

function addEmbedLinks(embed, links) {
  if (!embed || typeof embed !== "object") {
    return;
  }

  walkEmbed(embed, (node) => {
    if (typeof node.uri === "string" && looksLikeHttpUrl(node.uri)) {
      links.add(node.uri);
    }

    if (typeof node.url === "string" && looksLikeHttpUrl(node.url)) {
      links.add(node.url);
    }
  });
}

function walkEmbed(value, visit) {
  if (!value || typeof value !== "object") {
    return;
  }

  visit(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walkEmbed(item, visit);
    }
    return;
  }

  for (const child of Object.values(value)) {
    walkEmbed(child, visit);
  }
}

function addTextLinks(text, links) {
  if (typeof text !== "string" || !text) {
    return;
  }

  const matches = text.matchAll(/https?:\/\/[^\s<>()]+/gi);

  for (const match of matches) {
    links.add(stripTrailingPunctuation(match[0]));
  }
}

function stripTrailingPunctuation(url) {
  return url.replace(/[.,!?;:]+$/u, "");
}

function looksLikeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function buildPostUrl(post) {
  const { did, rkey } = parseAtUri(post?.uri);
  const actor = post?.author?.handle ?? post?.author?.did ?? did;

  if (!actor || !rkey) {
    throw new Error(`Unable to build post URL for ${post?.uri ?? "unknown post"}.`);
  }

  return `https://bsky.app/profile/${encodeURIComponent(actor)}/post/${encodeURIComponent(rkey)}`;
}

export function parseAtUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("at://")) {
    throw new Error(`Invalid AT URI: ${uri ?? "undefined"}`);
  }

  const [, rest] = uri.split("at://");
  const [did, collection, rkey] = rest.split("/");

  if (!did || collection !== "app.bsky.feed.post" || !rkey) {
    throw new Error(`Unsupported AT URI: ${uri}`);
  }

  return { did, collection, rkey };
}

export function buildOutputFilename(tag, now = new Date()) {
  const timestamp = now.toISOString().replace(/[:]/g, "-").replace(/\.\d{3}Z$/, "Z");
  return `atharvest-${tag.toLowerCase()}-${timestamp}.md`;
}

async function createAuthContext(options) {
  const { auth, fetchImpl } = options;

  if (!auth?.identifier || !auth?.password) {
    return null;
  }

  const session = await requestJson(
    new URL("/xrpc/com.atproto.server.createSession", "https://bsky.social"),
    fetchImpl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        identifier: auth.identifier,
        password: auth.password,
      }),
    },
  );

  if (!session?.accessJwt) {
    throw new Error("Authenticated Bluesky session did not return an access token.");
  }

  return {
    apiBaseUrls: ["https://bsky.social"],
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
    },
  };
}

function resolveApiBaseUrls(apiBaseUrl, authContext) {
  if (apiBaseUrl) {
    return [apiBaseUrl];
  }

  if (authContext?.apiBaseUrls) {
    return authContext.apiBaseUrls;
  }

  return DEFAULT_API_BASE_URLS;
}

export function renderMarkdown(result) {
  const lines = [
    `# AT Harvester Report: ${result.hashtag}`,
    "",
    `- Generated: ${result.generatedAt}`,
    `- Window start: ${result.since}`,
    `- Window end: ${result.until}`,
    `- Posts scanned: ${result.postCount}`,
    `- Links found: ${result.linkCount}`,
    `- Search source: ${result.apiBaseUrl}`,
    `- Result completeness: ${result.complete ? "complete" : "partial"}`,
    "",
  ];

  if (result.entries.length === 0) {
    lines.push("No links found.");
    lines.push("");
    return `${lines.join("\n")}`;
  }

  lines.push("## Links");
  lines.push("");

  for (const entry of result.entries) {
    const author = entry.authorHandle
      ? `@${entry.authorHandle}`
      : (entry.authorDid ?? "unknown-author");
    lines.push(`- [${entry.url}](${entry.url})`);
    lines.push(`  Source: [${author}](${entry.postUrl})`);
    lines.push(`  Posted: ${entry.createdAt ?? "unknown"}`);
  }

  lines.push("");
  return `${lines.join("\n")}`;
}
