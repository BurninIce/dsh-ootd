import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { OotdEngine } from '../lib/engine.js'
import { buildUserPrompt, parseGeneration } from '../lib/generate.js'
import { OotdStore } from '../lib/store.js'

const SCENE = '临川市的老书店里，午后的光从高窗斜下来，落在旧书脊的烫金字上。店主把一摞新收的旧书摊在柜台上，纸页带着潮湿的凉意。'
const OUTFIT = 'A black trench coat over a white blouse, a black pleated skirt, black tights and loafers.'

function fixedNow() {
  return new Date(2026, 10, 10, 8, 0, 0).getTime()
}

function makeEngine(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ootd-'))
  const config = resolveConfig({
    routine: ['07:30-08:30 起床，泡一壶红茶', '18:00-19:00 晚饭'],
    ...overrides,
  })
  let calls = 0
  const engine = new OotdEngine({
    store: new OotdStore(dir),
    config,
    complete: async () => {
      calls += 1
      return JSON.stringify({
        scene: SCENE,
        outfit: OUTFIT,
        plan: [
          { time: '07:30', text: '起床，泡一壶红茶', key: false },
          { time: '15:00', text: '和牙医约好', key: true },
        ],
      })
    },
    fetchWeather: async (city) => ({ city, tempC: 12, feelsC: 12, desc: '小雨', humidity: '70', wind: '8' }),
    now: fixedNow,
    logger: { info() {}, warn() {} },
  })
  return {
    engine,
    dir,
    calls: () => calls,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

test('parseGeneration accepts a valid JSON object', () => {
  const config = resolveConfig({ routine: [] })
  const parsed = parseGeneration(
    JSON.stringify({ scene: SCENE, outfit: OUTFIT, plan: [{ time: '08:00', text: '早饭', key: false }] }),
    config,
    { weather: { tempC: 12, desc: '晴' }, placeType: 'x', date: new Date(2026, 10, 10) },
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.scene, SCENE)
  assert.equal(parsed.plan.length, 1)
})

test('parseGeneration rejects refusals and short scenes', () => {
  const config = resolveConfig({})
  const refusal = parseGeneration('抱歉，由于您没有提供天气数据，无法生成。', config, {
    weather: null,
    placeType: '',
    date: new Date(),
  })
  assert.equal(refusal.ok, false)
  const short = parseGeneration('太短。', config, { weather: null, placeType: '', date: new Date() })
  assert.equal(short.ok, false)
})

test('parseGeneration accepts a bare scene and falls back to the routine plan', () => {
  const config = resolveConfig({ routine: ['07:30-08:30 起床'] })
  const parsed = parseGeneration(SCENE, config, { weather: null, placeType: '', date: new Date(2026, 10, 10) })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.origin, 'text')
  assert.equal(parsed.plan.length, 1)
  assert.match(parsed.outfit, /coat|jacket|cardigan/i)
})

test('buildUserPrompt carries weather, place type, dedupe and card routine', () => {
  const config = resolveConfig({ routine: ['07:30-08:30 起床'], sceneCity: '临川市' })
  const prompt = buildUserPrompt(config, {
    weather: { tempC: 12, desc: '小雨' },
    weatherText: '气温 12°C、小雨',
    placeType: '饮食场所',
    recent: ['昨天在咖啡馆。'],
    date: new Date(),
    bandHint: '11–14°C：长袖',
  })
  assert.match(prompt, /临川市/)
  assert.match(prompt, /气温 12°C、小雨/)
  assert.match(prompt, /饮食场所/)
  assert.match(prompt, /昨天在咖啡馆/)
  assert.match(prompt, /07:30-08:30 起床/)
  assert.match(prompt, /"scene"/)
})

test('engine generates once, caches, renders all four blocks and edits the plan', async () => {
  const ctx = makeEngine()
  try {
    const first = await ctx.engine.ensure({ route: { provider: 'p', model: 'm' } })
    assert.equal(first.ok, true)
    assert.equal(ctx.calls(), 1)
    assert.equal(ctx.engine.today().scene, SCENE)
    assert.equal(ctx.engine.today().weather.tempC, 12)

    const second = await ctx.engine.ensure({ route: { provider: 'p', model: 'm' } })
    assert.equal(second.ok, true)
    assert.equal(ctx.calls(), 1)

    const blocks = ctx.engine.renderBlocks()
    assert.match(blocks, /【今日日常】/)
    assert.match(blocks, /【今日天气】\n气温 12°C、小雨/)
    assert.match(blocks, /【今天的安排】/)
    assert.match(blocks, /15:00 和牙医约好（有约）/)
    assert.match(blocks, /【今日着装】\nToday's outfit:/)
    assert.match(blocks, /umbrella/)

    const edited = ctx.engine.editPlan([{ op: 'add', time: '20:00', text: '给小林回电话', key: true }])
    assert.equal(edited.ok, true)
    assert.equal(ctx.engine.today().plan.length, 3)
    assert.match(ctx.engine.renderBlocks(), /20:00 给小林回电话/)

    const summary = ctx.engine.summary()
    assert.match(summary, /今日日常/)
  } finally {
    ctx.cleanup()
  }
})

test('engine requires a route and refuses to generate without one', async () => {
  const ctx = makeEngine()
  try {
    const result = await ctx.engine.ensure({ route: null })
    assert.equal(result.ok, false)
    assert.match(result.reason, /路由/)
    assert.equal(ctx.calls(), 0)
  } finally {
    ctx.cleanup()
  }
})

test('a refused generation enters cooldown and is not cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ootd-'))
  const config = resolveConfig({ retryMinutes: 15 })
  const engine = new OotdEngine({
    store: new OotdStore(dir),
    config,
    complete: async () => '抱歉，无法生成。',
    fetchWeather: async () => null,
    now: fixedNow,
    logger: { info() {}, warn() {} },
  })
  try {
    const failed = await engine.ensure({ route: { provider: 'p', model: 'm' } })
    assert.equal(failed.ok, false)
    assert.equal(engine.today(), null)
    const duringCooldown = await engine.ensure({ route: { provider: 'p', model: 'm' } })
    assert.equal(duringCooldown.ok, false)
    assert.match(duringCooldown.reason, /冷却/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a new day invalidates the cache and regenerates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ootd-'))
  let now = fixedNow()
  let calls = 0
  const engine = new OotdEngine({
    store: new OotdStore(dir),
    config: resolveConfig({}),
    complete: async () => {
      calls += 1
      return JSON.stringify({ scene: `${SCENE}${calls}`, outfit: OUTFIT, plan: [] })
    },
    fetchWeather: async () => null,
    now: () => now,
    logger: { info() {}, warn() {} },
  })
  try {
    assert.equal((await engine.ensure({ route: { provider: 'p', model: 'm' } })).ok, true)
    assert.equal(calls, 1)
    now += 86_400_000
    assert.equal(engine.today(), null)
    assert.equal((await engine.ensure({ route: { provider: 'p', model: 'm' } })).ok, true)
    assert.equal(calls, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
