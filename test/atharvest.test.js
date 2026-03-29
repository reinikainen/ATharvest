import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadEnvFile, parseArgs, runCli } from "../src/cli.js";
import {
  buildOutputFilename,
  buildPostUrl,
  extractLinksFromPost,
  harvestHashtagLinks,
  normalizeHashtag,
  parseAtUri,
  renderMarkdown,
  searchPostsPage,
} from "../src/harvest.js";

test("parseArgs accepts required flags", () => {
  assert.deepEqual(parseArgs(["-h", "#atmosphereconf", "-t", "3"]), {
    help: false,
    hashtag: "#atmosphereconf",
    days: 3,
  });
});

test("parseArgs rejects invalid days", () => {
  assert.throws(() => parseArgs(["-h", "#atmosphereconf", "-t", "0"]), {
    message: "Days must be a positive integer.",
  });
});

test("loadEnvFile reads quoted values without overriding existing env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atharvest-env-"));
  const envPath = join(dir, ".env");

  await writeFile(
    envPath,
    [
      "# comment",
      "BLUESKY_IDENTIFIER='from-dotenv.bsky.social'",
      'BLUESKY_APP_PASSWORD="dotenv-password"',
      "ATHARVEST_API_BASE_URL=https://example.invalid # inline comment",
    ].join("\n"),
    "utf8",
  );

  await withEnv(
    {
      BLUESKY_IDENTIFIER: "existing.bsky.social",
      BLUESKY_APP_PASSWORD: undefined,
      ATHARVEST_API_BASE_URL: undefined,
    },
    async () => {
      await loadEnvFile(envPath);

      assert.equal(process.env.BLUESKY_IDENTIFIER, "existing.bsky.social");
      assert.equal(process.env.BLUESKY_APP_PASSWORD, "dotenv-password");
      assert.equal(process.env.ATHARVEST_API_BASE_URL, "https://example.invalid");
    },
  );
});

test("normalizeHashtag strips leading hash and builds display form", () => {
  assert.deepEqual(normalizeHashtag("#AtmosphereConf"), {
    input: "#AtmosphereConf",
    tag: "atmosphereconf",
    display: "#atmosphereconf",
    slug: "atmosphereconf",
  });
});

test("extractLinksFromPost collects links from facets, embeds, and text", () => {
  const post = {
    record: {
      text: "See https://gamma.example/path and repeated https://gamma.example/path",
      facets: [
        {
          features: [
            {
              $type: "app.bsky.richtext.facet#link",
              uri: "https://alpha.example",
            },
          ],
        },
      ],
      embed: {
        $type: "app.bsky.embed.recordWithMedia",
        media: {
          $type: "app.bsky.embed.external",
          external: {
            uri: "https://beta.example",
          },
        },
      },
    },
  };

  assert.deepEqual(extractLinksFromPost(post), [
    "https://alpha.example",
    "https://beta.example",
    "https://gamma.example/path",
  ]);
});

test("parseAtUri and buildPostUrl create Bluesky web URLs", () => {
  const uri = "at://did:plc:123/app.bsky.feed.post/3kxyz";
  assert.deepEqual(parseAtUri(uri), {
    did: "did:plc:123",
    collection: "app.bsky.feed.post",
    rkey: "3kxyz",
  });

  const postUrl = buildPostUrl({
    uri,
    author: {
      handle: "example.bsky.social",
    },
  });

  assert.equal(
    postUrl,
    "https://bsky.app/profile/example.bsky.social/post/3kxyz",
  );
});

