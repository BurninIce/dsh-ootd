/**
 * The ootd engine: one cached "today" per calendar day, produced by one model
 * call, read synchronously by the prompt provider, and editable through a small
 * bounded plan API.
 *
 * No DSH import lives here. The LLM call and the weather fetch are injected, so
 * the whole engine is exercised by unit tests with deterministic fakes.
 */

import { buildSystemPrompt, buildUserPrompt, parseGeneration } from './generate.js'
import { applyPlanOps, normalizePlan, renderPlan } from './plan.js'
import { formatWeather, pickBand } from './weather.js'
import { dateKey, truncate } from './util.js'

/** @typedef {(input: { route: { provider: string, model: string },
 *   system: string, user: string, maxTokens: number, temperature: number,
 *   timeoutMs: number }) => Promise<string>} CompleteFn */

export class OotdEngine {
  /**
   * @param {{
   *   store: import('./store.js').OotdStore,
   *   config: ReturnType<import('./config.js').resolveConfig>,
   *   complete: CompleteFn,
   *   fetchWeather: (city: string) => Promise<Record<string, any> | null>,
   *   logger?: { info: Function, warn: Function, debug?: Function },
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.store = options.store
    this.config = options.config
    this.complete = options.complete
    this.fetchWeather = options.fetchWeather
    this.log = options.logger ?? { info() {}, warn() {} }
    this.now = options.now ?? Date.now
    this.failUntil = 0
    this.generating = false
    this.lastError = ''
  }

  /** @returns {import('./store.js').TodayCache | null} today's cache, or null */
  today() {
    if (!this.config.enabled) return null
    const cache = this.store.read(this.now())
    if (!cache || cache.date !== dateKey(new Date(this.now())) || !cache.scene) return null
    return cache
  }

  /** @returns {string} the injected block text, or '' when there is nothing yet */
  renderBlocks() {
    const cache = this.today()
    if (!cache) return ''
    const blocks = []
    if (this.config.injectDaily) {
      blocks.push(`【今日日常】\n${cache.scene}${this.config.notes.daily ? `\n${this.config.notes.daily}` : ''}`)
    }
    const weatherText = formatWeather(cache.weather)
    if (this.config.injectWeather && weatherText) {
      blocks.push(`【今日天气】\n${weatherText}${this.config.notes.weather ? `\n${this.config.notes.weather}` : ''}`)
    }
    if (this.config.injectPlan && cache.plan.length) {
      blocks.push(`【今天的安排】\n${renderPlan(cache.plan)}${this.config.notes.plan ? `\n${this.config.notes.plan}` : ''}`)
    }
    if (this.config.injectOutfit && cache.outfit) {
      const line = this.config.outfit.line.replace('{outfit}', cache.outfit)
      blocks.push(`【今日着装】\n${line}${this.config.notes.outfit ? `\n${this.config.notes.outfit}` : ''}`)
    }
    return blocks.join('\n\n')
  }

