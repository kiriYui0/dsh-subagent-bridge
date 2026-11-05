import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compactUnderRule,
  composeInstruction,
  explicitRange,
  frameSummary,
  installSummarizerHook,
  rulesOf,
} from '../src/compaction.js'
import { contextReport, pairingBalance, resolveBudgets, resolvePolicy, selectRange, serviceDiagnosis } from '../src/context.js'

/**
 * Build a session whose surface pairs tool calls with results, so cut-point
 * assertions exercise the real balancing rule.
 * @param sizes - tokens per surface node, in model-visible order.
 * @param options - whether node 0 is a system message, and which nodes are tool calls.
 * @returns a fake session plus its event list.
 */
function fakeSession(sizes, options = {}) {
  const events = []
  const surface = []
  let seq = 0
  const push = (type, data, message) => {
    const event = { type, seq, time: seq, data }
    events.push(event)
    surface.push(seq)
    seq += 1
    return event
  }
  sizes.forEach((tokens, index) => {
    const kind = options.kinds?.[index] ?? 'user'
    if (kind === 'system') {
      push('system/message', { message: { role: 'system', content: [{ type: 'text', text: 's' }] } })
    } else if (kind === 'assistant') {
      push('assistant/message', {
        message: { role: 'assistant', content: [{ type: 'tool-call', id: `c${index}`, name: 'read', arguments: '{}' }] },
      })
    } else if (kind === 'tool-result') {
      push('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: 'r' }] } })
    } else {
      push('user/message', { role: 'user', content: [{ type: 'text', text: 'u' }] })
    }
  })
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    session: {
      id: 'session-1',
      seq,
      surface: { nodes: surface, replaceGeneration: 0 },
      snapshotEvents: () => events,
      eventAt: (target) => bySeq.get(Number(target)),
      deriveEventMessage: (event) => (event === undefined ? null : event.data.message ?? event.data),
      requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 1000 }, tools: [] }),
      append: (type, data, opts) => {
        const event = { type, seq, time: seq, data, ...(opts ?? {}) }
        events.push(event)
        seq += 1
        return event
      },
      toolHistory: () => [],
    },
    events,
  }
}

/** Build a meter that prices the nodes given to it. */
function fakeMeter(nodes) {
  const total = nodes.reduce((sum, node) => sum + node.tokens, 0)
  return {
    measure: () => ({ totalTokens: total, surfaceTokens: total, surfaceDeltaTokens: 0, baseline: { kind: 'estimated', tokens: total }, nodes }),
    estimateMessage: (message) => {
      const text = (message.content ?? []).map((block) => block.text ?? '').join('')
      return Math.floor(text.length / 4)
    },
  }
}

/** Build a context whose services are the fakes above. */
function fakeCtx({ session, meter, compaction, llm, agent }) {
  const services = new Map([
    ['sessions', { get: (id) => (id === session.id ? session : undefined), flush: async () => {} }],
    ['agents', { get: (id) => (id === session.id ? agent : undefined) }],
    ['tokenMeter', meter],
    ['compaction', compaction],
    ['llm', llm],
  ])
  return { get: (name) => services.get(name) }
}

test('pairingBalance marks cuts that split a tool pair', () => {
  const { session } = fakeSession([10, 20, 30, 40], { kinds: ['system', 'assistant', 'tool-result', 'user'] })
  const { before, after } = pairingBalance(session)
  assert.deepEqual(before, [true, true, false, true])
  assert.deepEqual(after, [true, false, true, true])
})

test('selectRange keeps the priced tail and never splits a tool pair', () => {
  const { session } = fakeSession([10, 20, 30, 40], { kinds: ['system', 'assistant', 'tool-result', 'user'] })
  const nodes = [
    { seq: 0, tokens: 10, heuristicTokens: 10 },
    { seq: 1, tokens: 20, heuristicTokens: 20 },
    { seq: 2, tokens: 30, heuristicTokens: 30 },
    { seq: 3, tokens: 40, heuristicTokens: 40 },
  ]
  const range = selectRange(session, nodes, 40)
  assert.notEqual(range, null)
  assert.equal(range.start, 1)
  /* The cut must land after the tool result, never between the call and it. */
  assert.equal(range.end, 2)
  assert.deepEqual(range.shadowedSeqs, [1, 2])
  assert.equal(range.retainedTokens, 40)
})

test('selectRange refuses to compact the system head alone', () => {
  const { session } = fakeSession([10, 20], { kinds: ['system', 'user'] })
  const nodes = [
    { seq: 0, tokens: 10, heuristicTokens: 10 },
    { seq: 1, tokens: 20, heuristicTokens: 20 },
  ]
  assert.equal(selectRange(session, nodes, 0), null)
})

