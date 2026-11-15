import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { AUTO_TARGETS, NoProviderError, ProviderError, appendOnlyText, id, parseTarget, type Core, type ToolCall } from '@freeagent/core'
import { estimateTokens, fromAnthropic, messageResponse, targetForModel, type AnthropicRequest } from './anthropic'
import { chunk, completionResponse, fromOpenAI, type OpenAIRequest } from './openai'

function errorStatus(err: unknown): number {
  if (err instanceof NoProviderError) return 503
  if (err instanceof ProviderError) return err.kind === 'rate_limit' ? 429 : err.kind === 'bad_request' ? 400 : 502
  return 500
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** OpenAI- and Anthropic-compatible endpoints backed by the provider router. */
export function gatewayRoutes(core: Core): Hono {
  const app = new Hono()
  const known = (t: string): boolean => AUTO_TARGETS.includes(t) || !!core.registry.get(parseTarget(t).providerId ?? '')

  app.get('/models', async (c) => {
    const data: { id: string; object: string; owned_by: string; created: number }[] = AUTO_TARGETS.map((t) => ({ id: t, object: 'model', owned_by: 'freeagent', created: 0 }))
    for (const p of core.registry.list()) {
      if (!core.registry.enabled(p.id) || p.id === 'mock') continue
      const st = await p.status().catch(() => ({ state: 'error' }))
      if (st.state !== 'ready') continue
      for (const m of await p.models().catch(() => [])) data.push({ id: `${p.id}::${m.id}`, object: 'model', owned_by: p.id, created: 0 })
    }
    return c.json({ object: 'list', data })
  })

  app.post('/chat/completions', async (c) => {
    const body = (await c.req.json()) as OpenAIRequest
    if (!Array.isArray(body.messages)) return c.json({ error: { message: 'messages is required', type: 'invalid_request_error' } }, 400)
    const { messages, tools } = fromOpenAI(body)
    const target = known(body.model ?? '') ? body.model! : 'auto'
    const req = { target, tools, temperature: body.temperature, maxTokens: body.max_completion_tokens ?? body.max_tokens, signal: c.req.raw.signal }
    const reqId = id('chatcmpl-')

    if (!body.stream) {
      try {
        const r = await core.router.complete(messages, req)
        return c.json(completionResponse({ id: reqId, model: `${r.providerId}::${r.model ?? 'default'}`, text: r.text, toolCalls: r.toolCalls }))
      } catch (err) {
        return c.json({ error: { message: errMsg(err), type: 'provider_error' } }, errorStatus(err) as 500)
      }
    }

    return streamSSE(c, async (stream) => {
      let model = target
      const calls: ToolCall[] = []
      let started = false
      const out = appendOnlyText()
      const writeText = async (text: string): Promise<void> => {
        if (text) await stream.writeSSE({ data: chunk(reqId, model, { content: text }) })
      }
      try {
        for await (const ev of core.router.chat(messages, req)) {
          if (ev.type === 'route') {
            model = `${ev.providerId}::${ev.model ?? 'default'}`
            if (!started) await stream.writeSSE({ data: chunk(reqId, model, { role: 'assistant', content: '' }) })
            started = true
          } else if (ev.type === 'text') await writeText(out.next(ev))
          else if (ev.type === 'tool_call') calls.push(ev.call)
        }
        await writeText(out.end())
        if (calls.length) {
          await stream.writeSSE({
            data: chunk(reqId, model, {
              tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }))
            })
          })
        }
        await stream.writeSSE({ data: chunk(reqId, model, {}, calls.length ? 'tool_calls' : 'stop') })
      } catch (err) {
        await stream.writeSSE({ data: JSON.stringify({ error: { message: errMsg(err), type: 'provider_error' } }) })
      }
      await stream.writeSSE({ data: '[DONE]' })
    })
  })

  app.post('/messages/count_tokens', async (c) => {
    const body = (await c.req.json()) as AnthropicRequest
    return c.json({ input_tokens: estimateTokens(body) })
  })

  app.post('/messages', async (c) => {
    const body = (await c.req.json()) as AnthropicRequest
    if (!Array.isArray(body.messages)) return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages is required' } }, 400)
    const { messages, tools } = fromAnthropic(body)
    const target = targetForModel(body.model, known)
    const req = { target, tools, temperature: body.temperature, maxTokens: body.max_tokens, signal: c.req.raw.signal }
    const msgId = id('msg_')
    const inputTokens = estimateTokens(body)
    const modelName = body.model ?? target

    if (!body.stream) {
      try {
        const r = await core.router.complete(messages, req)
        return c.json(messageResponse({ id: msgId, model: modelName, text: r.text, toolCalls: r.toolCalls, inputTokens, outputTokens: Math.ceil(r.text.length / 4) }))
      } catch (err) {
        return c.json({ type: 'error', error: { type: 'api_error', message: errMsg(err) } }, errorStatus(err) as 500)
      }
    }

    return streamSSE(c, async (stream) => {
      const send = (event: string, data: Record<string, unknown>): Promise<void> => stream.writeSSE({ event, data: JSON.stringify({ type: event, ...data }) })
      await send('message_start', {
        message: { id: msgId, type: 'message', role: 'assistant', model: modelName, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } }
      })
      let index = 0
      let textOpen = false
      let outChars = 0
      const calls: ToolCall[] = []
      const out = appendOnlyText()
      const writeText = async (text: string): Promise<void> => {
        if (!text) return
        if (!textOpen) {
          await send('content_block_start', { index, content_block: { type: 'text', text: '' } })
          textOpen = true
        }
        outChars += text.length
        await send('content_block_delta', { index, delta: { type: 'text_delta', text } })
      }
      try {
        for await (const ev of core.router.chat(messages, req)) {
          if (ev.type === 'text') await writeText(out.next(ev))
          else if (ev.type === 'tool_call') calls.push(ev.call)
        }
        await writeText(out.end())
        if (textOpen) {
          await send('content_block_stop', { index })
          index++
        }
        for (const call of calls) {
          await send('content_block_start', { index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
          await send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: call.arguments || '{}' } })
          await send('content_block_stop', { index })
          index++
        }
        await send('message_delta', { delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil(outChars / 4) } })
        await send('message_stop', {})
      } catch (err) {
        await send('error', { error: { type: err instanceof ProviderError && err.kind === 'rate_limit' ? 'rate_limit_error' : 'api_error', message: errMsg(err) } })
      }
    })
  })

  return app
}
