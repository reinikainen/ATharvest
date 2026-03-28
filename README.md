# atharvest

`atharvest` is a small command-line tool that searches Bluesky posts for a hashtag, extracts every link it finds, and writes the results to a Markdown report.

It is designed to be:

- one-shot
- lightweight
- usable by both humans and AI agents

## What It Does

Given a hashtag and a number of days, `atharvest`:

1. searches Bluesky for posts containing that hashtag
2. collects links from post text, rich-text facets, and embeds
3. writes a Markdown file with each harvested link and a link back to the original post

Example:

```bash
./atharvest -h '#atmosphereconf' -t 3
```

Example output file:

```text
reports/atharvest-atmosphereconf-2026-03-28T10-00-00Z.md
```

## Requirements

- Node.js 22 or newer

No global install is required.

## Quick Start

Run directly from the repo:

```bash
./atharvest -h '#atmosphereconf' -t 3
```

Reports are written into `reports/` by default. That directory is git-ignored.

If you want a bare `atharvest` command on your `PATH`:

```bash
./install.sh
```

That creates a symlink at `~/.local/bin/atharvest`.

If `~/.local/bin` is not already on your `PATH`, add this to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Authentication

Anonymous Bluesky search can return `403` for some queries or provider paths. If that happens, use a Bluesky app password.

Set these environment variables:

```bash
export BLUESKY_IDENTIFIER='your-handle.bsky.social'
export BLUESKY_APP_PASSWORD='your-app-password'
```

Then run the same command:

```bash
./atharvest -h '#atmosphereconf' -t 3
```

### How to Get a Bluesky App Password

In Bluesky:

1. Open `Settings`
2. Open `Advanced`
3. Open `App Passwords`
4. Create a new app password
5. Copy the generated password and use that value for `BLUESKY_APP_PASSWORD`

Use an app password, not your normal Bluesky account password.

## Usage

```bash
./atharvest -h '#atmosphereconf' -t 3
```

Arguments:

- `-h`, `--hashtag`: hashtag to search for
- `-t`, `--time`: number of days of history to search
- `--help`: show help

Examples:

```bash
./atharvest -h '#atmosphereconf' -t 3
./atharvest -h '#ai' -t 1
./atharvest --hashtag atmosphereconf --time 7
```

Optional API host override:

```bash
ATHARVEST_API_BASE_URL=https://your-proxy.example ./atharvest -h '#atmosphereconf' -t 3
```

## Output Format

Default output directory:

```text
reports/
```

The generated Markdown report includes:

- report metadata
- search window
- total posts scanned
- total links found
- one entry per harvested link

Each harvested entry includes:

- the harvested URL
- a link to the original Bluesky post
- the author handle
- the post timestamp

## Notes

- In `zsh`, quote hashtags like `'#atmosphereconf'` so `#` is not treated as a comment.
- `-h` is used for the hashtag parameter in this tool. Use `--help` for help output.
- The tool uses Bluesky's `app.bsky.feed.searchPosts` API.
- Results are lightweight and fast, but still best-effort rather than firehose-level archival guarantees.

## Development

Run tests:

```bash
npm test
```

Run the tool through npm if needed:

```bash
npm run atharvest -- -h '#atmosphereconf' -t 3
```