test('resolveBudgets restates the real trigger, not just the ratio', () => {
  const budgets = resolveBudgets(
    { thresholdRatio: 0.7, headroomTokens: 65536, retainRatio: 0.16 },
    { contextWindow: 1000000, reservedCompletionTokens: 384000, headroomTokens: 65536 },
  )
  /* min(1e6 * 0.7, 1e6 - 384000 - 65536) = 550464 */
  assert.equal(budgets.thresholdTokens, 550464)
  assert.equal(budgets.pressureBudget, 550464)
  assert.equal(budgets.retainTokens, Math.floor(616000 * 0.16))
})

test('resolveBudgets reports an exhausted window instead of guessing', () => {
  const budgets = resolveBudgets({ thresholdRatio: 0.7, headroomTokens: 65536 }, { contextWindow: 100000, reservedCompletionTokens: 100000 })
  assert.match(budgets.error, /reserves 100000 completion tokens/)
})

test('resolvePolicy applies an exact model override', () => {
  const base = resolvePolicy({ thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [] }, undefined)
  assert.equal(base.thresholdRatio, 0.8)
  const overridden = resolvePolicy(
    {
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      modelPolicies: [{ provider: 'qoder', model: 'dfmodel', thresholdRatio: 0.5 }],
    },
    { provider: 'qoder', model: 'dfmodel' },
  )
  assert.equal(overridden.thresholdRatio, 0.5)
  /* Untouched keys still inherit the top-level value. */
  assert.equal(overridden.retainRatio, 0.16)
})

test('composeInstruction keeps the standard shape and appends a focus', () => {
  const plain = composeInstruction({})
  assert.match(plain, /## Primary Request and Intent/)
  const focused = composeInstruction({ focus: 'keep every failing command' })
  assert.match(focused, /## Primary Request and Intent/)
  assert.match(focused, /Additional requirements for this checkpoint:\nkeep every failing command/)
  const replaced = composeInstruction({ instruction: 'Summarize as three sentences.' })
  assert.equal(replaced, 'Summarize as three sentences.')
  assert.doesNotMatch(replaced, /## Primary Request and Intent/)
})

test('frameSummary wraps blocks in the checkpoint tags', () => {
  const framed = frameSummary([{ type: 'text', text: 'body' }])
  assert.equal(framed.at(0).type, 'text')
  assert.match(framed.at(0).text, /<compacted-summary>$/)
  assert.equal(framed.at(1).text, 'body')
  assert.equal(framed.at(-1).text, '</compacted-summary>')
})

test('explicitRange rejects a cut that splits a tool pair', () => {
  const { session } = fakeSession([10, 20, 30], { kinds: ['system', 'assistant', 'tool-result'] })
  const nodes = [
    { seq: 0, tokens: 10 },
    { seq: 1, tokens: 20 },
    { seq: 2, tokens: 30 },
  ]
  /* Ending on the assistant node leaves its tool result outside the span. */
  const bad = explicitRange(session, nodes, 1, 1)
  assert.match(bad.error, /split a tool call/)
  /* Ending after the result is a balanced cut. */
  const good = explicitRange(session, nodes, 1, 2)
  assert.equal(good.error, undefined)
  assert.deepEqual(good.shadowedSeqs, [1, 2])
})

test('contextReport reports occupancy, the trigger, and a dry-run plan', async () => {
  const { session } = fakeSession([10, 20, 30, 40], { kinds: ['system', 'user', 'user', 'user'] })
  const nodes = [
    { seq: 0, tokens: 10, heuristicTokens: 10 },
    { seq: 1, tokens: 20, heuristicTokens: 20 },
    { seq: 2, tokens: 30, heuristicTokens: 30 },
    { seq: 3, tokens: 40, heuristicTokens: 40 },
  ]
  const ctx = fakeCtx({
    session,
    meter: fakeMeter(nodes),
    compaction: { config: { thresholdRatio: 0.5, headroomTokens: 0, retainRatio: 0.16, auto: true, modelPolicies: [] } },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 100 }) },
    agent: { status: 'idle', options: { provider: 'p', model: 'm' }, session },
  })
  /* The configured retention (99000 * 0.16) exceeds this tiny conversation, so
     only an explicit budget leaves a compactable span. */
  const report = await contextReport(ctx, 'session-1', { preview: true, rule: { retainTokens: 40 } })
  assert.equal(report.error, undefined)
  assert.equal(report.tokens.total, 100)
  /* threshold = min(window * 0.5, window - reservedOutput - headroom); the fake
     header reserves 1000 completion tokens of a 100000-token window. */
  assert.equal(report.tokens.threshold, 50000)
  assert.equal(report.tokens.toThreshold, 49900)
  assert.equal(report.budgets.retainTokens, Math.floor(99000 * 0.16))
  assert.equal(report.policy.auto, true)
  assert.equal(report.nodeCount, 4)
  assert.equal(report.plan.compactable, true)
  assert.equal(report.plan.startSeq, 1)
  assert.equal(report.nodes.length, 4)
  assert.equal(report.nodes[0].kind, 'system')
})

