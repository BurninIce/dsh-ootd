/**
 * Configuration defaults and resolution for dsh-ootd.
 *
 * Two sources feed one effective config:
 *  1. the plugin's `config` row (Deployment YAML),
 *  2. an optional character card (`cardFile`) in a common `card.json` shape
 *     (`static` / `outfit` / `life`), so one asset can drive several tools.
 *
 * Plugin config wins; the card fills gaps; built-in neutral defaults fill the
 * rest. This module is pure: reading the card file is the caller's job.
 */

import { stringList, truncate } from './util.js'

/** Six seasonal bands, open-ended last. English fallbacks are generic on purpose. */
export const DEFAULT_BANDS = [
  {
    id: 'cold',
    below: 5,
    hint: '5°C 以下：需要厚外套（大衣或羽绒服），围巾、手套也合适',
    requireAny: ['coat', 'parka', 'down', 'puffer'],
    forbid: ['sleeveless', 'short-sleeve', 'short sleeve', 'sandal', 'shorts', 'linen', 'bare legs'],
    fallback: [
      'A long charcoal wool coat over a black knit dress, thermal tights, ankle boots and a dark scarf.',
      'A black down coat over a cream turtleneck and a grey wool skirt, black tights, boots and wine-red gloves.',
      'A black double-breasted coat, a thick knit sweater, a long dark skirt, thermal tights and short boots.',
    ],
  },
  {
    id: 'chilly',
    below: 11,
    hint: '5–10°C：必须有一件外套（大衣、夹克或开衫）',
    requireAny: ['coat', 'jacket', 'cardigan', 'blazer'],
    forbid: ['sleeveless', 'short-sleeve', 'short sleeve', 'sandal', 'shorts', 'linen', 'bare legs'],
    fallback: [
      'A black trench coat over a white blouse with a thin ribbon tie, a pleated skirt, black tights and short boots.',
      'A charcoal cardigan over a black long-sleeve dress, black tights, short boots and a small shoulder bag.',
      'A short wool jacket over a grey knit top, a dark plaid skirt, black tights and ankle boots.',
    ],
  },
  {
    id: 'cool',
    below: 15,
    hint: '11–14°C：长袖，轻薄外套更合适',
    requireAny: [],
    forbid: ['sleeveless', 'sandal', 'shorts', 'linen', 'bare legs'],
    fallback: [
      'A black trench coat over a white blouse, a black pleated skirt, black tights and loafers.',
      'A grey cardigan over a long-sleeve dress, black tights and short boots.',
      'A dark denim jacket over a striped long-sleeve top, black trousers and ankle boots.',
    ],
  },
  {
    id: 'mild',
    below: 23,
    hint: '15–22°C：轻薄分层，不要厚外套或围巾',
    requireAny: [],
    forbid: ['down jacket', 'down coat', 'down-lined', 'parka', 'puffer', 'wool coat', 'heavy coat', 'scarf', 'gloves', 'thermal', 'sleeveless', 'sandal'],
    fallback: [
      'A white blouse with a thin ribbon tie, a flared skirt, sheer tights and loafers.',
      'A long-sleeve dress with lace cuffs, a thin belt, sheer tights and short boots.',
      'A light cardigan over a plain dress, sheer tights and Mary Jane shoes.',
    ],
  },
  {
    id: 'warm',
    below: 28,
    hint: '23–27°C：单层轻薄衣物，不要外套、针织或围巾',
    requireAny: [],
    forbid: ['coat', 'down jacket', 'parka', 'puffer', 'scarf', 'gloves', 'knit', 'sweater', 'wool', 'turtleneck', 'thermal'],
    fallback: [
      'A short-sleeve blouse, a midi skirt and strap sandals.',
      'A white short-sleeve dress with a ribbon at the collar and flat shoes.',
      'A light linen blouse, a pleated skirt and loafers.',
    ],
  },
  {
    id: 'hot',
    hint: '28°C 以上：只穿透气的夏装，不要外套、针织、围巾、连裤袜或靴子',
    requireAny: [],
    forbid: ['coat', 'jacket', 'cardigan', 'down', 'parka', 'scarf', 'gloves', 'knit', 'sweater', 'wool', 'turtleneck', 'thermal', 'tights', 'boots', 'long-sleeve', 'long sleeve'],
    fallback: [
      'A light sleeveless dress with a thin belt, strap sandals and a wide-brimmed hat.',
      'A white short-sleeve blouse, a light flared skirt, sandals and a parasol.',
      'A breathable linen dress, flat sandals and a small crossbody bag.',
    ],
  },
]

/** Fallback month → band mapping for when no weather is available. */
export const DEFAULT_SEASON_BAND = {
  1: 'cold',
  2: 'cold',
  3: 'chilly',
  4: 'cool',
  5: 'mild',
  6: 'warm',
  7: 'hot',
  8: 'hot',
  9: 'mild',
  10: 'cool',
  11: 'chilly',
  12: 'cold',
}

