import { Storage } from "@plasmohq/storage"
import { getPdf } from "./pdf"
import { defaultExtractContent } from "@/parser/default"
import { validateDocprocUrl } from "@/utils/docproc-url"

// PDF -> text for the chat-with-page paths. Entry point: getPdfContent().
//
// Order of preference:
//   1. arXiv PDF with an HTML (LaTeXML) version -> that page via Defuddle (math as LaTeX)
//   2. Paper library (if configured): the PDF's SHA-256 is looked up on the
//      papers server; a byte-identical PDF already converted there is used as-is
//   3. docproc (marker) if enabled in settings -> Markdown with LaTeX math
//   4. pdf.js text layer (always available; math is flattened)

export type PdfPage = { content: string; page: number }

export type PdfContent =
  | { kind: "html"; url: string; content: string; html: string }
  | { kind: "pdf"; pages: PdfPage[] }
  | { kind: "failed"; reason: string }

const storage = new Storage()

const MAX_PDF_BYTES = 100 * 1024 * 1024
const PDF_FETCH_TIMEOUT_MS = 60_000
const ARXIV_TIMEOUT_MS = 15_000
const DOCPROC_REQUEST_TIMEOUT_MS = 120_000
const DOCPROC_JOB_TIMEOUT_MS = 10 * 60_000
const DOCPROC_RETRY_BACKOFF_MS = 5 * 60_000
const ARXIV_NEGATIVE_TTL_MS = 10 * 60_000
const LIBRARY_TIMEOUT_MS = 8_000
const LIBRARY_NEGATIVE_TTL_MS = 10 * 60_000

// ---------------------------------------------------------------- cache

// Small LRU. Values are promises so concurrent callers share one in-flight
// conversion (the side panel calls getContentFromCurrentTab on every message).
class Lru<V> {
  private map = new Map<string, { value: V; expires: number }>()
  constructor(private max: number) {}
  get(key: string): V | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.expires < Date.now()) {
      this.map.delete(key)
      return undefined
    }
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }
  set(key: string, value: V, ttlMs = Infinity) {
    this.map.delete(key)
    this.map.set(key, { value, expires: Date.now() + ttlMs })
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value as string)
    }
  }
  delete(key: string) {
    this.map.delete(key)
  }
}

const pdfjsCache = new Lru<Promise<PdfPage[]>>(10)
const docprocCache = new Lru<Promise<PdfPage[]>>(10)
const docprocFailedAt = new Map<string, number>()
const arxivCache = new Lru<Promise<PdfContent | null>>(20)
const libraryCache = new Lru<PdfPage[]>(10)
const libraryMiss = new Lru<true>(50)

// Cache only successes: a rejected promise is evicted so the next call retries.
const cached = <V>(cache: Lru<Promise<V>>, key: string, make: () => Promise<V>) => {
  const hit = cache.get(key)
  if (hit) return hit
  const p = make()
  cache.set(key, p)
  p.catch(() => cache.delete(key))
  return p
}

// ---------------------------------------------------------------- pdf.js

// Control chars from TeX extension fonts (big parens etc.) and C1 -- keep \t \n.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

// Join pdf.js text items, breaking lines only where pdf.js says a line ends.
// The old `.join("\n")` put every math glyph on its own line.
export const textFromTextContent = (content: any): string => {
  let out = ""
  for (const item of content?.items ?? []) {
    if (typeof item?.str !== "string") continue
    out += item.str
    if (item.hasEOL) out += "\n"
  }
  return out.replace(CONTROL_CHARS, "").replace(/[ \t]+\n/g, "\n").trim()
}

export const extractPdfPagesWithPdfJs = async (
  data: ArrayBuffer
): Promise<PdfPage[]> => {
  const pdf = await getPdf(data)
  try {
    const pages: PdfPage[] = []
    for (let i = 1; i <= pdf.numPages; i += 1) {
      try {
        const page = await pdf.getPage(i)
        const text = textFromTextContent(await page.getTextContent())
        if (text) pages.push({ content: text, page: i })
      } catch (e) {
        console.warn(`[pdf-extract] pdf.js failed on page ${i}:`, e)
      }
    }
    if (pages.length === 0) {
      pages.push({
        page: 1,
        content:
          "[This PDF has no extractable text layer (it may be a scan). Enabling docproc in Page Assist's Retrieval Settings can OCR it.]"
      })
    }
    return pages
  } finally {
    pdf.destroy().catch(() => {})
  }
}

