/**
 * Weather lookup, temperature bands, and outfit validation.
 *
 * The weather source is wttr.in's key-less `format=j1` JSON. Its `weatherDesc`
 * is English even with `lang=zh`, and a model handed "Smoky haze" tends to
 * ignore it and invent "afternoon sun"; the description is therefore translated
 * here and the model only receives a short Chinese phrase.
 *
 * Everything in this module is pure except `fetchWeather`, whose `fetchImpl` is
 * injectable so tests never touch the network.
 */

import { clamp, hasCjk } from './util.js'

/** wttr.in weather description (English) → Chinese. Unlisted values pass through. */
export const WEATHER_DESC_ZH = {
  sunny: '晴',
  clear: '晴',
  'partly cloudy': '多云',
  cloudy: '阴',
  overcast: '阴天',
  mist: '薄雾',
  fog: '雾',
  'freezing fog': '冻雾',
  haze: '霾',
  'smoky haze': '烟霾',
  smoke: '烟霾',
  'light drizzle': '毛毛雨',
  'patchy light drizzle': '零星毛毛雨',
  'light rain': '小雨',
  'patchy light rain': '零星小雨',
  'moderate rain': '中雨',
  'heavy rain': '大雨',
  'light rain shower': '阵雨',
  'moderate or heavy rain shower': '强阵雨',
  'torrential rain shower': '暴雨',
  'patchy rain nearby': '局部有雨',
  'patchy rain possible': '可能有雨',
  'thundery outbreaks possible': '可能有雷阵雨',
  'light snow': '小雪',
  'moderate snow': '中雪',
  'heavy snow': '大雪',
  blizzard: '暴雪',
  'blowing snow': '风雪',
  sleet: '雨夹雪',
  'light sleet': '小雨夹雪',
  'wintry mix': '雨雪混合',
}

/** @param {string} desc */
export function weatherZh(desc) {
  const value = String(desc ?? '').trim()
  return WEATHER_DESC_ZH[value.toLowerCase()] ?? value
}

function asInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Fetch current conditions from wttr.in.
 *
 * The browser User-Agent is not cosmetic: an empty or `curl/*` UA reproducibly
 * fails the TLS read with `UNEXPECTED_EOF_WHILE_READING`, while the browser
 * string returns the full JSON.
 *
 * @param {string} city
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<null | { city: string, tempC: number|null, feelsC: number|null,
 *   desc: string, humidity: string, wind: string }>}
 */
export async function fetchWeather(city, options = {}) {
  const name = String(city ?? '').trim()
  if (!name) return null
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return null
  const timeoutMs = options.timeoutMs ?? 15_000
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
    const url = `https://wttr.in/${encodeURIComponent(name)}?format=j1`
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal,
    })
    if (!response.ok) return null
    const body = await response.json()
    const current = body?.current_condition?.[0]
    if (!current) return null
    const rawDesc =
      current.lang_zh?.[0]?.value ?? current.weatherDesc?.[0]?.value ?? ''
    return {
      city: name,
      tempC: asInt(current.temp_C),
      feelsC: asInt(current.FeelsLikeC),
      desc: weatherZh(rawDesc),
      humidity: String(current.humidity ?? '?'),
      wind: String(current.windspeedKmph ?? '?'),
    }
  } catch {
    return null
  }
}

/**
 * One compact Chinese phrase for prompts. Humidity/wind are deliberately not
 * included: models copy raw numbers into the scene, which reads like a report.
 *
 * @param {{ tempC?: number|null, desc?: string } | null | undefined} info
 * @returns {string} e.g. `气温 12°C、小雨`; '' when no weather is available.
 */
export function formatWeather(info) {
  if (!info) return ''
  const temp = info.tempC
  const desc = String(info.desc ?? '').trim()
  if (temp === null || temp === undefined) return desc ? `天气：${desc}` : ''
  return desc ? `气温 ${temp}°C、${desc}` : `气温 ${temp}°C`
}

/** @param {number} month 1-12 */
export function seasonBandId(month, seasonBand) {
  const id = seasonBand?.[String(month)]
  return typeof id === 'string' && id ? id : ''
}