test("renderMarkdown formats harvested entries", () => {
  const markdown = renderMarkdown({
    hashtag: "#atmosphereconf",
    generatedAt: "2026-03-28T10:00:00.000Z",
    since: "2026-03-25T10:00:00.000Z",
    until: "2026-03-28T10:00:00.000Z",
    postCount: 1,
    linkCount: 1,
    apiBaseUrl: "https://public.api.bsky.app",
    complete: true,
    entries: [
      {
        url: "https://example.com",
        postUrl: "https://bsky.app/profile/example.bsky.social/post/3kxyz",
        authorHandle: "example.bsky.social",
        createdAt: "2026-03-27T09:00:00.000Z",
      },
    ],
  });

  assert.match(markdown, /# AT Harvester Report: #atmosphereconf/);
  assert.match(markdown, /\[https:\/\/example\.com\]\(https:\/\/example\.com\)/);
  assert.match(markdown, /Source: \[@example\.bsky\.social\]/);
});

test("buildOutputFilename uses deterministic timestamp format", () => {
  const filename = buildOutputFilename(
    "atmosphereconf",
    new Date("2026-03-28T10:00:00.123Z"),
  );

  assert.equal(filename, "atharvest-atmosphereconf-2026-03-28T10-00-00Z.md");
});

test("searchPostsPage falls back to a secondary AppView host", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.origin);

    if (url.origin === "https://public.api.bsky.app") {
      return {
        ok: false,
        status: 403,
        statusText: "Forbidden",
        async text() {
          return "Forbidden";
        },
      };
    }

    return {
      ok: true,
      async json() {
        return { posts: [] };
      },
    };
  };

  const page = await searchPostsPage({
    fetchImpl,
    apiBaseUrls: ["https://public.api.bsky.app", "https://api.bsky.app"],
    hashtag: normalizeHashtag("#atmosphereconf"),
    since: new Date("2026-03-25T00:00:00.000Z"),
    until: new Date("2026-03-28T00:00:00.000Z"),
    limit: 1,
  });

  assert.equal(page.apiBaseUrl, "https://api.bsky.app");
  assert.deepEqual(calls, ["https://public.api.bsky.app", "https://api.bsky.app"]);
});

test("searchPostsPage omits public AppView filters in compatibility mode", async () => {
  let requestUrl;
  const fetchImpl = async (url) => {
    requestUrl = url;
    return {
      ok: true,
      async json() {
        return { posts: [] };
      },
    };
  };

  await searchPostsPage({
    fetchImpl,
    apiBaseUrls: ["https://public.api.bsky.app"],
    hashtag: normalizeHashtag("#atconference"),
    since: new Date("2026-03-27T00:00:00.000Z"),
    until: new Date("2026-03-29T00:00:00.000Z"),
    limit: 25,
    searchMode: "public-compat",
  });

  assert.equal(requestUrl.searchParams.get("q"), "#atconference");
  assert.equal(requestUrl.searchParams.get("sort"), "latest");
  assert.equal(requestUrl.searchParams.get("limit"), "25");
  assert.equal(requestUrl.searchParams.has("tag"), false);
  assert.equal(requestUrl.searchParams.has("since"), false);
  assert.equal(requestUrl.searchParams.has("until"), false);
});

