import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_BANDS, DEFAULT_SEASON_BAND } from '../lib/config.js'
import {
  fetchWeather,
  formatWeather,
  isWet,
  outfitOk,
  pickBand,
  pickOutfit,
  weatherZh,
} from '../lib/weather.js'

const outfit = {
  bands: DEFAULT_BANDS,
  seasonBand: DEFAULT_SEASON_BAND,
  rainWords: ['rain', '雨'],
  snowWords: ['snow', '雪'],
  umbrella: 'She carries a black umbrella.',
}

test('weatherZh translates known descriptions and passes unknown ones through', () => {
  assert.equal(weatherZh('Smoky haze'), '烟霾')
  assert.equal(weatherZh('LIGHT RAIN'), '小雨')
  assert.equal(weatherZh('Volcanic ash'), 'Volcanic ash')
  assert.equal(weatherZh(''), '')
})

test('formatWeather keeps only temperature and condition', () => {
  assert.equal(formatWeather({ tempC: 12, desc: '小雨', humidity: '80', wind: '12' }), '气温 12°C、小雨')
  assert.equal(formatWeather({ tempC: -3, desc: '' }), '气温 -3°C')
  assert.equal(formatWeather({ tempC: null, desc: '雾' }), '天气：雾')
  assert.equal(formatWeather(null), '')
})

test('pickBand chooses by felt temperature, then by month', () => {
  assert.equal(pickBand({ tempC: 30, feelsC: 2 }, outfit).id, 'cold')
  assert.equal(pickBand({ tempC: 18, feelsC: 18 }, outfit).id, 'mild')
  assert.equal(pickBand({ tempC: 36, feelsC: 36 }, outfit).id, 'hot')
  // No weather: July is hot, January is cold.
  assert.equal(pickBand(null, outfit, new Date(2026, 6, 1)).id, 'hot')
  assert.equal(pickBand(null, outfit, new Date(2026, 0, 1)).id, 'cold')
})

test('outfitOk rejects CJK, wrong length, forbidden and missing required words', () => {
  const cold = DEFAULT_BANDS[0]
  assert.equal(outfitOk('A warm wool coat over a black dress, tights and boots.', cold), true)
  assert.equal(outfitOk('一件黑色连衣裙配长靴和红色发带。', cold), false)
  assert.equal(outfitOk('coat', cold), false)
  assert.equal(outfitOk('A sleeveless dress with sandals and bare legs today.', cold), false)
  assert.equal(outfitOk('A light blouse, a skirt, tights and loafers, nothing warm at all.', cold), false)
})

test('pickOutfit keeps a valid candidate and rotates a band preset otherwise', () => {
  const day = new Date(2026, 10, 10)
  const valid = 'A long black wool coat over a knit dress, thermal tights and ankle boots.'
  assert.equal(pickOutfit(valid, { tempC: 2, desc: '晴' }, outfit, day), valid)
  const fallback = pickOutfit('一件裙子', { tempC: 2, desc: '晴' }, outfit, day)
  assert.ok(DEFAULT_BANDS[0].fallback.includes(fallback), fallback)
  // The same day always picks the same preset (deterministic rotation).
  assert.equal(fallback, pickOutfit('一件裙子', { tempC: 2, desc: '晴' }, outfit, day))
})

test('pickOutfit adds the umbrella on wet days only', () => {
  const day = new Date(2026, 10, 10)
  const candidate = 'A long black wool coat over a knit dress, thermal tights and ankle boots.'
  const wet = pickOutfit(candidate, { tempC: 2, desc: '小雨' }, outfit, day)
  assert.ok(wet.endsWith('She carries a black umbrella.'))
  const dry = pickOutfit(candidate, { tempC: 2, desc: '晴' }, outfit, day)
  assert.equal(dry, candidate)
  assert.equal(isWet({ desc: '雨夹雪' }, outfit), true)
  assert.equal(isWet({ desc: '晴' }, outfit), false)
})

test('fetchWeather parses wttr.in j1 and degrades to null on failure', async () => {
  const ok = async () => ({
    ok: true,
    json: async () => ({
      current_condition: [
        { temp_C: '9', FeelsLikeC: '7', weatherDesc: [{ value: 'Light rain' }], humidity: '80', windspeedKmph: '11' },
      ],
    }),
  })
  const info = await fetchWeather('北京', { fetchImpl: ok })
  assert.deepEqual(info, { city: '北京', tempC: 9, feelsC: 7, desc: '小雨', humidity: '80', wind: '11' })

  const bad = async () => ({ ok: false, json: async () => ({}) })
  assert.equal(await fetchWeather('北京', { fetchImpl: bad }), null)
  const throws = async () => {
    throw new Error('offline')
  }
  assert.equal(await fetchWeather('北京', { fetchImpl: throws }), null)
  assert.equal(await fetchWeather('', { fetchImpl: ok }), null)
})