/**
 * Pick the outfit band for the felt temperature.
 *
 * `bands` must be sorted ascending by `below`; the last entry is the open-ended
 * band and may omit `below`. Without weather the month's seasonal band is used.
 *
 * @param {{ feelsC?: number|null, tempC?: number|null } | null} info
 * @param {{ bands: Array<Record<string, any>>, seasonBand: Record<string, string> }} outfit
 * @param {Date} date
 * @returns {Record<string, any> | null}
 */
export function pickBand(info, outfit, date = new Date()) {
  const bands = Array.isArray(outfit?.bands) ? outfit.bands : []
  if (!bands.length) return null
  let felt = info?.feelsC ?? info?.tempC ?? null
  if (felt === null || felt === undefined) {
    const wanted = seasonBandId(date.getMonth() + 1, outfit?.seasonBand)
    const seasonal = bands.find((band) => band.id === wanted)
    if (seasonal) return seasonal
    return bands[bands.length - 1]
  }
  for (const band of bands) {
    if (band.below === undefined || band.below === null) return band
    if (felt < band.below) return band
  }
  return bands[bands.length - 1]
}

/** Rain or snow in the current description → carry an umbrella. */
export function isWet(info, outfit) {
  const desc = String(info?.desc ?? '').toLowerCase()
  if (!desc) return false
  const words = [
    ...(Array.isArray(outfit?.rainWords) ? outfit.rainWords : []),
    ...(Array.isArray(outfit?.snowWords) ? outfit.snowWords : []),
  ]
  return words.some((word) => {
    const token = String(word ?? '').trim().toLowerCase()
    return token && desc.includes(token)
  })
}

/**
 * Validate a model-authored outfit against its band.
 *
 * The outfit is an English phrase consumed by image-generation prompts; Chinese
 * text means the model ignored the format and must not be cached.
 *
 * @param {string} outfit
 * @param {Record<string, any> | null} band
 * @param {{ minWords?: number, maxWords?: number }} [limits]
 */
export function outfitOk(outfit, band, limits = {}) {
  const text = String(outfit ?? '').trim()
  if (!text || hasCjk(text)) return false
  const minWords = limits.minWords ?? 8
  const maxWords = limits.maxWords ?? 60
  const words = text.split(/\s+/u).filter(Boolean)
  if (words.length < minWords || words.length > maxWords) return false
  const lower = text.toLowerCase()
  const forbidden = Array.isArray(band?.forbid) ? band.forbid : []
  if (forbidden.some((word) => lower.includes(String(word).toLowerCase()))) return false
  const required = Array.isArray(band?.requireAny) ? band.requireAny : []
  return required.length === 0 || required.some((word) => lower.includes(String(word).toLowerCase()))
}

/**
 * Choose today's outfit: the model's candidate when valid, otherwise a preset
 * from the band rotating by day, plus an umbrella on wet days.
 *
 * @param {string} candidate
 * @param {{ tempC?: number|null, feelsC?: number|null, desc?: string } | null} info
 * @param {{ bands: Array<Record<string, any>>, seasonBand: Record<string, string>, umbrella?: string }} outfit
 * @param {Date} date
 */
export function pickOutfit(candidate, info, outfit, date = new Date()) {
  const band = pickBand(info, outfit, date)
  if (!band) return String(candidate ?? '').trim()
  let chosen = String(candidate ?? '').trim()
  if (!outfitOk(chosen, band)) {
    const presets = Array.isArray(band.fallback) ? band.fallback.filter(Boolean) : []
    const ordinal = Math.floor(date.getTime() / 86_400_000)
    chosen = presets.length ? String(presets[ordinal % presets.length]) : ''
  }
  const umbrella = String(outfit?.umbrella ?? '').trim()
  if (umbrella && isWet(info, outfit) && !chosen.toLowerCase().includes('umbrella')) {
    chosen = `${chosen} ${umbrella}`.trim()
  }
  return chosen
}

/** Clamp a raw temperature for display (guards NaN from a partial provider). */
export function safeTemp(value) {
  return value === null || value === undefined ? null : clamp(Number(value), -60, 60)
}
