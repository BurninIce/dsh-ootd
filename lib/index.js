/**
 * dsh-ootd — a daily-life anchor plugin for a role-play agent.
 *
 * Once a day it generates, with one auxiliary model call, a "today" that the
 * conversation can stand in: a small everyday scene, the real weather of a
 * configured city, a schedule, and an English outfit phrase. The result is
 * injected per agent as a system-prompt section and is readable/editable through
 * tools and `/ootd`.
 *
 * Design boundaries:
 * - Generation is background and cached; prompt assembly never waits on a model.
 * - The plugin stores only JSON under `$DSH_HOME/ootd` (or a configured dir).
 * - Chat text never reaches this plugin's model call; only config/card/weather.
 */

import z from '@deepseek-ai/schemastery'
import { CardLoader, resolveDataDir } from './card.js'
import { resolveConfig } from './config.js'
import { OotdEngine } from './engine.js'
import { makeCompleter, routeFromAgent } from './llm.js'
import { OotdStore } from './store.js'
import { buildTools } from './tools.js'
import { fetchWeather } from './weather.js'

export const name = 'ootd'
export const inject = ['systemPrompt', 'tools', 'commands', 'llm', 'timer']

const bandSchema = z.object({
  id: z.string().required().description('档位 id，如 cold / hot'),
  below: z.number().description('体感温度上限（不含），最后一档省略表示无上限'),
  hint: z.string().default('').description('给模型的该档着装提示'),
  requireAny: z.array(z.string()).default([]).description('必须包含其中任意一个词'),
  forbid: z.array(z.string()).default([]).description('禁止出现的词'),
  fallback: z.array(z.string()).default([]).description('模型输出不合格时轮换使用的英文着装'),
})

const outfitSchema = z.object({
  line: z.string().default("Today's outfit: {outfit}").description('注入行模板，{outfit} 会被替换'),
  bands: z.array(bandSchema).default([]).description('按体感温度划分的着装档（留空用内置档）'),
  seasonBand: z.dict(z.string()).default({}).description('拿不到天气时按月份选档：1-12 → band id'),
  rainWords: z.array(z.string()).default([]).description('雨雪关键词（用于补伞）'),
  snowWords: z.array(z.string()).default([]).description('雪关键词'),
  umbrella: z.string().default('').description('雨雪天追加的英文短语'),
})

const personaSchema = z.object({
  name: z.string().default('').description('角色名'),
  gender: z.string().default('').description('性别，用于提示词'),
  age: z.string().default('').description('外表年龄/描述'),
  residence: z.string().default('').description('居住地描述'),
  style: z.string().default('').description('日常着装风格'),
})

const notesSchema = z.object({
  daily: z.string().default('').description('今日日常块尾注'),
  weather: z.string().default('').description('天气块尾注'),
  plan: z.string().default('').description('日程块尾注'),
  outfit: z.string().default('').description('着装块尾注'),
})

export const Config = z.object({
  enabled: z.boolean().default(true).description('是否启用'),
  dataDir: z.string().default('').description('缓存目录，留空为 $DSH_HOME/ootd'),
  cardFile: z.string().default('').description('可选：角色卡 card.json 路径（读 static/outfit/life）'),
  applyToSubagents: z.boolean().default(false).description('是否也注入子 agent 会话'),
  sceneCity: z.string().default('').description('场景城市名；留空用「她居住的城市」'),
  weatherCity: z.string().default('北京').description('真实天气查询城市（只作数据源）'),
  placeTypes: z.array(z.string()).default([]).description('场所类别轮换池，留空用内置七类'),
  persona: personaSchema.default({}),
  outfit: outfitSchema.default({}),
  routine: z.array(z.string()).default([]).description('固定作息（角色卡 life.routine 同格式）'),
  habits: z.array(z.string()).default([]).description('生活习惯'),
  notes: notesSchema.default({}),
  provider: z.string().default('').description('生成用 provider；留空沿用会话当前路由'),
  model: z.string().default('').description('生成用 model；与 provider 成对'),
  maxTokens: z.number().step(1).min(200).max(4000).default(900),
  temperature: z.number().min(0).max(2).default(0.95),
  timeoutMs: z.number().step(1).min(5000).max(180000).default(60000),
  retryMinutes: z.number().step(1).min(1).max(240).default(15),
  minSceneChars: z.number().step(1).min(1).max(1000).default(20),
  maxSceneChars: z.number().step(1).min(20).max(2000).default(220),
  recentDays: z.number().step(1).min(1).max(60).default(10),
  injectDaily: z.boolean().default(true),
  injectWeather: z.boolean().default(true),
  injectPlan: z.boolean().default(true),
  injectOutfit: z.boolean().default(true),
})

