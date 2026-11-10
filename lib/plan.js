/**
 * Daily schedule normalization and the agent's bounded edit operations.
 *
 * A plan item is `{ time: 'HH:MM', text, key }`. `key` marks a real appointment
 * (someone is waiting, something has a fixed time), which is the only kind the
 * model is allowed to create through a conversation; ordinary daily items stay
 * `key: false`.
 */

import { truncate } from './util.js'

/** Strict 24-hour clock, zero-padded or not. */
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/u
const ROUTINE_PREFIX_RE = /^\s*(\d{1,2}:\d{2})(?:\s*[-–—~～至]\s*\d{1,2}:\d{2})?\s*/u

export const MAX_PLAN_ITEMS = 12
export const MAX_PLAN_TEXT = 60
export const MAX_OPS = 2

/** @param {string} value @returns {string | null} normalized `HH:MM` */
export function normalizeTime(value) {
  const match = TIME_RE.exec(String(value ?? '').trim())
  if (!match) return null
  return `${String(match[1]).padStart(2, '0')}:${match[2]}`
}

/** @param {string} time */
export function timeMinutes(time) {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/**
 * Normalize one plan entry from model output or a tool call.
 *
 * @param {unknown} raw
 * @returns {{ time: string, text: string, key: boolean } | null}
 */
export function normalizePlanItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const item = /** @type {Record<string, unknown>} */ (raw)
  const time = normalizeTime(item.time)
  const text = truncate(item.text, MAX_PLAN_TEXT)
  if (!time || !text) return null
  return { time, text, key: item.key === true }
}

/**
 * Validate, dedupe, and sort a model-generated plan.
 *
 * @param {unknown} raw
 * @param {{ max?: number }} [options]
 * @returns {Array<{ time: string, text: string, key: boolean }>}
 */
export function normalizePlan(raw, options = {}) {
  const max = options.max ?? MAX_PLAN_ITEMS
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const items = []
  for (const entry of raw) {
    const item = normalizePlanItem(entry)
    if (!item) continue
    const signature = `${item.time}|${item.text}`
    if (seen.has(signature)) continue
    seen.add(signature)
    items.push(item)
  }
  items.sort((a, b) => timeMinutes(a.time) - timeMinutes(b.time))
  return items.slice(0, max)
}

/**
 * Turn a character card's free-form routine lines into plan items.
 *
 * Routine lines are `07:30-08:30 起床…` or `23:30 洗漱…`; the leading clock is
 * the only structured part, everything after it is the text.
 *
 * @param {string[]} routine
 * @returns {Array<{ time: string, text: string, key: boolean }>}
 */
export function routinePlan(routine) {
  if (!Array.isArray(routine)) return []
  const items = []
  for (const line of routine) {
    const text = String(line ?? '').trim()
    if (!text) continue
    const match = ROUTINE_PREFIX_RE.exec(text)
    if (!match) continue
    const time = normalizeTime(match[1])
    const rest = truncate(text.slice(match[0].length), MAX_PLAN_TEXT)
    if (!time || !rest) continue
    items.push({ time, text: rest, key: false })
  }
  return normalizePlan(items)
}

/**
 * Apply at most `MAX_OPS` edits from the agent.
 *
 * Operations:
 * - `{ op: 'add', time, text, key? }` — insert (duplicate items are ignored)
 * - `{ op: 'update', index?, time?, text?, key? }` — patch an item; `time` also
 *   preserves chronological order by re-sorting
 * - `{ op: 'remove', index? }` — delete an item
 *
 * `index` is the 1-based position in the current rendered plan, which is what a
 * model sees when it reads the plan. Ops are applied in order and an invalid op
 * aborts only that op, never the valid ones before it.
 *
 * @param {Array<{ time: string, text: string, key: boolean }>} plan
 * @param {unknown} rawOps
 * @returns {{ plan: Array<{ time: string, text: string, key: boolean }>,
 *   applied: number, errors: string[] }}
 */
export function applyPlanOps(plan, rawOps) {
  const current = normalizePlan(plan)
  const errors = []
  let applied = 0
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    return { plan: current, applied, errors: ['ops 必须是非空数组'] }
  }
  if (rawOps.length > MAX_OPS) {
    return { plan: current, applied, errors: [`一次最多改 ${MAX_OPS} 处`] }
  }
  for (const raw of rawOps) {
    if (!raw || typeof raw !== 'object') {
      errors.push('无效的操作')
      continue
    }
    const op = /** @type {Record<string, any>} */ (raw)
    const kind = String(op.op ?? '').toLowerCase()
    const index = Number.isInteger(op.index) ? op.index : null
    if (kind === 'add') {
      const item = normalizePlanItem(op)
      if (!item) {
        errors.push('add 需要合法的 time 与 text')
        continue
      }
      if (current.length >= MAX_PLAN_ITEMS) {
        errors.push(`日程最多 ${MAX_PLAN_ITEMS} 条`)
        continue
      }
      current.push(item)
      current.sort((a, b) => timeMinutes(a.time) - timeMinutes(b.time))
      applied += 1
      continue
    }
    if (kind === 'update') {
      if (index === null || index < 1 || index > current.length) {
        errors.push('update 需要有效的 index（从 1 开始）')
        continue
      }
      const target = current[index - 1]
      const time = op.time === undefined ? target.time : normalizeTime(op.time)
      const text = op.text === undefined ? target.text : truncate(op.text, MAX_PLAN_TEXT)
      const key = op.key === undefined ? target.key : op.key === true
      if (!time || !text) {
        errors.push('update 的 time 或 text 非法')
        continue
      }
      current[index - 1] = { time, text, key }
      current.sort((a, b) => timeMinutes(a.time) - timeMinutes(b.time))
      applied += 1
      continue
    }
    if (kind === 'remove') {
      if (index === null || index < 1 || index > current.length) {
        errors.push('remove 需要有效的 index（从 1 开始）')
        continue
      }
      current.splice(index - 1, 1)
      applied += 1
      continue
    }
    errors.push(`未知操作 ${kind || '(空)'}`)
  }
  return { plan: normalizePlan(current), applied, errors }
}

/**
 * Plain-text plan lines for prompts and command output.
 *
 * @param {Array<{ time: string, text: string, key?: boolean }>} plan
 * @param {{ numbered?: boolean }} [options]
 */
export function renderPlan(plan, options = {}) {
  return plan
    .map((item, i) => {
      const prefix = options.numbered ? `${i + 1}. ` : ''
      return `${prefix}${item.time} ${item.text}${item.key ? '（有约）' : ''}`
    })
    .join('\n')
}
