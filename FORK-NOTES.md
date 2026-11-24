# Dave's Page Assist fork — notes

This is a fork of [n4ze3m/page-assist](https://github.com/n4ze3m/page-assist).
Everything I've changed lives on the **`dave`** branch. `main` is kept identical to upstream.

| Remote | Repo | Use |
|---|---|---|
| `origin` | `git@github.com:driegert/page-assist.git` | push/pull `dave` |
| `upstream` | `https://github.com/n4ze3m/page-assist.git` | fetch only (push disabled) |

## What's different from upstream

- **PDFs.** The options are tried in this order. Most of the logic is in `src/libs/pdf-extract.ts`.
  1. **arXiv:** a `/pdf/` link is swapped for its `/html/` (LaTeXML) version when that exists, which gives clean LaTeX.
  2. **Paper library:** the PDF's SHA-256 hash is looked up in the papers server (mcp-tools `server_papers.py`, route `/paper/by-sha256/{hash}`). A match returns the stored Markdown from `/media/extra_stuff/papers/md/`. Annotated PDFs have a different hash, so they won't match.
  3. **docproc** (optional): the PDF is uploaded to docproc for conversion, in reading or full mode.
  4. **pdf.js:** the fallback, with better line joining than upstream.
- **PDF wrapper pages** (for example IEEE `stamp.jsp`): a same-origin PDF iframe or embed is followed. A cross-origin one gets a note to open the PDF directly.
- **Small fixes:** one DNR rewrite rule per origin (`runtime.ts`), and the Wikipedia parser now receives the HTML string (`get-tab-contents.ts`).

## Settings (Settings → Retrieval Settings)

- **Paper library URL:** `http://triplestuffed:8256`. This is tailnet-only, through Caddy to papers-mcp on `:8206`.
- **docproc:** off unless I want it. URL `https://docproc.riegert.xyz`. Use reading mode, because full mode is slow.
- These settings sync through Chrome sync only if the extension ID matches on each machine (see below).

## Updating from upstream

```bash
git switch main && git pull                  # fast-forward to upstream
git switch dave && git rebase main           # rerere replays past conflict resolutions
npx tsc --noEmit && bun run build && bun run build:firefox
git push --force-with-lease
```

Then reload the extension. Test one IEEE `stamp.jsp` page and one arXiv `/pdf/` link.

**Where conflicts are likely:** `src/libs/get-html.ts` (most likely), `get-tab-contents.ts`, `sidepanel-rag.tsx`, and `locale/en/settings.json`. The two new files, `pdf-extract.ts` and `docproc-url.ts`, can't conflict.
If upstream changes `bun.lockb`, take their version (`git checkout --theirs bun.lockb`) and run `bun install`. Don't hand-merge it.
If upstream rewrites `_getHtml` or stops using Defuddle, re-test PDFs carefully even if the rebase was clean.

## Setting up a new machine (e.g. tinkertoy)

```bash
cd ~/school_lab/git_repositories             # SAME path on every machine (see below)
git clone -b dave git@github.com:driegert/page-assist.git
cd page-assist
git remote add upstream https://github.com/n4ze3m/page-assist.git
git remote set-url --push upstream DISABLED
git fetch upstream
git branch --track main upstream/main
git config rerere.enabled true
bun install && bun run build
```

Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `build/chrome-mv3`.
If the Web Store version is installed, **export chats first**. Removing it deletes its local data.

After that, updating is `git pull && bun run build`, then reload the extension.

### Gotchas

- **Extension ID:** Chrome derives an unpacked extension's ID from its folder path. With the same path on every machine you get the same ID, so settings sync. With a different path you get a separate extension with its own settings. The fix would be a manifest `key`.
- **Firefox:** `build/firefox-mv2` loaded as a temporary add-on disappears on restart. To keep it permanently it needs signing as an unlisted add-on on AMO, or Firefox Developer Edition with `xpinstall.signatures.required=false`.
- **The paper library needs the papers server** (`papers-mcp.service` on triplestuffed, mcp-tools `develop` branch). If the server is down, lookups fail quietly and Page Assist falls back to docproc or pdf.js.
