import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildOutputFilename,
  harvestHashtagLinks,
  normalizeHashtag,
  renderMarkdown,
} from "./harvest.js";

const HELP_TEXT = `atharvest

Usage:
  atharvest -h <hashtag> -t <days>
  atharvest --hashtag <hashtag> --time <days>
  atharvest --help

Examples:
  atharvest -h #atmosphereconf -t 3
  atharvest --hashtag atmosphereconf --time 7

Notes:
  -h is reserved for the hashtag input in this tool.
  Use --help for help output.`;

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  let parsedOptions;

  try {
    parsedOptions = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${HELP_TEXT}\n`);
    return 1;
  }

  const options = {
    ...parsedOptions,
    ...io,
    stdout,
    stderr,
  };

  if (options.help) {
    stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }

  try {
    const normalizedHashtag = normalizeHashtag(options.hashtag);
    const now = options.now ?? new Date();
    const auth = {
      identifier: process.env.BLUESKY_IDENTIFIER ?? process.env.ATHARVEST_BLUESKY_IDENTIFIER,
      password: process.env.BLUESKY_APP_PASSWORD ?? process.env.ATHARVEST_BLUESKY_APP_PASSWORD,
    };
    const result = await harvestHashtagLinks({
      hashtag: normalizedHashtag,
      days: options.days,
      now,
      fetchImpl: options.fetchImpl,
      apiBaseUrl: options.apiBaseUrl ?? process.env.ATHARVEST_API_BASE_URL,
      auth,
    });

    const markdown = renderMarkdown(result);
    const outputFile = resolve(
      options.outputDir ?? process.cwd(),
      buildOutputFilename(normalizedHashtag.tag, now),
    );

    await writeFile(outputFile, markdown, "utf8");

    stdout.write(`${outputFile}\n`);
    return 0;
  } catch (error) {
    const authMissing =
      !process.env.BLUESKY_IDENTIFIER &&
      !process.env.ATHARVEST_BLUESKY_IDENTIFIER &&
      !process.env.BLUESKY_APP_PASSWORD &&
      !process.env.ATHARVEST_BLUESKY_APP_PASSWORD;
    const authHint =
      authMissing && error.message.includes("HTTP 403")
        ? "\nHint: Bluesky search can require authentication. Set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD."
        : "";
    stderr.write(`atharvest failed: ${error.message}${authHint}\n`);
    return 1;
  }
}

export function parseArgs(argv) {
  if (argv.includes("--help")) {
    return { help: true };
  }

  let hashtag;
  let days;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "-h" || arg === "--hashtag") {
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for hashtag.");
      }
      hashtag = next;
      index += 1;
      continue;
    }

    if (arg === "-t" || arg === "--time") {
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for days.");
      }
      days = parseDays(next);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!hashtag) {
    throw new Error("Hashtag is required.");
  }

  if (days === undefined) {
    throw new Error("Days is required.");
  }

  return {
    help: false,
    hashtag,
    days,
  };
}

function parseDays(value) {
  const days = Number.parseInt(value, 10);

  if (!Number.isInteger(days) || days < 1) {
    throw new Error("Days must be a positive integer.");
  }

  return days;
}
