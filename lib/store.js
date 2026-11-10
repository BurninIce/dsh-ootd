/**
 * Daily cache persistence for dsh-ootd.
 *
 * One small JSON document per day (`today.json`) holds the scene, weather,
 * outfit and plan. The directory also keeps the last N days' scenes for the
 * "don't pick the same kind of place again" check. Writes are atomic
 * (temp file + rename) because a conversation may read while a background
 * refresh writes.
 */

import fs from 'node:fs'
import path from 'node:path'

const FILE_NAME = 'today.json'

/** @typedef {{ date: string, scene: string, outfit: string,
 *   weather: null | Record<string, any>, plan: Array<Record<string, any>>,
 *   placeType: string, createdAt: number, source: string,
 *   recent: Array<{ date: string, scene: string, placeType: string }> }} TodayCache */

export class OotdStore {
  /**
   * @param {string} dir
   * @param {{ warn?: (message: string) => void }} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.file = path.join(dir, FILE_NAME)
    this.warn = options.warn ?? (() => {})
    this.corruptHandled = false
    /** @type {TodayCache | null} */
    this.data = null
    this.readAt = 0
  }

  /**
   * Read the cache, memoized for a short window because prompt assembly calls
   * this on every model step and must not hit the disk each time.
   *
   * @param {number} [now]
   * @returns {TodayCache | null}
   */
  read(now = Date.now()) {
    if (this.data && now - this.readAt < 5_000) return this.data
    let text
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`今日日常缓存读取失败：${String(error?.message ?? error)}`)
      this.data = null
      this.readAt = now
      return null
    }
    try {
      this.data = normalizeCache(JSON.parse(text))
      this.corruptHandled = false
    } catch (error) {
      this.data = null
      this.preserveCorrupt(error)
    }
    this.readAt = now
    return this.data
  }

  /** Keep one copy of a damaged cache before it can be overwritten. */
  preserveCorrupt(error) {
    if (this.corruptHandled) return
    this.corruptHandled = true
    const target = `${this.file}.corrupt-${Date.now()}`
    try {
      fs.copyFileSync(this.file, target)
      this.warn(`今日日常缓存损坏，已保留副本 ${target}（${String(error?.message ?? error)}）`)
    } catch (copyError) {
      this.warn(`今日日常缓存损坏且无法保留副本：${String(copyError?.message ?? copyError)}`)
    }
  }

  /** @param {TodayCache} data */
  write(data) {
    const normalized = normalizeCache(data)
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.file)
    this.data = normalized
    this.readAt = Date.now()
    this.corruptHandled = false
  }

  /** Force the next read to hit disk (used after an external edit or tests). */
  invalidate() {
    this.data = null
    this.readAt = 0
  }

  /** @returns {string[]} scenes from previous days, oldest first. */
  recentScenes(excludeDate) {
    const cache = this.read()
    const rows = Array.isArray(cache?.recent) ? cache.recent : []
    return rows
      .filter((row) => row && row.date !== excludeDate && typeof row.scene === 'string' && row.scene.trim())
      .map((row) => row.scene.trim())
  }

  /** @returns {string[]} place categories used on previous days. */
  recentPlaceTypes(excludeDate) {
    const cache = this.read()
    const rows = Array.isArray(cache?.recent) ? cache.recent : []
    return rows
      .filter((row) => row && row.date !== excludeDate && typeof row.placeType === 'string')
      .map((row) => row.placeType)
      .filter(Boolean)
  }
}

/** Coerce anything read from disk into the documented cache shape. */
export function normalizeCache(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const recent = Array.isArray(source.recent)
    ? source.recent
        .filter((row) => row && typeof row === 'object')
        .map((row) => ({
          date: String(row.date ?? ''),
          scene: String(row.scene ?? ''),
          placeType: String(row.placeType ?? ''),
        }))
        .filter((row) => row.date)
    : []
  const plan = Array.isArray(source.plan)
    ? source.plan
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          time: String(item.time ?? ''),
          text: String(item.text ?? ''),
          key: item.key === true,
        }))
        .filter((item) => item.time && item.text)
    : []
  return {
    date: String(source.date ?? ''),
    scene: String(source.scene ?? ''),
    outfit: String(source.outfit ?? ''),
    weather: source.weather && typeof source.weather === 'object' ? source.weather : null,
    plan,
    placeType: String(source.placeType ?? ''),
    createdAt: Number(source.createdAt) || 0,
    source: String(source.source ?? 'generated'),
    recent,
  }
}
