/**
 * Prompt construction, model-output parsing, and validation for one day.
 *
 * A single model call produces the scene, the English outfit phrase and the
 * schedule. Each part is validated independently: a bad outfit falls back to the
 * temperature band preset, a bad plan falls back to the card routine, and an
 * unusable scene makes the whole generation fail so no refusal text is ever
 * cached and injected for a whole day.
 */

import { pickOutfit } from './weather.js'
import { normalizePlan, routinePlan } from './plan.js'
import { parseJsonObject, truncate } from './util.js'

const REFUSAL_MARKS = ['请补充', '由于您', '未提供', '无法生成', '无法准确', '抱歉', '作为AI', '作为 AI']

/**
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 */
export function buildSystemPrompt(config) {
  const name = config.persona.name || '她'
  return (
    `你是一个生活场景生成器，为角色扮演角色「${name}」生成「今天」的环境、日程与着装。` +
    '只输出一个 JSON 对象，不要代码块、不要任何解释。所有中文文本不要写相对时间词（今天/昨天/刚才）。'
  )
}

/**
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {{ weather: Record<string, any> | null, weatherText: string, placeType: string,
 *   recent: string[], date: Date }} input
 */
export function buildUserPrompt(config, input) {
  const name = config.persona.name || '她'
  const pronouns = config.persona.gender === 'male' ? '他' : '她'
  const city = config.sceneCity || '她居住的城市'
  const lines = []
  lines.push(
    `角色：${name}。${config.persona.gender || ''}，外表 ${config.persona.age || '不详'}，` +
      `住在 ${config.persona.residence || city}。日常风格：${config.persona.style || '简洁自然'}。`,
  )
  lines.push('')
  lines.push(`场景地点：${city}（虚构或真实的日常城市，保持统一）。`)
  if (input.weatherText) {
    lines.push(
      `今日天气实况（真实数据，当作${city}的天气）：${input.weatherText}。` +
        '请把这些天气写进场景，不要编造不同的天气；天气描述原文可能是英文，写作时译成自然中文；' +
        '只写气温与天气现象，不要出现湿度、风速、气压等数值，也不要罗列天气数据。',
    )
  } else {
    lines.push(
      '今天拿不到天气数据：只写环境氛围，不要出现具体气温或天气词；' +
        '不要提「数据」两个字，也不要向用户索要天气。',
    )
  }
  lines.push(
    `今天要写的场所类型（硬性边界）：${input.placeType}。具体场所由你选择，但必须属于这个类型；` +
      '地点与小事都要与这个类型相称，不得跨到其他类型。',
  )
  if (input.recent.length) {
    lines.push('')
    lines.push(
      '最近写过这些场景（只用于查重）：今天的场所类别与小事的类别都必须与它们不同。' +
        '只更换名称、同义说法，或换成同一类场所、同一类行为，都算重复。禁止照抄、改写或沿用其中任何具体场所、事件与句子。',
    )
    for (const scene of input.recent) lines.push(`· ${scene}`)
  }
  lines.push('')
  lines.push('场景写 2-3 句纯中文，只包含：')
  lines.push('1. 一处该城市内日常可达的场所（室内或室外均可），场所要能让下一句的小事自然发生；')
  lines.push('2. 一件普通的、可观察的日常小事，必须与场所和天气相称，不涉及他人对话，也不写心理活动。')
  lines.push('硬性要求：')
  lines.push('- 体感必须与气温一致：低于 15°C 写凉/冷（别写燥热、冷气、大汗），15-26°C 写舒适，高于 28°C 才写热；天气词必须与实况一致')
  lines.push(`- 不写时段；不写任何新闻、时事、财经、社会热点；不写对话；不写动物；不出现其他城市名`)
  lines.push('- 句式和动作描写不得沿用固定模板；只写日常、贴近现实；不要解释、评价或加标题')
  lines.push('')
  const bandHint = input.bandHint ? `必须符合上面的实况天气：${input.bandHint}` : '必须符合上面的实况天气'
  lines.push(
    `着装：为${name}搭配今天的着装。${pronouns}的外表与日常风格见上。${bandHint}。` +
      '用一句英文，15-40 个英文单词，只写衣物、鞋与随身配饰，不写发型与动作，不要中文。',
  )
  lines.push('')
  const routine = config.routine.length
    ? config.routine.map((line) => `· ${line}`).join('\n')
    : '（没有固定作息，按她的性格与今天的状态安排。）'
  lines.push(`日程：为${name}排出今天的日程表。固定作息（只作参考，允许按天气与场景微调）：`)
  lines.push(routine)
  if (config.habits.length) lines.push(`习惯：${config.habits.join('；')}`)
  lines.push(
    '日程 6-9 条，从早到晚覆盖一天，时间用 24 小时制 HH:MM，按时间排序；' +
      '每条一句话（8-30 字），写她自己正在做什么、去了哪里，必须与上面的场景、天气相称，与她平时的生活节奏一致。' +
      'key=true 只标她确实和别人约好、有具体时间的安排（有约、等人、给人带东西）；当天没有这种约定就全部写 false，' +
      '不要为了凑数把吃饭、出门这类日常标成 key。',
  )
  lines.push('')
  lines.push(
    '只输出一个 JSON 对象，不要代码块、不要任何解释：' +
      '{"scene": "上面要求的场景描述（中文）", "outfit": "一句英文着装描述，15-40 个英文单词，只写衣物、鞋与随身配饰，不写发型与动作", ' +
      '"plan": [{"time": "HH:MM", "text": "一句话", "key": false}]}',
  )
  return lines.join('\n')
}

