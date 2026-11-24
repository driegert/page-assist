// Validate a user-entered docproc base URL. Kept free of heavy imports so the
// settings page can use it without pulling in pdf.js.
//
// Allowed: https://anything, or http:// only to hosts that can't be a public
// internet server: loopback, RFC 1918 / CGNAT (tailnet) IPs, single-label
// hostnames (LAN / MagicDNS short names), *.local, *.ts.net.
// Returns the normalized base (no trailing slash) or null if not allowed.

const isPrivateHost = (host: string) => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (h === "localhost" || h === "::1") return true
  if (!h.includes(".")) return true
  if (h.endsWith(".local") || h.endsWith(".ts.net")) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

export const validateDocprocUrl = (raw: string | undefined | null): string | null => {
  const s = (raw ?? "").trim()
  if (!s) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.username || u.password) return null
  if (u.protocol === "https:" || (u.protocol === "http:" && isPrivateHost(u.hostname))) {
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "")
  }
  return null
}