test('contextReport fails clearly when the session is not live', async () => {
  const ctx = fakeCtx({ session: { id: 'other' }, meter: fakeMeter([]), compaction: undefined, llm: undefined, agent: undefined })
  const report = await contextReport(ctx, 'missing')
  assert.match(report.error, /not live/)
})

/** Build a compaction engine whose summarizer is the stock one. */
function fakeEngine(calls) {
  return {
    config: { thresholdRatio: 0.8, headroomTokens: 0, retainRatio: 0.16, maxTokens: 2048, auto: true, modelPolicies: [] },
    async summarize(input, agent) {
      calls.push({ kind: 'stock', agent: agent?.session?.id })
      return { summary: [{ type: 'text', text: 'stock' }], provider: 'p', model: 'm' }
    },
  }
}

test('installSummarizerHook leaves unruled sessions on the stock path', async () => {
  const calls = []
  const engine = fakeEngine(calls)
  const state = { rules: new Map() }
  const ctx = { get: () => ({ stream: async function* () {} }) }
  const restore = installSummarizerHook(ctx, engine, state)
  await engine.summarize({ messages: [] }, { session: { id: 'a' } })
  assert.equal(calls.length, 1)
  restore()
  assert.equal(Object.hasOwn(engine, 'summarize'), false)
})

test('installSummarizerHook routes a ruled session to the custom instruction', async () => {
  const calls = []
  const engine = fakeEngine(calls)
  const state = { rules: new Map([['ruled', { focus: 'keep the failing command', consume: 'once' }]]) }
  const seen = []
  const ctx = {
    get: () => ({
      stream: (options) => {
        seen.push(options)
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: 'custom summary' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }),
  }
  installSummarizerHook(ctx, engine, state)
  const result = await engine.summarize({ messages: [] }, { session: { id: 'ruled', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), toolHistory: () => [] } })
  assert.equal(calls.length, 0)
  assert.equal(result.summary[0].text, 'custom summary')
  const instruction = seen[0].messages.at(-1).content[0].text
  assert.match(instruction, /keep the failing command/)
  assert.equal(seen[0].purpose, 'compaction')
  /* once-rules are consumed. */
  assert.equal(rulesOf(state).has('ruled'), false)
})

test('compactUnderRule writes the durable marker sequence and replaces the span', async () => {
  const { session, events } = fakeSession([10, 900, 40], { kinds: ['system', 'user', 'user'] })
  const nodes = [
    { seq: 0, tokens: 10, heuristicTokens: 10 },
    { seq: 1, tokens: 900, heuristicTokens: 900 },
    { seq: 2, tokens: 40, heuristicTokens: 40 },
  ]
  const calls = []
  const engine = fakeEngine(calls)
  const state = { rules: new Map() }
  const ctx = fakeCtx({
    session,
    meter: fakeMeter(nodes),
    compaction: engine,
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 1000 } }),
      stream: () =>
        (async function* () {
          yield { type: 'text-delta', index: 0, text: 'summary body' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
    },
    agent: { status: 'idle', options: { provider: 'p', model: 'm' }, session },
  })
  installSummarizerHook(ctx, engine, state)

  const result = await compactUnderRule(ctx, 'session-1', { retainTokens: 40, focus: 'keep it short', consume: 'once' }, { state })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.shadows, 1)
  assert.equal(result.shadowedRange.start, 1)

  const types = events.map((event) => event.type)
  assert.deepEqual(types.slice(-3), ['compaction/summary', 'user/message', 'compaction/end'])
  const replaced = events.at(-2)
  assert.deepEqual(replaced.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assert.match(replaced.data.content[0].text, /<compacted-summary>/)
  /* The one-shot rule is gone afterwards. */
  assert.equal(rulesOf(state).has('session-1'), false)
})

test('compactUnderRule dryRun plans without writing', async () => {
  const { session, events } = fakeSession([10, 20, 30, 40], { kinds: ['system', 'user', 'user', 'user'] })
  const nodes = [
    { seq: 0, tokens: 10, heuristicTokens: 10 },
    { seq: 1, tokens: 20, heuristicTokens: 20 },
    { seq: 2, tokens: 30, heuristicTokens: 30 },
    { seq: 3, tokens: 40, heuristicTokens: 40 },
  ]
  const engine = fakeEngine([])
  const ctx = fakeCtx({
    session,
    meter: fakeMeter(nodes),
    compaction: engine,
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1000 } }) },
    agent: { status: 'idle', options: { provider: 'p', model: 'm' }, session },
  })
  const before = events.length
  const result = await compactUnderRule(ctx, 'session-1', { retainTokens: 40 }, { state: { rules: new Map() }, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.plan.tokensAfter, 50)
  assert.equal(events.length, before)
})

