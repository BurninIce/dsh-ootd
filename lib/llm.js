/**
 * DSH model-call adapter for dsh-ootd.
 *
 * The plugin makes one auxiliary call per day, outside any conversation turn.
 * It resolves the route from configuration first, then from the live session's
 * last logged request header — so an unconfigured plugin still uses whichever
 * model the session already runs on.
 *
 * Only the public `ctx.llm` surface is used; stream chunks are assembled here to
 * keep the plugin free of a runtime dependency on dsh-llm.
 */

/**
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {{ snapshotEvents?: () => readonly any[] } | null | undefined} session
 * @returns {{ provider: string, model: string } | null}
 */
export function routeFor(config, session) {
  if (config.generation.provider && config.generation.model) {
    return { provider: config.generation.provider, model: config.generation.model }
  }
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'request/context') {
      const { provider, model } = event.data ?? {}
      if (provider && model) return { provider, model }
    }
    if (event?.type === 'request/header') {
      const callConfig = event.data?.header?.config
      if (callConfig?.provider && callConfig?.model) {
        return { provider: callConfig.provider, model: callConfig.model }
      }
    }
  }
  return null
}

/**
 * Build the `complete` function consumed by {@link OotdEngine}.
 *
 * @param {{ llm: any }} ctx
 * @returns {(input: { route: { provider: string, model: string }, system: string,
 *   user: string, maxTokens: number, temperature: number, timeoutMs: number }) => Promise<string>}
 */
export function makeCompleter(ctx) {
  return async function complete(input) {
    const signal = AbortSignal.timeout(input.timeoutMs)
    const call = await ctx.llm.prepareCall(
      {
        provider: input.route.provider,
        model: input.route.model,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
      },
      signal,
    )
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: input.user }],
        source: { kind: 'dsh-ootd' },
      },
    ]
    const options = { ...call.config, messages, system: input.system, signal }
    let deltaText = ''
    let blockText = ''
    let finish
    for await (const chunk of call.stream(options)) {
      if (chunk.type === 'text-delta') deltaText += chunk.text
      else if (chunk.type === 'block-end' && chunk.block?.type === 'text') blockText += chunk.block.text
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      throw new Error(finish.failure?.message ?? `模型调用中止（${finish.kind}）`)
    }
    const text = (deltaText || blockText).trim()
    if (!text) throw new Error('模型没有返回文本')
    return text
  }
}

/**
 * Resolve the route from a live DSH agent, if the plugin is processing a turn.
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} config
 * @param {{ session?: any } | null | undefined} agent
 */
export function routeFromAgent(config, agent) {
  return routeFor(config, agent?.session ?? null)
}
