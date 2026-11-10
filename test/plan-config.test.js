import assert from 'node:assert/strict'
import test from 'node:test'

import { cardToPartial, normalizeOutfit, resolveConfig } from '../lib/config.js'
import {
  applyPlanOps,
  normalizePlan,
  normalizeTime,
  renderPlan,
  routinePlan,
} from '../lib/plan.js'

test('normalizeTime accepts 24h values and rejects junk', () => {
  assert.equal(normalizeTime('7:05'), '07:05')
  assert.equal(normalizeTime('23:59'), '23:59')
  assert.equal(normalizeTime('24:00'), null)
  assert.equal(normalizeTime('12:60'), null)
  assert.equal(normalizeTime('12'), null)
})

test('normalizePlan sorts, dedupes, caps and trims', () => {
  const plan = normalizePlan([
    { time: '18:00', text: '晚饭', key: false },
    { time: '07:30', text: '起床', key: false },
    { time: '07:30', text: '起床' },
    { time: 'bad', text: 'x' },
    { time: '09:00', text: '' },
  ])
  assert.deepEqual(plan, [
    { time: '07:30', text: '起床', key: false },
    { time: '18:00', text: '晚饭', key: false },
  ])
  const many = Array.from({ length: 20 }, (_, i) => ({
    time: `${String(i % 24).padStart(2, '0')}:00`,
    text: `第 ${i} 件事`,
  }))
  assert.equal(normalizePlan(many).length, 12)
})

test('routinePlan understands time ranges and single times', () => {
  const plan = routinePlan([
    '07:30-08:30 起床，泡一壶红茶',
    '23:30 洗漱，睡前留一盏小灯',
    '没有时间的习惯',
  ])
  assert.deepEqual(plan, [
    { time: '07:30', text: '起床，泡一壶红茶', key: false },
    { time: '23:30', text: '洗漱，睡前留一盏小灯', key: false },
  ])
})

test('applyPlanOps adds, updates by 1-based index, removes and reports errors', () => {
  const plan = [
    { time: '08:00', text: '早饭', key: false },
    { time: '12:00', text: '午饭', key: false },
  ]
  const added = applyPlanOps(plan, [{ op: 'add', time: '15:00', text: '和牙医约好', key: true }])
  assert.equal(added.applied, 1)
  assert.deepEqual(added.plan.map((i) => i.time), ['08:00', '12:00', '15:00'])
  assert.equal(added.plan[2].key, true)

  const updated = applyPlanOps(added.plan, [{ op: 'update', index: 2, text: '和小林吃饭', key: true }])
  assert.equal(updated.plan[1].text, '和小林吃饭')
  assert.equal(updated.plan[1].key, true)

  const removed = applyPlanOps(updated.plan, [{ op: 'remove', index: 1 }])
  assert.equal(removed.plan.length, 2)

  const bad = applyPlanOps(plan, [{ op: 'remove', index: 9 }])
  assert.equal(bad.applied, 0)
  assert.match(bad.errors[0], /index/)

  const tooMany = applyPlanOps(plan, [
    { op: 'add', time: '13:00', text: 'a' },
    { op: 'add', time: '14:00', text: 'b' },
    { op: 'add', time: '15:00', text: 'c' },
  ])
  assert.equal(tooMany.applied, 0)
  assert.match(tooMany.errors[0], /最多/)
})

test('applyPlanOps caps at 12 items and never mutates the input', () => {
  const full = Array.from({ length: 12 }, (_, i) => ({
    time: `${String(i + 8).padStart(2, '0')}:00`,
    text: `事项 ${i}`,
    key: false,
  }))
  const before = JSON.stringify(full)
  const result = applyPlanOps(full, [{ op: 'add', time: '23:00', text: '多出来的' }])
  assert.equal(result.applied, 0)
  assert.match(result.errors[0], /最多 12/)
  assert.equal(JSON.stringify(full), before)
})

test('renderPlan numbers only when asked', () => {
  const plan = [{ time: '08:00', text: '早饭', key: true }]
  assert.equal(renderPlan(plan), '08:00 早饭（有约）')
  assert.equal(renderPlan(plan, { numbered: true }), '1. 08:00 早饭（有约）')
})

test('resolveConfig applies neutral defaults', () => {
  const config = resolveConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.weatherCity, '北京')
  assert.equal(config.sceneCity, '')
  assert.equal(config.outfit.bands.length, 6)
  assert.equal(config.generation.maxTokens, 900)
  assert.ok(config.placeTypes.length >= 5)
  assert.match(config.outfit.line, /\{outfit\}/)
})

test('a card fills persona, outfit and routine; explicit config wins', () => {
  const card = {
    static: {
      Claiming: 'Example Character (Example)',
      Gender: 'female',
      Age: 'appears 18',
      Residence: '临川市',
      Clothing: { Style: 'black and wine-red' },
    },
    outfit: {
      line: "Today's outfit: {outfit}",
      bands: [
        {
          id: 'cold',
          below: 5,
          hint: '5°C 以下：厚外套',
          require_any: ['coat'],
          forbid: ['sandal'],
          fallback: ['A long black wool coat over a dress.'],
        },
      ],
      season_band: { 1: 'cold' },
      rain_words: ['rain'],
      umbrella: 'She carries a black umbrella.',
    },
    life: { routine: ['07:30-08:30 起床'], habits: ['午后容易犯困'] },
  }
  const config = resolveConfig({ sceneCity: '临川市' }, { card })
  assert.equal(config.persona.name, 'Example Character')
  assert.equal(config.persona.style, 'black and wine-red')
  assert.equal(config.routine.length, 1)
  assert.equal(config.habits[0], '午后容易犯困')
  assert.equal(config.outfit.bands[0].requireAny[0], 'coat')
  assert.equal(config.outfit.seasonBand['1'], 'cold')

  const overridden = resolveConfig(
    { persona: { name: '替代名' }, routine: ['09:00 自定义'] },
    { card },
  )
  assert.equal(overridden.persona.name, '替代名')
  assert.deepEqual(overridden.routine, ['09:00 自定义'])
})

test('cardToPartial tolerates a partial or empty card', () => {
  assert.deepEqual(cardToPartial(null), {})
  assert.deepEqual(cardToPartial({}), { persona: { name: '', gender: '', age: '', residence: '', style: '' }, outfit: undefined, routine: undefined, habits: undefined })
})

test('normalizeOutfit sorts bands, maps snake_case and drops unknown keys', () => {
  const normalized = normalizeOutfit({
    bands: [
      { id: 'hot', below: null },
      { id: 'cold', below: 5, require_any: ['coat'], fallback: ['x'], surprise: 'nope' },
    ],
    season_band: { 1: 'cold', 13: 'hot', bad: 'x' },
  })
  assert.deepEqual(normalized.bands.map((b) => b.id), ['cold', 'hot'])
  assert.equal(normalized.bands[0].requireAny[0], 'coat')
  assert.equal('surprise' in normalized.bands[0], false)
  assert.equal(normalized.seasonBand['1'], 'cold')
  assert.equal(normalized.seasonBand['13'], undefined)
})