/** Abstract place categories; the concrete venue is the model's choice. */
export const DEFAULT_PLACE_TYPES = [
  '户外自然与水域',
  '城市街道与广场',
  '交通与移动途中',
  '饮食场所',
  '零售与生活服务',
  '文化与娱乐',
  '居住与邻里',
]

export const DEFAULT_NOTES = {
  daily:
    '（以上为环境背景，是她今日的所见所闻：整段对话最多自然带过一两次，不要反复提起同一个地点或同一件小事，' +
    '聊别的话题时完全不用回到这个场景）',
  weather: '（天气是实况，场景里的天气以这条为准；不要罗列气温、湿度、风速等数值）',
  plan:
    '（以上是她自己今天的安排，不是谈话提纲；合适时自然带一句就好，不要逐条念出来，' +
    '也不要因为日程里没有的事就说自己没空）',
  outfit: '（英文，供生成图像时使用；只有被问到穿着或需要描写她时自然带过，不要照念英文原文）',
}

const BAND_KEYS = new Set(['id', 'below', 'hint', 'requireAny', 'forbid', 'fallback'])

/**
 * Normalize an outfit block coming from the plugin config or a card file.
 * Card files use snake_case keys (`require_any`, `season_band`, ...).
 *
 * @param {Record<string, any> | undefined | null} raw
 */
export function normalizeOutfit(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const rawBands = Array.isArray(source.bands)
    ? source.bands
    : Array.isArray(source.outfitBands)
      ? source.outfitBands
      : []
  const bands = []
  for (const entry of rawBands) {
    if (!entry || typeof entry !== 'object') continue
    const item = /** @type {Record<string, any>} */ (entry)
    const id = String(item.id ?? '').trim()
    if (!id) continue
    const band = {
      id,
      below:
        item.below === null || item.below === undefined
          ? undefined
          : Number.isFinite(Number(item.below))
            ? Number(item.below)
            : undefined,
      hint: truncate(item.hint, 200),
      requireAny: stringList(item.requireAny ?? item.require_any),
      forbid: stringList(item.forbid),
      fallback: stringList(item.fallback).map((line) => truncate(line, 400)),
    }
    for (const key of Object.keys(band)) if (!BAND_KEYS.has(key)) delete band[key]
    bands.push(band)
  }
  bands.sort((a, b) => {
    const av = a.below ?? Number.POSITIVE_INFINITY
    const bv = b.below ?? Number.POSITIVE_INFINITY
    return av - bv
  })
  const seasonBand = {}
  const rawSeason = source.seasonBand ?? source.season_band ?? {}
  if (rawSeason && typeof rawSeason === 'object') {
    for (const [month, value] of Object.entries(rawSeason)) {
      const m = Number.parseInt(month, 10)
      if (m >= 1 && m <= 12 && typeof value === 'string' && value.trim()) {
        seasonBand[String(m)] = value.trim()
      }
    }
  }
  return {
    line: String(source.line ?? '').trim() || "Today's outfit: {outfit}",
    bands: bands.length ? bands : DEFAULT_BANDS.map(cloneBand),
    // Merge over the defaults so a card that only names a few months still has
    // a sensible band for the others.
    seasonBand: { ...DEFAULT_SEASON_BAND, ...seasonBand },
    rainWords: stringList(source.rainWords ?? source.rain_words).length
      ? stringList(source.rainWords ?? source.rain_words)
      : ['rain', 'drizzle', 'shower', 'thunder', '雨', '雪', 'snow', 'sleet'],
    snowWords: stringList(source.snowWords ?? source.snow_words).length
      ? stringList(source.snowWords ?? source.snow_words)
      : ['snow', 'sleet', 'blizzard', '雪'],
    umbrella: truncate(source.umbrella ?? '', 120) || 'She carries a black umbrella.',
  }
}

function cloneBand(band) {
  return {
    id: band.id,
    below: band.below,
    hint: band.hint,
    requireAny: [...band.requireAny],
    forbid: [...band.forbid],
    fallback: [...band.fallback],
  }
}

/**
 * Map a character `card.json` onto the plugin's partial config.
 *
 * Only `static`, `outfit` and `life` are read. Missing sections are ignored, so
 * a partial card degrades to the defaults instead of failing the plugin.
 *
 * @param {Record<string, any> | null | undefined} card
 */
