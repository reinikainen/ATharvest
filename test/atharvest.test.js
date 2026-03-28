import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs, runCli } from "../src/cli.js";
import {
  buildOutputFilename,
  buildPostUrl,
  extractLinksFromPost,
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

test("runCli writes markdown output file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atharvest-"));
  const stdout = memoryStream();
  const stderr = memoryStream();
  const now = new Date("2026-03-28T10:00:00.000Z");

  const fetchImpl = async () => ({
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
  });

  const exitCode = await runCli(["-h", "#atmosphereconf", "-t", "3"], {
    stdout,
    stderr,
    fetchImpl,
    now,
    outputDir: dir,
    apiBaseUrl: "https://public.api.bsky.app",
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.output, "");

  const outputPath = stdout.output.trim();
  const markdown = await readFile(outputPath, "utf8");

  assert.match(markdown, /https:\/\/example\.com/);
  assert.match(markdown, /example\.bsky\.social/);
});

test("runCli writes to the default reports directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atharvest-default-"));
  const stdout = memoryStream();
  const stderr = memoryStream();
  const now = new Date("2026-03-28T10:00:00.000Z");

  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        posts: [],
      };
    },
  });

  const originalCwd = process.cwd();
  process.chdir(dir);

  try {
    const exitCode = await runCli(["-h", "#atmosphereconf", "-t", "3"], {
      stdout,
      stderr,
      fetchImpl,
      now,
      apiBaseUrl: "https://public.api.bsky.app",
    });

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
