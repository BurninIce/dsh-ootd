/**
 * Small, dependency-free helpers shared by the ootd plugin.
 *
 * Everything here is pure (no I/O, no clock reads) unless a `now` argument is
 * passed in, so the modules that use them stay unit-testable outside DSH.
 */

/** @param {number} n @param {number} lo @param {number} hi */
export function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

/** Local calendar day as `YYYY-MM-DD` (never UTC: the daily cache is local). */
export function dateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** `MM-DD HH:MM` in local time, used by recall lines and debug logs. */
export function shortStamp(date = new Date()) {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${m}-${d} ${hh}:${mm}`
}

/** Whole days between two epoch-ms instants (never negative). */
export function daysBetween(then, now) {
  const diff = now - then
  return diff <= 0 ? 0 : Math.floor(diff / 86_400_000)
}

/**
 * Extract the first JSON object from model output.
 *
 * Models wrap JSON in code fences or add a sentence before/after it; taking the
 * first `{` through the last `}` is tolerant without accepting a truncated
 * object (JSON.parse still has to succeed).
 *
 * @param {string} text
 * @returns {unknown} parsed value, or undefined when no object parses
 */
export function parseJsonObject(text) {
  const source = String(text ?? '').trim()
  if (!source) return undefined
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(source.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** Trim and cap a string without splitting a surrogate pair. */
export function truncate(text, max) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

/** True when the text is mostly CJK (used by the outfit validator). */
export function hasCjk(text) {
  return /[\u3000-\u9fff\uff00-\uffef]/u.test(String(text ?? ''))
}

/** Normalize a config string array: trim, drop empties, dedupe. */
export function stringList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const raw of value) {
    const item = String(raw ?? '').trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** Deep clone that only admits lossless JSON (the plugin stores JSON only). */
export function jsonClone(value) {
  return JSON.parse(JSON.stringify(value))
}
