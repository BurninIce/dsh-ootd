/**
 * Character-card loading and the plugin's default data directory.
 *
 * The card is an existing character-card asset (`prompts/personas/<id>/card.json`),
 * read at generation time so editing the card takes effect the next day without
 * restarting DSH. A missing or broken card is not fatal: the plugin logs once and
 * falls back to its own config/defaults.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** `$DSH_HOME`, else `~/.dsh`. Mirrors @deepseek-ai/dsh-home-paths without a runtime dependency. */
export function dshHome() {
  const configured = String(process.env.DSH_HOME ?? '').trim()
  if (configured) return path.resolve(configured)
  return path.join(os.homedir(), '.dsh')
}

/** @param {string} [configured] */
export function resolveDataDir(configured) {
  const value = String(configured ?? '').trim()
  if (value) return path.resolve(expandHome(value))
  return path.join(dshHome(), 'ootd')
}

/** Expand `~`, `~/`, `~\` against the OS home. */
export function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

/** @param {string} file */
export function resolveCardPath(file) {
  const value = String(file ?? '').trim()
  if (!value) return ''
  const expanded = expandHome(value)
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded)
}

/**
 * Load a JSON character card with an mtime cache.
 *
 * The cache key includes mtime+size, so hand-editing the card is picked up on
 * the next read while repeated daily-generation reads stay cheap.
 */
export class CardLoader {
  /** @param {{ warn?: (message: string) => void, fsImpl?: typeof fs }} [options] */
  constructor(options = {}) {
    this.fs = options.fsImpl ?? fs
    this.warn = options.warn ?? (() => {})
    this.cache = new Map()
    this.warned = new Set()
  }

  /**
   * @param {string} file
   * @returns {Record<string, any> | null}
   */
  load(file) {
    const resolved = resolveCardPath(file)
    if (!resolved) return null
    let stat
    try {
      stat = this.fs.statSync(resolved)
    } catch {
      this.warnOnce(resolved, `角色卡不存在：${resolved}`)
      return null
    }
    const signature = `${stat.mtimeMs}:${stat.size}`
    const cached = this.cache.get(resolved)
    if (cached && cached.signature === signature) return cached.card
    try {
      const text = this.fs.readFileSync(resolved, 'utf8')
      const card = JSON.parse(text)
      if (!card || typeof card !== 'object') throw new Error('卡片不是 JSON 对象')
      this.cache.set(resolved, { signature, card })
      this.warned.delete(resolved)
      return card
    } catch (error) {
      this.warnOnce(resolved, `角色卡读取失败（${resolved}）：${String(error?.message ?? error)}`)
      return null
    }
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.warn(message)
  }
}
