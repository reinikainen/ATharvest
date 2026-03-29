import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const DEFAULT_OUTPUT_DIR = "reports";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ENV_PATH = resolve(PROJECT_ROOT, ".env");

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
    await loadEnvFile(options.envPath ?? DEFAULT_ENV_PATH);

    const normalizedHashtag = normalizeHashtag(options.hashtag);
    const now = options.now ?? new Date();
    const auth = {
      identifier: process.env.BLUESKY_IDENTIFIER ?? process.env.ATHARVEST_BLUESKY_IDENTIFIER,
      password: process.env.BLUESKY_APP_PASSWORD ?? process.env.ATHARVEST_BLUESKY_APP_PASSWORD,
    };

    if (!auth.identifier || !auth.password) {
      throw new Error(
        "Bluesky credentials are required. Set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD.",
      );
    }

    const result = await harvestHashtagLinks({
      hashtag: normalizedHashtag,
      days: options.days,
      now,
      fetchImpl: options.fetchImpl,
      apiBaseUrl: options.apiBaseUrl ?? process.env.ATHARVEST_API_BASE_URL,
      auth,
    });

    const markdown = renderMarkdown(result);
    const outputDir = resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
    const outputFile = resolve(outputDir, buildOutputFilename(normalizedHashtag.tag, now));

    await mkdir(outputDir, { recursive: true });
    await writeFile(outputFile, markdown, "utf8");

    stdout.write(`${outputFile}\n`);
    return 0;
  } catch (error) {
    stderr.write(`atharvest failed: ${error.message}\n`);
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

export async function loadEnvFile(envPath = DEFAULT_ENV_PATH) {
  let content;

  try {
    content = await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }

    throw new Error(`Unable to read env file at ${envPath}: ${error.message}`);
  }

  for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);

    if (!match) {
      throw new Error(`Invalid env file syntax at ${envPath}:${index + 1}`);
    }

    const [, key, rawValue] = match;

    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  const hashIndex = trimmed.indexOf(" #");
  if (hashIndex >= 0) {
    return trimmed.slice(0, hashIndex).trimEnd();
  }

  return trimmed;
}