  /**
   * Ensure today's cache exists; generate once when it does not.
   *
   * @param {{ route?: { provider: string, model: string } | null, force?: boolean }} [options]
   * @returns {Promise<{ ok: boolean, reason?: string, data?: import('./store.js').TodayCache }>}
   */
  async ensure(options = {}) {
    const force = options.force === true
    const current = this.today()
    if (!force && current) return { ok: true, data: current }
    if (!this.config.enabled) return { ok: false, reason: '插件已禁用' }
    if (this.now() < this.failUntil) return { ok: false, reason: '冷却中，稍后再试' }
    if (this.generating) return { ok: false, reason: '正在生成' }
    const route = options.route
    if (!route?.provider || !route?.model) return { ok: false, reason: '没有可用的模型路由' }
    this.generating = true
    try {
      const now = new Date(this.now())
      const today = dateKey(now)
      const cached = this.store.read(this.now())
      const recentScenes = this.store.recentScenes(today).slice(-this.config.recentDays)
      const recentTypes = new Set(this.store.recentPlaceTypes(today))
      const freeTypes = this.config.placeTypes.filter((type) => !recentTypes.has(type))
      const placeType =
        (freeTypes.length ? freeTypes : this.config.placeTypes)[
          Math.floor(Math.random() * (freeTypes.length ? freeTypes.length : this.config.placeTypes.length))
        ] || ''
      const weather = await this.fetchWeather(this.config.weatherCity).catch(() => null)
      const band = pickBand(weather, this.config.outfit, now)
      const system = buildSystemPrompt(this.config)
      const user = buildUserPrompt(this.config, {
        weather,
        weatherText: formatWeather(weather),
        placeType,
        recent: recentScenes,
        date: now,
        bandHint: band?.hint ?? '',
      })
      const raw = await this.complete({
        route,
        system,
        user,
        maxTokens: this.config.generation.maxTokens,
        temperature: this.config.generation.temperature,
        timeoutMs: this.config.generation.timeoutMs,
      })
      const parsed = parseGeneration(raw, this.config, { weather, placeType, date: now })
      if (!parsed.ok) {
        this.failUntil = this.now() + this.config.generation.retryMinutes * 60_000
        this.lastError = parsed.reason
        this.log.warn(`今日日常生成无效，${this.config.generation.retryMinutes} 分钟后再试：${parsed.reason}`)
        return { ok: false, reason: parsed.reason }
      }
      const previousRecent = Array.isArray(cached?.recent) ? cached.recent : []
      const rows = previousRecent
        .filter((row) => row && row.date !== today && row.scene)
        .concat({ date: today, scene: parsed.scene, placeType })
        .slice(-this.config.recentDays)
      /** @type {import('./store.js').TodayCache} */
      const data = {
        date: today,
        scene: parsed.scene,
        outfit: parsed.outfit,
        weather,
        plan: normalizePlan(parsed.plan),
        placeType,
        createdAt: this.now(),
        source: 'generated',
        recent: rows,
      }
      this.store.write(data)
      this.failUntil = 0
      this.lastError = ''
      this.log.info(
        `今日日常已生成（${placeType || '未分类'}，${parsed.scene.length} 字，日程 ${data.plan.length} 条）`,
      )
      return { ok: true, data }
    } catch (error) {
      this.failUntil = this.now() + this.config.generation.retryMinutes * 60_000
      this.lastError = String(error?.message ?? error)
      this.log.warn(`今日日常生成失败：${this.lastError}`)
      return { ok: false, reason: this.lastError }
    } finally {
      this.generating = false
    }
  }

  /**
   * Apply agent edits to today's plan.
   *
   * @param {unknown} ops
   * @returns {{ ok: boolean, applied: number, errors: string[], plan: Array<Record<string, any>> }}
   */
  editPlan(ops) {
    const cache = this.today()
    if (!cache) return { ok: false, applied: 0, errors: ['今天还没有生成日程'], plan: [] }
    const result = applyPlanOps(cache.plan, ops)
    if (result.applied > 0) {
      this.store.write({ ...cache, plan: result.plan })
      this.log.info(`日程已修改 ${result.applied} 处${result.errors.length ? `（${result.errors.join('；')}）` : ''}`)
    }
    return { ok: result.applied > 0, applied: result.applied, errors: result.errors, plan: result.plan }
  }

  /** @returns {Record<string, any>} a compact object for tools and `/ootd` */
  status() {
    const cache = this.today()
    return {
      date: dateKey(new Date(this.now())),
      hasToday: Boolean(cache),
      scene: cache?.scene ?? '',
      sceneChars: cache?.scene?.length ?? 0,
      weather: cache?.weather ? formatWeather(cache.weather) : '',
      outfit: cache?.outfit ?? '',
      plan: cache?.plan ?? [],
      planText: cache ? renderPlan(cache.plan) : '',
      placeType: cache?.placeType ?? '',
      coolingDown: this.now() < this.failUntil,
      lastError: this.lastError,
    }
  }

  /** Human-readable summary for the `/ootd` command. */
  summary() {
    const status = this.status()
    if (!status.hasToday) {
      return status.coolingDown
        ? `今天还没有日常场景；上次生成失败（${status.lastError || '未知原因'}），稍后会自动重试。`
        : '今天还没有日常场景，正在后台生成；也可以发 /ootd refresh 立即重试。'
    }
    const lines = [`【今日日常】${truncate(status.scene, 200)}`]
    if (status.weather) lines.push(`【今日天气】${status.weather}`)
    if (status.outfit) lines.push(`【今日着装】${status.outfit}`)
    if (status.plan.length) lines.push(`【今天的安排】\n${status.planText}`)
    return lines.join('\n\n')
  }
}