test("harvestHashtagLinks marks anonymous search as partial when public results are truncated", async () => {
  const now = new Date("2026-03-29T10:00:00.000Z");
  let requestUrl;
  const fetchImpl = async (url) => {
    requestUrl = url;
    return {
      ok: true,
      async json() {
        return {
          cursor: "opaque-cursor",
          posts: [
            {
              uri: "at://did:plc:123/app.bsky.feed.post/3kxyz",
              indexedAt: "2026-03-29T09:00:00.000Z",
              author: {
                handle: "example.bsky.social",
                did: "did:plc:123",
              },
              record: {
                text: "#atconference https://example.com",
                createdAt: "2026-03-29T09:00:00.000Z",
                tags: ["atconference"],
                facets: [
                  {
                    features: [
                      {
                        $type: "app.bsky.richtext.facet#link",
                        uri: "https://example.com",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        };
      },
    };
  };

  const result = await harvestHashtagLinks({
    hashtag: normalizeHashtag("#atconference"),
    days: 2,
    now,
    fetchImpl,
    pageSize: 1,
  });

  assert.equal(requestUrl.searchParams.has("since"), false);
  assert.equal(result.complete, false);
  assert.equal(result.postCount, 1);
  assert.equal(result.linkCount, 1);
});

test("runCli writes markdown output file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atharvest-"));
  const stdout = memoryStream();
  const stderr = memoryStream();
  const now = new Date("2026-03-28T10:00:00.000Z");
  const envPath = join(dir, ".env");

  await writeFile(
    envPath,
    [
      "BLUESKY_IDENTIFIER=example.bsky.social",
      "BLUESKY_APP_PASSWORD=app-password",
    ].join("\n"),
    "utf8",
  );

  const fetchImpl = async (url, options = {}) => {
    if (
      url.toString() === "https://bsky.social/xrpc/com.atproto.server.createSession" &&
      options.method === "POST"
    ) {
      return {
        ok: true,
        async json() {
          return {
            accessJwt: "test-access-token",
          };
        },
      };
    }

    return {
      ok: true,
      async json() {
        return {
          posts: [
            {
              uri: "at://did:plc:123/app.bsky.feed.post/3kxyz",
              indexedAt: "2026-03-28T09:00:00.000Z",
              author: {
                handle: "example.bsky.social",
                did: "did:plc:123",
              },
              record: {
                text: "#atmosphereconf https://example.com",
                createdAt: "2026-03-28T09:00:00.000Z",
                tags: ["atmosphereconf"],
                facets: [
                  {
                    features: [
                      {
                        $type: "app.bsky.richtext.facet#link",
                        uri: "https://example.com",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        };
      },
    };
  };

  const exitCode = await withEnv(
    {
      BLUESKY_IDENTIFIER: undefined,
      BLUESKY_APP_PASSWORD: undefined,
      ATHARVEST_BLUESKY_IDENTIFIER: undefined,
      ATHARVEST_BLUESKY_APP_PASSWORD: undefined,
    },
    () =>
      runCli(["-h", "#atmosphereconf", "-t", "3"], {
        stdout,
        stderr,
        fetchImpl,
        now,
        outputDir: dir,
        envPath,
      }),
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.output, "");

  const outputPath = stdout.output.trim();
  const markdown = await readFile(outputPath, "utf8");

  assert.match(markdown, /https:\/\/example\.com/);
  assert.match(markdown, /example\.bsky\.social/);
});

test("runCli fails when Bluesky credentials are missing", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const now = new Date("2026-03-29T10:00:00.000Z");

  const exitCode = await withEnv(
    {
      BLUESKY_IDENTIFIER: undefined,
      BLUESKY_APP_PASSWORD: undefined,
      ATHARVEST_BLUESKY_IDENTIFIER: undefined,
      ATHARVEST_BLUESKY_APP_PASSWORD: undefined,
    },
    () =>
      runCli(["-h", "#atconference", "-t", "2"], {
        stdout,
        stderr,
        now,
        envPath: join(tmpdir(), `atharvest-missing-${Date.now()}.env`),
      }),
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout.output, "");
  assert.match(stderr.output, /Bluesky credentials are required/);
});

test("runCli writes to the default reports directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atharvest-default-"));
  const stdout = memoryStream();
  const stderr = memoryStream();
  const now = new Date("2026-03-28T10:00:00.000Z");
  const envPath = join(dir, ".env");

  await writeFile(
    envPath,
    [
      "BLUESKY_IDENTIFIER=example.bsky.social",
      "BLUESKY_APP_PASSWORD=app-password",
    ].join("\n"),
    "utf8",
  );

  const fetchImpl = async (url, options = {}) => {
    if (
      url.toString() === "https://bsky.social/xrpc/com.atproto.server.createSession" &&
      options.method === "POST"
    ) {
      return {
        ok: true,
        async json() {
          return {
            accessJwt: "test-access-token",
          };
        },
      };
    }

    return {
      ok: true,
      async json() {
        return {
          posts: [],
        };
      },
    };
  };

  const originalCwd = process.cwd();
  process.chdir(dir);

  try {
    const exitCode = await withEnv(
      {
        BLUESKY_IDENTIFIER: undefined,
        BLUESKY_APP_PASSWORD: undefined,
        ATHARVEST_BLUESKY_IDENTIFIER: undefined,
        ATHARVEST_BLUESKY_APP_PASSWORD: undefined,
      },
      () =>
        runCli(["-h", "#atmosphereconf", "-t", "3"], {
          stdout,
          stderr,
          fetchImpl,
          now,
          envPath,
        }),
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.output, "");
    assert.equal(basename(stdout.output.trim()), "atharvest-atmosphereconf-2026-03-28T10-00-00Z.md");
    assert.match(stdout.output.trim(), /reports\/atharvest-atmosphereconf-2026-03-28T10-00-00Z\.md$/);
  } finally {
    process.chdir(originalCwd);
  }
});

function memoryStream() {
  return {
    output: "",
    write(chunk) {
      this.output += String(chunk);
    },
  };
}

async function withEnv(updates, run) {
  const previous = new Map();

  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
