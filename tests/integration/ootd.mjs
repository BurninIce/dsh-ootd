/**
 * Integration harness for dsh-ootd.
 *
 * Mounts the real plugin on a real Cordis context with fake DSH services, then
 * drives the lifecycle DSH would: agent/created → scoped section → tool call →
 * model stream → cached daily document → rendered injection.
 *
 * Run from the repository root (see tests/integration/README.md):
 *
 *   node --import ./tests/integration/register-dsh-packages.mjs ./tests/integration/ootd.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ootd-home-'))
process.env.DSH_HOME = home

const { Context } = await import('@deepseek-ai/cordis')
const TimerService = (await import('@deepseek-ai/cordis-plugin-timer')).default
const ootd = await import('../../lib/index.js')

const ctx = new Context()
ctx.plugin(TimerService)
const sections = []
const tools = new Map()
const commands = new Map()
let modelCalls = 0

ctx.provide('systemPrompt', {
  section(options) {
    sections.push(options)
    return () => {}
  },
})
ctx.provide('tools', {
  register(tool) {
    tools.set(tool.name, tool)
    return () => {}
  },
})
ctx.provide('commands', {
  register(command) {
    commands.set(command.name, command)
    return () => {}
  },
})
ctx.provide('llm', {
  async prepareCall(config) {
    return {
      config,
      async *stream(options) {
        modelCalls += 1
        const prompt = options.messages[0].content[0].text
        assert.match(prompt, /"scene"/)
        yield {
          type: 'text-delta',
          index: 0,
          text: JSON.stringify({
            scene: '临川市旧书店的午后，光从高窗落在旧书脊上。店主把新收的旧书摊开，纸页带着凉意。',
            outfit: 'A black trench coat over a white blouse, a black pleated skirt, black tights and loafers.',
            plan: [
              { time: '07:30', text: '起床，泡一壶红茶', key: false },
              { time: '15:00', text: '和牙医约好', key: true },
            ],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
})

ctx.plugin(
  { name: ootd.name, inject: ootd.inject, apply: ootd.apply },
  {
    dataDir: path.join(home, 'data'),
    sceneCity: '临川市',
    weatherCity: '',
    provider: 'mock',
    model: 'mock-1',
    routine: ['07:30-08:30 起床，泡一壶红茶'],
  },
)

for (let i = 0; i < 100 && tools.size === 0; i += 1) await new Promise((r) => setTimeout(r, 20))
assert.equal(tools.size, 3, 'three ootd tools registered')
assert.ok(commands.has('ootd'), 'ootd command registered')
assert.equal(sections.length, 0, 'no section before an agent exists')

const agentCtx = ctx.extend()
const session = {
  id: 'session-1',
  header: { version: 4, id: 'session-1', createdAt: Date.now(), isSeeded: false },
  snapshotEvents: () => [
    { type: 'request/context', seq: 1, time: Date.now(), data: { provider: 'mock', model: 'mock-1' } },
  ],
}
const agent = { session, ctx: agentCtx, status: 'idle' }
ctx.emit('agent/created', { agent, source: 'fresh' })

for (let i = 0; i < 150 && sections.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20))
assert.equal(sections.length, 1, 'scoped section registered on agent/created')
assert.equal(sections[0].name, 'ootd:today')
assert.equal(sections[0].interpolate, false)

// Wait for the background generation kicked off by agent/created.
const cacheFile = path.join(home, 'data', 'today.json')
for (let i = 0; i < 200 && !fs.existsSync(cacheFile); i += 1) await new Promise((r) => setTimeout(r, 20))
assert.ok(fs.existsSync(cacheFile), 'today.json written')
assert.ok(modelCalls >= 1, 'generation used the model stream')

const blocks = sections[0].text()
assert.match(blocks, /【今日日常】/)
assert.match(blocks, /旧书店/)
assert.match(blocks, /【今天的安排】/)
assert.match(blocks, /15:00 和牙医约好（有约）/)
assert.match(blocks, /【今日着装】/)

const updated = await tools.get('ootd_plan_update').execute(
  { ops: [{ op: 'add', time: '20:00', text: '给小林回电话', key: true }] },
  { agent },
)
assert.equal(updated.ok, true)
assert.equal(updated.count, 3)
assert.match(sections[0].text(), /20:00 给小林回电话/)

const command = await commands.get('ootd').handler({
  agent,
  rawInput: '',
  attachments: [],
  signal: new AbortController().signal,
})
assert.equal(command.kind, 'success')
assert.match(command.text, /今日日常/)

const refreshed = await tools.get('ootd_refresh').execute({}, { agent })
assert.equal(refreshed.ok, true)
assert.ok(modelCalls >= 2, 'refresh generates again')

fs.rmSync(home, { recursive: true, force: true })
console.log(`ootd integration OK: tools=3 command=1 modelCalls=${modelCalls}`)
process.exit(0)