/** Section order: after first-party guidance, before the persona suffix. */
const SECTION_ORDER = 8000
const SECTION_NAME = 'ootd:today'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const log = ctx.logger('ootd')
  const cardLoader = new CardLoader({ warn: (message) => log.warn(message) })

  /** Re-resolve cheaply so card edits take effect without a plugin reload. */
  const configNow = () =>
    resolveConfig(rawConfig, { card: cardLoader.load(rawConfig?.cardFile ?? '') })

  let config = configNow()
  const store = new OotdStore(resolveDataDir(config.dataDir), { warn: (m) => log.warn(m) })
  const engine = new OotdEngine({
    store,
    config,
    complete: makeCompleter(ctx),
    fetchWeather,
    logger: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  })

  const refreshConfig = () => {
    config = configNow()
    engine.config = config
    return config
  }

  /** @type {Map<string, any>} sessionId → agent */
  const agents = new Map()
  /** @type {Map<any, () => void>} agent → section disposer */
  const sectionOff = new Map()

  /**
   * Generate today if missing. Never throws into an event handler.
   * @param {any} agent
   * @param {boolean} force
   */
  async function ensureToday(agent, force = false) {
    const current = refreshConfig()
    try {
      return await engine.ensure({ route: routeFromAgent(current, agent), force })
    } catch (error) {
      log.warn(`今日日常后台生成异常：${String(error?.message ?? error)}`)
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }

  for (const tool of buildTools({
    engine,
    config,
    routeForAgent: (agent) => routeFromAgent(refreshConfig(), agent),
  })) {
    ctx.tools.register(tool)
  }

  ctx.commands.register({
    name: 'ootd',
    description: '查看今天的日常场景、天气、日程与着装；/ootd refresh 重新生成',
    input: { hint: '留空查看，或输入 refresh' },
    async handler(invocation) {
      const arg = String(invocation.rawInput ?? '').trim().toLowerCase()
      if (arg && !['refresh', '刷新', '重新生成'].includes(arg)) {
        return { kind: 'error', text: '用法：/ootd 或 /ootd refresh' }
      }
      if (arg) {
        const result = await ensureToday(invocation.agent, true)
        if (!result.ok) return { kind: 'error', text: `生成失败：${result.reason ?? '未知原因'}` }
        return { kind: 'success', text: engine.summary() }
      }
      if (!engine.today()) {
        const result = await ensureToday(invocation.agent, false)
        if (!result.ok) {
          return {
            kind: 'success',
            text: engine.today()
              ? engine.summary()
              : `今天还没有日常场景（${result.reason ?? '正在生成'}）。稍后会自动重试。`,
          }
        }
      }
      return { kind: 'success', text: engine.summary() }
    },
  })

  ctx.provide('ootd', {
    /** @returns {Record<string, any>} */
    status: () => engine.status(),
    /** @returns {string} */
    summary: () => engine.summary(),
    /** @param {any} agent @param {boolean} [force] */
    refresh: (agent, force = true) => ensureToday(agent, force),
    /** @param {unknown} ops */
    editPlan: (ops) => engine.editPlan(ops),
  })

  /**
   * Per-agent injection. Registering on `agent.ctx` scopes the section to that
   * agent only; the disposer is kept so a plugin reload cannot leave a stale
   * section registered in a live agent.
   */
  ctx.on('agent/created', (payload) => {
    const agent = payload.agent
    if (!config.applyToSubagents && agent.session?.header?.origin === 'subagent') return
    agents.set(agent.session.id, agent)
    const off = agent.ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: () => {
        refreshConfig()
        try {
          return engine.renderBlocks()
        } catch (error) {
          log.warn(`今日日常注入失败：${String(error?.message ?? error)}`)
          return ''
        }
      },
    })
    sectionOff.set(agent, off)
    // The first turn has no logged route yet, so this may be a no-op; turn/end
    // retries with the route the session actually used.
    void ensureToday(agent, false)
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload.agent
    agents.delete(agent.session.id)
    const off = sectionOff.get(agent)
    if (off) off()
    sectionOff.delete(agent)
  })

  // A date change (or a failed earlier attempt) is repaired on the next settled
  // turn; the engine's own lock/cooldown prevents duplicate calls.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const agent = agents.get(session.id)
    if (!agent) return
    if (engine.today()) return
    void ensureToday(agent, false)
  })

  // Keep the anchor fresh across midnight even when the conversation is idle.
  ctx.interval(() => {
    for (const agent of agents.values()) {
      if (!engine.today()) void ensureToday(agent, false)
    }
  }, 10 * 60_000)

  // Plugin unload: remove every section this instance added to a live agent.
  ctx.effect(() => () => {
    for (const off of sectionOff.values()) off()
    sectionOff.clear()
    agents.clear()
  })
}