/**
 * Whether a scene is usable as injected atmosphere.
 *
 * @param {string} text
 * @param {{ minSceneChars: number, maxSceneChars: number }} config
 */
export function sceneOk(text, config) {
  const value = String(text ?? '').trim()
  if (value.length < config.minSceneChars || value.length > config.maxSceneChars) return false
  const squeezed = value.replace(/\s+/gu, '')
  return !REFUSAL_MARKS.some((mark) => squeezed.includes(mark))
}

/**
 * Parse and validate one generation.
 *
 * @param {string} rawText
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {{ weather: Record<string, any> | null, placeType: string, date: Date }} input
 * @returns {{ ok: true, scene: string, outfit: string, plan: Array<Record<string, any>>,
 *   origin: 'json' | 'text' } | { ok: false, reason: string }}
 */
export function parseGeneration(rawText, config, input) {
  const raw = String(rawText ?? '').trim()
  if (!raw) return { ok: false, reason: '模型输出为空' }
  const parsed = parseJsonObject(raw)
  let scene = ''
  let outfit = ''
  let plan = []
  let origin = 'json'
  if (parsed && typeof parsed === 'object' && typeof parsed.scene === 'string') {
    scene = parsed.scene.trim()
    outfit = typeof parsed.outfit === 'string' ? parsed.outfit.trim() : ''
    plan = Array.isArray(parsed.plan) ? parsed.plan : []
  } else {
    // Not JSON: accept a bare scene when it looks like one, otherwise fail.
    scene = raw.replace(/^```[a-z]*\s*/iu, '').replace(/```$/u, '').trim()
    origin = 'text'
  }
  if (!sceneOk(scene, config)) {
    return {
      ok: false,
      reason: `场景无效（${scene.length} 字）：${truncate(scene.replace(/\s+/gu, ' '), 60) || '(空)'}`,
    }
  }
  const normalizedPlan = normalizePlan(plan)
  const fallbackPlan = normalizedPlan.length ? normalizedPlan : routinePlan(config.routine)
  const chosenOutfit = pickOutfit(outfit, input.weather, config.outfit, input.date)
  return {
    ok: true,
    scene: truncate(scene, config.maxSceneChars),
    outfit: chosenOutfit,
    plan: fallbackPlan,
    origin,
  }
}