const isPdfBytes = (data: Uint8Array) => {
  // "%PDF" may be preceded by junk bytes; the spec allows it within the first 1 KB.
  const n = Math.min(data.length, 1024)
  for (let i = 0; i + 3 < n; i++) {
    if (data[i] === 0x25 && data[i + 1] === 0x50 && data[i + 2] === 0x44 && data[i + 3] === 0x46) {
      return true
    }
  }
  return false
}

// Read a response body with a hard size cap (no unbounded buffering).
const readCapped = async (res: Response, max: number): Promise<Uint8Array> => {
  const declared = Number(res.headers.get("content-length") || 0)
  if (declared > max) throw new Error(`too large (${declared} bytes)`)
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      reader.cancel().catch(() => {})
      throw new Error(`too large (> ${max} bytes)`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

// fromEmbed: the URL came from an iframe/embed the *page* chose. Its origin
// was checked against the tab, but a same-origin URL could redirect anywhere,
// and this fetch carries the user's cookies -- so refuse redirects outright.
// (redirect: "manual" is no help: extension fetch gets an opaque response.)
const fetchPdfBytes = async (
  url: string,
  fromEmbed: boolean
): Promise<{ ok: true; data: Uint8Array } | { ok: false; reason: string }> => {
  try {
    const res = await fetch(url, {
      credentials: "include",
      redirect: fromEmbed ? "error" : "follow",
      signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS)
    })
    const type = res.headers.get("content-type") || "unknown type"
    if (!res.ok) {
      res.body?.cancel().catch(() => {})
      return { ok: false, reason: `HTTP ${res.status}, ${type}` }
    }
    const data = await readCapped(res, MAX_PDF_BYTES)
    if (!isPdfBytes(data)) return { ok: false, reason: `not a PDF (${type})` }
    return { ok: true, data }
  } catch (e: any) {
    return { ok: false, reason: e?.name === "TimeoutError" ? "timed out" : String(e?.message || e) }
  }
}

// ---------------------------------------------------------------- arXiv

const ARXIV_PDF = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/pdf\/([^?#]+?)(?:\.pdf)?\/?(?:[?#].*)?$/i

const getArxivHtmlContent = (url: string): Promise<PdfContent | null> => {
  const m = url.match(ARXIV_PDF)
  if (!m) return Promise.resolve(null)
  const id = m[1]
  const hit = arxivCache.get(id)
  if (hit) return hit
  const p = (async (): Promise<PdfContent | null> => {
    const htmlUrl = `https://arxiv.org/html/${id}`
    try {
      const res = await fetch(htmlUrl, {
        credentials: "omit",
        signal: AbortSignal.timeout(ARXIV_TIMEOUT_MS)
      })
      if (!res.ok) return null
      const html = await res.text()
      // A real LaTeXML render has many ltx_para blocks; the "no HTML
      // available" page does not.
      const paras = html.match(/class="ltx_para/g)?.length ?? 0
      if (paras < 5) return null
      const content = defaultExtractContent(html, htmlUrl)
      if (!content) return null
      console.log("[pdf-extract] using arXiv HTML version")
      return { kind: "html", url: htmlUrl, content, html }
    } catch (e) {
      console.warn("[pdf-extract] arXiv HTML fetch failed, using PDF:", e)
      throw e // not cached: retry next time
    }
  })()
  // Positive results live until evicted; "no HTML version" is rechecked after a while.
  arxivCache.set(id, p)
  p.then(
    (r) => r === null && arxivCache.set(id, p, ARXIV_NEGATIVE_TTL_MS),
    () => arxivCache.delete(id)
  )
  return p.catch(() => null)
}

// ---------------------------------------------------------------- paper library

const getLibraryUrl = async (): Promise<string | null> =>
  validateDocprocUrl(await storage.get<string | undefined>("paperLibraryUrl"))

const sha256Hex = async (data: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

// docproc's figure references (`![](_page_3_Figure_5.jpeg)`) point at files
// only the server has; drop them rather than feed the model dead links.
const stripPageImages = (md: string) =>
  md.replace(/!\[[^\]\n]*\]\(_page_\d+_[^)\s]*\)/g, "").replace(/\n{3,}/g, "\n\n")

// null = not in the library (or the server is unreachable).
const lookupInLibrary = async (base: string, data: Uint8Array): Promise<PdfPage[] | null> => {
  try {
    const hex = await sha256Hex(data)
    const res = await fetch(`${base}/paper/by-sha256/${hex}`, {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(LIBRARY_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const j = await res.json()
    if (typeof j?.markdown !== "string" || !j.markdown.trim()) return null
    console.log("[pdf-extract] PDF found in paper library")
    return [{ content: stripPageImages(j.markdown).trim(), page: 1 }]
  } catch (e) {
    console.warn("[pdf-extract] paper library lookup failed:", e)
    return null
  }
}

// ---------------------------------------------------------------- docproc

const DOCPROC_MODES = new Set(["reading", "fast", "full"])

export type DocprocSettings = { enabled: boolean; url: string; mode: string }

export const getDocprocSettings = async (): Promise<DocprocSettings> => {
  const [enabled, url, mode] = await Promise.all([
    storage.get<boolean | undefined>("docprocEnabled"),
    storage.get<string | undefined>("docprocUrl"),
    storage.get<string | undefined>("docprocMode")
  ])
  const base = validateDocprocUrl(url)
  return {
    enabled: !!enabled && !!base,
    url: base ?? "",
    mode: mode && DOCPROC_MODES.has(mode) ? mode : "reading"
  }
}

// marker occasionally degenerates into a repetition loop on one region
// ("deviation" x101 in the raggedy_android trial). Collapse a 1-5 word phrase
// repeated 8+ times in a row on one line, instead of discarding the document.
// Whole words only; one of the phrase's words must have 3+ letters (so LaTeX like
// `0 & 0 & ...` is left alone) and may not contain `|` (Markdown tables).
export const collapseRepetitions = (md: string): string =>
  md.replace(
    /(?<!\S)((?=(?:[^\s|]{1,40}[ \t]+){0,4}\p{L}{3})[^\s|]{1,40}(?:[ \t]+[^\s|]{1,40}){0,4}?)(?:[ \t]+\1){7,}(?!\S)/gu,
    (run, phrase) => {
      console.warn(`[pdf-extract] collapsed a repetition loop (${run.length} chars)`)
      return `${phrase} [repeated text removed]`
    }
  )

const DOCPROC_JOB_ID = /^[\w-]{1,64}$/

const docprocFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(DOCPROC_REQUEST_TIMEOUT_MS)
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const convertWithDocproc = async (
  data: Uint8Array,
  filename: string,
  { url: base, mode }: DocprocSettings
): Promise<string> => {
  const form = new FormData()
  form.append("file", new Blob([data], { type: "application/pdf" }), filename)
  const up = await docprocFetch(`${base}/api/upload`, { method: "POST", body: form })
  if (!up.ok) throw new Error(`docproc upload failed: HTTP ${up.status}`)
  const { path } = await up.json()
  if (typeof path !== "string" || !path) throw new Error("docproc upload: no path")

  const jobRes = await docprocFetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_path: path, mode, caller: "page-assist" })
  })
  if (!jobRes.ok) throw new Error(`docproc job create failed: HTTP ${jobRes.status}`)
  const job = await jobRes.json()
  if (typeof job?.id !== "string" || !DOCPROC_JOB_ID.test(job.id)) {
    throw new Error("docproc job create: bad job id")
  }
  const jobUrl = `${base}/api/jobs/${encodeURIComponent(job.id)}`

  const deadline = Date.now() + DOCPROC_JOB_TIMEOUT_MS
  let status: string = job.status
  let errorMsg: string = job.error_msg ?? ""
  while (status === "queued" || status === "running") {
    if (Date.now() > deadline) {
      // Best effort: docproc can only cancel jobs that haven't started.
      docprocFetch(`${jobUrl}/cancel`, { method: "POST" }).catch(() => {})
      throw new Error("docproc timed out")
    }
    await sleep(2000)
    const r = await docprocFetch(jobUrl)
    if (!r.ok) throw new Error(`docproc poll failed: HTTP ${r.status}`)
    const j = await r.json()
    status = j?.status
    errorMsg = j?.error_msg ?? ""
  }
  if (status !== "done") throw new Error(`docproc job ${status}: ${errorMsg}`)

  const md = await docprocFetch(`${jobUrl}/file/md`)
  if (!md.ok) throw new Error(`docproc result fetch failed: HTTP ${md.status}`)
  return collapseRepetitions(await md.text())
}

// ---------------------------------------------------------------- entry point

const filenameFor = (url: string) => {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() || "document"
    const stem = last.replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 80)
    return `${stem || "document"}.pdf`
  } catch {
    return "document.pdf"
  }
}