export function cardToPartial(card) {
  if (!card || typeof card !== 'object') return {}
  const staticInfo = card.static && typeof card.static === 'object' ? card.static : {}
  const claiming = String(staticInfo.Claiming ?? '').trim()
  const name = claiming.split(/\s*[（(]/u)[0].trim()
  const clothing = staticInfo.Clothing && typeof staticInfo.Clothing === 'object' ? staticInfo.Clothing : {}
  const life = card.life && typeof card.life === 'object' ? card.life : {}
  return {
    persona: {
      name,
      gender: String(staticInfo.Gender ?? '').trim(),
      age: String(staticInfo.Age ?? '').trim(),
      residence: String(staticInfo.Residence ?? '').trim(),
      style: String(clothing.Style ?? '').trim(),
    },
    outfit: card.outfit && typeof card.outfit === 'object'
      ? {
          line: card.outfit.line,
          bands: card.outfit.bands,
          seasonBand: card.outfit.season_band,
          rainWords: card.outfit.rain_words,
          snowWords: card.outfit.snow_words,
          umbrella: card.outfit.umbrella,
        }
      : undefined,
    routine: Array.isArray(life.routine) ? stringList(life.routine) : undefined,
    habits: Array.isArray(life.habits) ? stringList(life.habits) : undefined,
  }
}

/**
 * Resolve the effective plugin config.
 *
 * @param {Record<string, any>} raw plugin config as supplied by the loader
 * @param {{ card?: Record<string, any> | null }} [sources]
 */
export function resolveConfig(raw = {}, sources = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const fromCard = cardToPartial(sources.card)
  const personaRaw = input.persona && typeof input.persona === 'object' ? input.persona : {}
  const cardPersona = fromCard.persona ?? {}
  const persona = {
    name: truncate(personaRaw.name ?? cardPersona.name ?? '', 40),
    gender: truncate(personaRaw.gender ?? cardPersona.gender ?? '', 40),
    age: truncate(personaRaw.age ?? cardPersona.age ?? '', 40),
    residence: truncate(personaRaw.residence ?? cardPersona.residence ?? '', 120),
    style: truncate(personaRaw.style ?? cardPersona.style ?? '', 400),
  }
  const outfitRaw = input.outfit && typeof input.outfit === 'object' ? input.outfit : {}
  const cardOutfit = fromCard.outfit ?? {}
  const mergedOutfit = {
    line: outfitRaw.line ?? cardOutfit.line,
    bands: Array.isArray(outfitRaw.bands) && outfitRaw.bands.length ? outfitRaw.bands : cardOutfit.bands,
    seasonBand: outfitRaw.seasonBand ?? cardOutfit.seasonBand,
    rainWords: outfitRaw.rainWords,
    snowWords: outfitRaw.snowWords,
    umbrella: outfitRaw.umbrella ?? cardOutfit.umbrella,
  }
  const outfit = normalizeOutfit(mergedOutfit)
  outfit.line = String(mergedOutfit.line ?? '').trim() || outfit.line
  const routine = stringList(
    Array.isArray(input.routine) && input.routine.length ? input.routine : fromCard.routine,
  )
  const habits = stringList(
    Array.isArray(input.habits) && input.habits.length ? input.habits : fromCard.habits,
  )
  const placeTypes = stringList(input.placeTypes).length
    ? stringList(input.placeTypes)
    : [...DEFAULT_PLACE_TYPES]
  const notesRaw = input.notes && typeof input.notes === 'object' ? input.notes : {}
  const notes = {
    daily: truncate(notesRaw.daily ?? DEFAULT_NOTES.daily, 500),
    weather: truncate(notesRaw.weather ?? DEFAULT_NOTES.weather, 500),
    plan: truncate(notesRaw.plan ?? DEFAULT_NOTES.plan, 500),
    outfit: truncate(notesRaw.outfit ?? DEFAULT_NOTES.outfit, 500),
  }
  return {
    enabled: input.enabled !== false,
    dataDir: String(input.dataDir ?? '').trim(),
    applyToSubagents: input.applyToSubagents === true,
    cardFile: String(input.cardFile ?? '').trim(),
    sceneCity: truncate(input.sceneCity ?? '', 40),
    weatherCity: truncate(input.weatherCity ?? '北京', 40),
    placeTypes,
    persona,
    outfit,
    routine,
    habits,
    notes,
    generation: {
      provider: truncate(input.provider ?? '', 80),
      model: truncate(input.model ?? '', 80),
      maxTokens: clampInt(input.maxTokens, 200, 4000, 900),
      temperature: clampNumber(input.temperature, 0, 2, 0.95),
      timeoutMs: clampInt(input.timeoutMs, 5_000, 180_000, 60_000),
      retryMinutes: clampInt(input.retryMinutes, 1, 240, 15),
    },
    minSceneChars: clampInt(input.minSceneChars, 1, 1000, 20),
    maxSceneChars: clampInt(input.maxSceneChars, 20, 2000, 220),
    recentDays: clampInt(input.recentDays, 1, 60, 10),
    injectDaily: input.injectDaily !== false,
    injectWeather: input.injectWeather !== false,
    injectPlan: input.injectPlan !== false,
    injectOutfit: input.injectOutfit !== false,
  }
}

function clampInt(value, lo, hi, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function clampNumber(value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}