test('compactUnderRule refuses a mid-turn session but still plans a dry run', async () => {
  const { session } = fakeSession([10, 900, 40], { kinds: ['system', 'user', 'user'] })
  const nodes = [
    { seq: 0, tokens: 10, heuristicTokens: 10 },
    { seq: 1, tokens: 900, heuristicTokens: 900 },
    { seq: 2, tokens: 40, heuristicTokens: 40 },
  ]
  const ctx = fakeCtx({
    session,
    meter: fakeMeter(nodes),
    compaction: fakeEngine([]),
    llm: undefined,
    agent: { status: 'running', options: {}, session },
  })
  const state = { rules: new Map() }

  /* A dry run is a read: it answers even mid-turn, and says the session is busy. */
  const planned = await compactUnderRule(ctx, 'session-1', { retainTokens: 40 }, { state, dryRun: true })
  assert.equal(planned.ok, true)
  assert.equal(planned.idle, false)

  /* Actually compacting still needs an idle session. */
  const refused = await compactUnderRule(ctx, 'session-1', { retainTokens: 40 }, { state })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /mid-turn/)
})

test('compactUnderRule refuses while a compaction lock is open', async () => {
  const { session, events } = fakeSession([10, 20], { kinds: ['system', 'user'] })
  events.push({ type: 'compaction/start', seq: 2, time: 2, data: { compactionId: 'x' } })
  const nodes = [
    { seq: 0, tokens: 10 },
    { seq: 1, tokens: 20 },
  ]
  const ctx = fakeCtx({
    session,
    meter: fakeMeter(nodes),
    compaction: fakeEngine([]),
    llm: undefined,
    agent: { status: 'idle', options: {}, session },
  })
  const result = await compactUnderRule(ctx, 'session-1', {}, { state: { rules: new Map() } })
  assert.equal(result.ok, false)
  assert.match(result.error, /already in flight/)
})
test('serviceDiagnosis separates the host plane from the agent-scoped plane', () => {
  const hostOnly = {
    get: (name, strict = true) => {
      if (name === 'sessions') return { flush() {} }
      if (name === 'agents') return { get: () => ({ ctx: scopedCtx }) }
      if (name === 'tokenMeter') return { measure() {} }
      /* compaction is NOT on the host plane */
      return undefined
    },
  }
  const scopedCtx = {
    get: (name, strict = true) => {
      if (name === 'compaction') {
        const engine = { config: { auto: true, thresholdRatio: 0.7 }, summarize() {}, compactRegion() {} }
        return strict ? engine : engine
      }
      return undefined
    },
  }

  const withoutSession = serviceDiagnosis(hostOnly)
  assert.equal(withoutSession.host.sessions.resolved, true)
  assert.equal(withoutSession.host.compaction.resolved, false)
  assert.match(withoutSession.note, /sessionId/)

  const withSession = serviceDiagnosis(hostOnly, 'session-1')
  assert.equal(withSession.host.compaction.resolved, false)
  assert.equal(withSession.scoped.services.compaction.resolved, true)
  assert.equal(withSession.scoped.services.compaction.config.thresholdRatio, 0.7)
  assert.ok(withSession.scoped.services.compaction.methods.includes('compactRegion'))
})

test('compactUnderRule resolves the engine from the agent-scoped context', async () => {
  const { session } = fakeSession([10, 900, 40], { kinds: ['system', 'user', 'user'] })
  const nodes = [
    { seq: 0, tokens: 10, heuristicTokens: 10 },
    { seq: 1, tokens: 900, heuristicTokens: 900 },
    { seq: 2, tokens: 40, heuristicTokens: 40 },
  ]
  const calls = []
  const engine = fakeEngine(calls)
  /* The host context has no compaction service; only the agent's ctx does. */
  const agentCtx = {
    get: (name, strict = true) => {
      if (name === 'compaction') return engine
      if (name === 'tokenMeter') return fakeMeter(nodes)
      if (name === 'llm') {
        return {
          resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }),
          stream: () =>
            (async function* () {
              yield { type: 'text-delta', index: 0, text: 'scoped summary' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })(),
        }
      }
      return undefined
    },
  }
  const services = new Map([
    ['sessions', { get: (id) => (id === session.id ? session : undefined), flush: async () => {} }],
    ['agents', { get: (id) => (id === session.id ? { status: 'idle', options: { provider: 'p', model: 'm' }, session, ctx: agentCtx } : undefined) }],
  ])
  const ctx = { get: (name) => services.get(name) }

  const state = { rules: new Map() }
  const result = await compactUnderRule(ctx, 'session-1', { retainTokens: 40, focus: 'scoped', consume: 'once' }, { state })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.summarySeq !== undefined, true)
})