/**
 * Get chat-ready content for a PDF URL.
 * fromEmbed: the URL was taken from an iframe/embed on the page (already
 * checked same-origin with the tab); redirects are refused for it.
 */
export const getPdfContent = async (
  url: string,
  { fromEmbed = false }: { fromEmbed?: boolean } = {}
): Promise<PdfContent> => {
  const arxiv = await getArxivHtmlContent(url)
  if (arxiv) return arxiv

  // Paper library first: an exact-hash hit is instant and already has tables
  // and LaTeX. Checked before the docproc/pdf.js caches so enabling it isn't
  // shadowed by an older result; misses are remembered for a while.
  let data: Uint8Array | undefined
  const libraryUrl = await getLibraryUrl()
  if (libraryUrl) {
    const libKey = `${libraryUrl}|${url}`
    const libHit = libraryCache.get(libKey)
    if (libHit) return { kind: "pdf", pages: libHit }
    if (!libraryMiss.get(libKey)) {
      const bytes = await fetchPdfBytes(url, fromEmbed)
      if (bytes.ok === false) return { kind: "failed", reason: bytes.reason }
      data = bytes.data
      const pages = await lookupInLibrary(libraryUrl, data)
      if (pages) {
        libraryCache.set(libKey, pages)
        return { kind: "pdf", pages }
      }
      libraryMiss.set(libKey, true, LIBRARY_NEGATIVE_TTL_MS)
    }
  }

  const docproc = await getDocprocSettings()
  const docprocKey = `${docproc.mode}|${docproc.url}|${url}`
  const failedAt = docprocFailedAt.get(docprocKey) ?? 0
  const tryDocproc = docproc.enabled && Date.now() - failedAt > DOCPROC_RETRY_BACKOFF_MS

  // When docproc should be tried, don't let an older pdf.js result shadow it.
  const hit = tryDocproc ? docprocCache.get(docprocKey) : pdfjsCache.get(url)
  if (hit) {
    try {
      return { kind: "pdf", pages: await hit }
    } catch {
      // fall through and redo it
    }
  }

  if (!data) {
    const bytes = await fetchPdfBytes(url, fromEmbed)
    if (bytes.ok === false) return { kind: "failed", reason: bytes.reason }
    data = bytes.data
  }
  const pdfData = data

  if (tryDocproc) {
    try {
      const pages = await cached(docprocCache, docprocKey, async () => {
        const t0 = Date.now()
        const md = (await convertWithDocproc(pdfData, filenameFor(url), docproc)).trim()
        if (!md) throw new Error("docproc returned empty output")
        console.log(`[pdf-extract] docproc (${docproc.mode}) took ${((Date.now() - t0) / 1000).toFixed(1)}s`)
        return [{ content: md, page: 1 }]
      })
      docprocFailedAt.delete(docprocKey)
      return { kind: "pdf", pages }
    } catch (e) {
      docprocFailedAt.set(docprocKey, Date.now())
      console.warn("[pdf-extract] docproc failed, falling back to pdf.js:", e)
    }
  }

  try {
    const pages = await cached(pdfjsCache, url, () => extractPdfPagesWithPdfJs(pdfData.buffer as ArrayBuffer))
    return { kind: "pdf", pages }
  } catch (e: any) {
    return { kind: "failed", reason: `could not parse the PDF (${e?.message || e})` }
  }
}
