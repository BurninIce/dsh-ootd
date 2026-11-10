import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CardLoader } from '../lib/card.js'
import { OotdStore } from '../lib/store.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ootd-store-'))
}

function card(claiming) {
  return JSON.stringify({
    static: { Claiming: claiming, Gender: 'female', Clothing: { Style: 'plain' } },
    life: { routine: ['07:30-08:30 起床'] },
  })
}

test('card loader reads, caches by mtime+size, and picks up edits', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'card.json')
    fs.writeFileSync(file, card('First (One)'), 'utf8')
    const loader = new CardLoader()
    assert.equal(loader.load(file).static.Claiming, 'First (One)')

    fs.writeFileSync(file, card('Second (Two)'), 'utf8')
    assert.equal(loader.load(file).static.Claiming, 'Second (Two)')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing card is absent and warned once', () => {
  const dir = tempDir()
  try {
    const warnings = []
    const loader = new CardLoader({ warn: (message) => warnings.push(message) })
    const file = path.join(dir, 'nope.json')
    assert.equal(loader.load(file), null)
    assert.equal(loader.load(file), null)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /不存在/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt card is absent and does not throw', () => {
  const dir = tempDir()
  try {
    const warnings = []
    const file = path.join(dir, 'card.json')
    fs.writeFileSync(file, '{ broken', 'utf8')
    const loader = new CardLoader({ warn: (message) => warnings.push(message) })
    assert.equal(loader.load(file), null)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /读取失败/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('daily cache round-trips and normalizes unknown fields', () => {
  const dir = tempDir()
  try {
    const store = new OotdStore(dir)
    store.write({
      date: '2026-11-10',
      scene: '一段场景',
      outfit: 'A coat.',
      weather: { tempC: 9, desc: '小雨' },
      plan: [{ time: '07:30', text: '起床', key: false }],
      placeType: '饮食场所',
      createdAt: 1,
      source: 'generated',
      recent: [{ date: '2026-11-09', scene: '旧场景', placeType: '居住与邻里' }],
      extra: 'ignored',
    })
    const reloaded = new OotdStore(dir).read()
    assert.equal(reloaded.date, '2026-11-10')
    assert.equal(reloaded.plan.length, 1)
    assert.equal('extra' in reloaded, false)
    assert.equal(reloaded.recent.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt daily cache is copied aside and reported once', () => {
  const dir = tempDir()
  try {
    const warnings = []
    const store = new OotdStore(dir, { warn: (message) => warnings.push(message) })
    fs.writeFileSync(store.file, '{ nope', 'utf8')
    assert.equal(store.read(1), null)
    assert.equal(store.read(10_000), null)
    const copies = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))
    assert.equal(copies.length, 1)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /损坏/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
