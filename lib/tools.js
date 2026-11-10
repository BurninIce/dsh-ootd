/**
 * Model-facing tools for dsh-ootd.
 *
 * Tool descriptions are written for a role-play agent in Chinese: they state
 * exactly what the tool returns and, for the plan editor, the two-edit bound and
 * the meaning of `key` so the agent does not turn a chat into a scheduler.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderPlan } from './plan.js'

/**
 * @param {{ engine: import('./engine.js').OotdEngine,
 *   config: ReturnType<import('./config.js').resolveConfig>,
 *   routeForAgent: (agent: any) => { provider: string, model: string } | null }} deps
 */
export function buildTools({ engine, config, routeForAgent }) {
  const today = defineTool({
    name: 'ootd_today',
    description:
      '读取「今天」的日常锚点：今日日常场景、实况天气、今天的安排、今日着装。' +
      '想确认今天是什么天气、自己今天有什么安排、或现在穿着什么时用它；不要凭空编造天气与日程。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          hasToday: { type: 'boolean', required: true },
          scene: { type: 'string', required: true },
          weather: { type: 'string', required: true },
          outfit: { type: 'string', required: true },
          plan: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time: { type: 'string', required: true },
                text: { type: 'string', required: true },
                key: { type: 'boolean', required: true },
              },
            },
          },
          planText: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.hasToday
            ? [
                `日期：${value.date}`,
                `今日日常：${value.scene}`,
                value.weather ? `今日天气：${value.weather}` : '',
                value.outfit ? `今日着装：${value.outfit}` : '',
                value.planText ? `今天的安排：\n${value.planText}` : '',
              ]
                .filter(Boolean)
                .join('\n')
            : `日期：${value.date}；今天还没有生成日常场景。`,
        },
      ],
    },
    async execute() {
      return engine.status()
    },
  })

  const refresh = defineTool({
    name: 'ootd_refresh',
    description:
      '重新生成今天的日常场景、天气、着装与日程。仅在用户明确要求换一个今天的场景/日程，' +
      '或当前确实没有今日日常时调用；一次对话里不要反复调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          scene: { type: 'string' },
          weather: { type: 'string' },
          outfit: { type: 'string' },
          planText: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? [
                '今日日常已重新生成：',
                `场景：${value.scene ?? ''}`,
                value.weather ? `天气：${value.weather}` : '',
                value.outfit ? `着装：${value.outfit}` : '',
                value.planText ? `安排：\n${value.planText}` : '',
              ]
                .filter(Boolean)
                .join('\n')
            : `重新生成失败：${value.reason ?? '未知原因'}`,
        },
      ],
    },
    timeoutMs: Math.max(30_000, config.generation.timeoutMs + 5_000),
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const route = routeForAgent(exec.agent)
      const result = await engine.ensure({ route, force: true })
      if (!result.ok) return { ok: false, reason: result.reason ?? '生成失败' }
      const status = engine.status()
      return {
        ok: true,
        scene: status.scene,
        weather: status.weather,
        outfit: status.outfit,
        planText: status.planText,
      }
    },
  })

  const planUpdate = defineTool({
    name: 'ootd_plan_update',
    description:
      '修改今天的日程，最多 2 处。只有用户明确给出具体时间/地点/约定（例如「下午三点约了牙医」「晚上七点和小林吃饭」）时使用；' +
      '寒暄、猜测、或用户只是说说而已都不要改。op=add/update/remove；index 是当前日程从 1 开始的序号；' +
      'key 只标真正与人有约、有具体时间的事项。改完不要逐条念给用户听。',
    parameters: {
      ops: {
        type: 'array',
        required: true,
        description: '要执行的操作，最多 2 条。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: {
              type: 'string',
              required: true,
              enum: ['add', 'update', 'remove'],
              description: 'add 新增，update 修改，remove 删除。',
            },
            index: {
              type: 'integer',
              description: 'update/remove 的目标序号（从 1 开始，对应当前日程的顺序）。',
            },
            time: { type: 'string', description: '24 小时制 HH:MM。' },
            text: { type: 'string', description: '一句话日程内容。' },
            key: { type: 'boolean', description: '是否是与人约好的固定安排。' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          applied: { type: 'integer', required: true },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          planText: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `日程已更新（${value.applied} 处，共 ${value.count} 条）${value.errors.length ? `；未生效：${value.errors.join('；')}` : ''}`
            : `日程未修改：${value.errors.join('；') || '没有可应用的改动'}`,
        },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const result = engine.editPlan(args.ops)
      return {
        ok: result.ok,
        applied: result.applied,
        errors: result.errors,
        planText: renderPlan(result.plan),
        count: result.plan.length,
      }
    },
  })

  return [today, refresh, planUpdate]
}
