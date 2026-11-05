/**
 * Rule-driven compaction over the Host's compaction seam.
 *
 * Two public mechanisms are combined:
 *
 * 1. `summarize()` is the compaction engine's sole customization hook. Every
 *    trigger — manual, `/compact`, step pressure, context-overflow recovery —
 *    calls it dynamically through the engine instance, so assigning an own
 *    property that consults a per-session rule redirects the summarization
 *    instruction for exactly the sessions a caller opted in and leaves every
 *    other session on the stock behaviour.
 * 2. The durable transaction is the log's own marker sequence
 *    (`compaction/start`, `compaction/summary`, the replacement `user/message`,
 *    `compaction/end`), so the result stays readable by `/compact`, the automatic
 *    listeners, and the stock compaction lock.
 *
 * A rule is per session and may apply to one compaction or stand until replaced.
 */
import { randomUUID } from 'node:crypto'

import { pairingBalance, resolvePolicy, selectRange } from './context.js'

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Framing that makes the replacement message read as established background. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ' +
  'Treat the captured context as established background and build on it without restating it. Continue the task directly ' +
  'from the messages that follow, without acknowledging this checkpoint.'

/** The stock structured checkpoint, kept as the default shape. */
const BASE_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  '- [the user\u2019s original and evolving goals; quote verbatim where the exact wording matters]',
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Turn an arbitrary failure into a short message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** The per-session rule map, created on first use. */
export function rulesOf(state) {
  if (state.rules === undefined || state.rules === null) state.rules = new Map()
  return state.rules
}

/**
 * Compose the instruction one compaction should use.
 * @param rule - the rule for this session.
 * @returns the final user-turn instruction text.
 */
export function composeInstruction(rule) {
  const instruction = typeof rule?.instruction === 'string' ? rule.instruction.trim() : ''
  const focus = typeof rule?.focus === 'string' ? rule.focus.trim() : ''
  const base = instruction === '' ? BASE_INSTRUCTION : instruction
  return focus === '' ? base : `${base}\n\nAdditional requirements for this checkpoint:\n${focus}`
}

/** Wrap raw summary blocks in the durable checkpoint framing. */
export function frameSummary(summary) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/**
 * Resolve the provider/model a summarization call should use.
 *
 * Mirrors the engine's order: an explicitly configured summary pair, then the
 * session's own durable route, then the agent's options.
 * @param engine - compaction engine supplying its configuration.
 * @param agent - agent whose session supplies the routed header.
 * @returns the target, or `null` when nothing resolves.
 */
export function summarizationTarget(engine, agent) {
  const config = engine?.config ?? {}
  const provider = typeof config.summarizationProvider === 'string' ? config.summarizationProvider.trim() : ''
  const model = typeof config.summarizationModel === 'string' ? config.summarizationModel.trim() : ''
  if (provider !== '' && model !== '') return { provider, model }
  const routed = agent?.session?.requestHeader?.()?.config
  if (typeof routed?.provider === 'string' && routed.provider !== '' && typeof routed?.model === 'string' && routed.model !== '') {
    return { provider: routed.provider, model: routed.model }
  }
  if (typeof agent?.options?.provider === 'string' && agent.options.provider !== '' && typeof agent?.options?.model === 'string' && agent.options.model !== '') {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return null
}

/**
 * Run one summarization call with a caller-supplied instruction.
 *
 * The conversation prefix is replayed untouched and only the trailing instruction
 * is replaced, so the provider's warm prefix cache still applies.
 * @param ctx - Host context supplying the LLM service.
 * @param engine - compaction engine supplying the output cap.
 * @param input - replayed conversation prefix.
 * @param agent - agent owning the session.
 * @param signal - cancellation signal.
 * @param rule - the rule carrying the instruction.
 * @returns the summarization result in the shape the log records.
 */
export async function customSummarize(ctx, engine, input, agent, signal, rule) {
  /* A preset may scope its model route, so look the LLM up the same way every
   * other preset-owned service is resolved: registry first, host plane last. */
  const llm = serviceFrom(agent, ctx, 'llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('no LLM service is reachable for this session, so a custom compaction rule cannot be applied')
  }
  const target = summarizationTarget(engine, agent)
  if (target === null) {
    throw new Error(
      'no provider/model available for summarization: route one request in the session first, or configure summarizationProvider and summarizationModel',
    )
  }
  const maxTokens = Number(engine?.config?.maxTokens)
  const messages = [
    ...(Array.isArray(input?.messages) ? input.messages : []),
    { role: 'user', content: [{ type: 'text', text: composeInstruction(rule) }] },
  ]

  const texts = new Map()
  const order = []
  let usage
  let finish
  const stream = llm.stream({
    provider: target.provider,
    model: target.model,
    messages,
    toolHistory: agent?.session?.toolHistory?.(),
    ...(input?.tools === undefined ? {} : { tools: [...input.tools] }),
    ...(Number.isFinite(maxTokens) ? { maxTokens } : {}),
    sessionId: agent?.session?.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  })

  for await (const chunk of stream) {
    switch (chunk?.type) {
      case 'text-delta': {
        if (!texts.has(chunk.index)) order.push(chunk.index)
        texts.set(chunk.index, (texts.get(chunk.index) ?? '') + String(chunk.text ?? ''))
        break
      }
      case 'block-end': {
        if (chunk.block?.type === 'text') {
          if (!texts.has(chunk.index)) order.push(chunk.index)
          texts.set(chunk.index, String(chunk.block.text ?? ''))
        }
        break
      }
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finish = chunk
        break
      default:
        break
    }
  }

  if (finish?.reason?.kind === 'error' || finish?.reason?.kind === 'aborted') {
    const failure = finish.reason.failure ?? {}
    const error = new Error(String(failure.message ?? 'summarization failed'))
    error.code = failure.code
    throw error
  }
  if (finish?.reason?.kind === 'max-tokens') {
    const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
    error.code = 'MAX_TOKENS'
    throw error
  }

  const blocks = order
    .map((index) => ({ type: 'text', text: String(texts.get(index) ?? '') }))
    .filter((block) => block.text.trim() !== '')
  if (blocks.length === 0) throw new Error('the compaction rule produced no text summary content')

  return {
    summary: blocks,
    rawOutput: blocks,
    llmStreamCall: true,
    provider: target.provider,
    model: target.model,
    ...(Number.isFinite(maxTokens) ? { maxTokens } : {}),
    ...(usage === undefined ? {} : { usage }),
  }
}

/**
 * Redirect the engine's summarizer for sessions that carry a rule.
 *
 * The override is an own property on the mounted engine instance and is restored
 * by the returned disposer. Sessions without a rule keep calling the prototype
 * method, so the stock behaviour is untouched.
 * @param ctx - Host context.
 * @param engine - the mounted compaction engine.
 * @param state - bridge state holding per-session rules.
 * @returns a disposer restoring the original method.
 */
export function installSummarizerHook(ctx, engine, state, options = {}) {
  const original = engine.summarize
  if (typeof original !== 'function') return () => {}
  const rules = rulesOf(state)
  /* `callCtx` is the context the engine itself lives under; `hostCtx` reaches the
     preset registry, which is how a preset-scoped service becomes addressable. */
  const callCtx = options.callCtx ?? ctx
  const hostCtx = options.hostCtx ?? ctx

  const patched = function summarize(input, agent, signal) {
    const sessionId = agent?.session?.id
    const rule = sessionId === undefined ? undefined : rules.get(sessionId)
    if (rule === undefined || (rule.instruction === undefined && rule.focus === undefined)) {
      return original.call(this, input, agent, signal)
    }
    if (rule.consume === 'once') rules.delete(sessionId)
    return customSummarize({ get: (name, strict) => serviceFrom(agent, hostCtx, name) ?? callCtx.get?.(name, strict) }, this, input, agent, signal, rule)
  }

  engine.summarize = patched
  return () => {
    if (engine.summarize === patched) delete engine.summarize
  }
}

/**
 * Patch every session-scoped compaction engine as it appears.
 *
 * The engine is mounted per agent preset inside an isolated group, so there is no
 * single host-plane instance to patch once. Each new agent brings its own; the
 * weak set makes the patch idempotent across repeated pre-step passes.
 * @param state - bridge state holding per-session rules and the patch ledger.
 * @param agent - the agent whose scoped engine should carry the rule hook.
 * @param ctx - host context, used as a fallback for summarization calls.
 * @returns nothing; a no-op when the engine is already patched or absent.
 */
export function ensureSummarizerHook(state, agent, ctx) {
  const engine = serviceFrom(agent, ctx, 'compaction')
  if (engine === undefined || engine === null || typeof engine.summarize !== 'function') return
  if (state.patchedEngines === undefined) state.patchedEngines = new WeakSet()
  if (state.patchedEngines.has(engine)) return
  state.patchedEngines.add(engine)
  const scoped = agent?.ctx ?? ctx
  const restore = installSummarizerHook(scoped, engine, state, { callCtx: scoped, hostCtx: ctx, agent })
  if (state.summarizerRestores === undefined) state.summarizerRestores = []
  state.summarizerRestores.push(restore)
}

/**
 * Compact at the step boundary when a session's own rule says so.
 *
 * The built-in engine triggers at one configured fraction for every session. A
 * standing rule may name its own trigger, and this listener acts before the
 * engine does, so a session can compact earlier than the deployment default.
 * A rule without a trigger never fires here.
 * @param ctx - Host context.
 * @param state - bridge state holding per-session rules.
 * @param settings - resolved settings.
 * @returns a disposer removing the listener.
 */
export function installAutoTrigger(ctx, state, settings) {
  if (settings.contextTools !== true) return () => {}
  const rules = rulesOf(state)

  return ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      /* Every session-scoped engine gets the rule hook on its first turn, so a
         standing rule also governs compactions the built-in trigger starts. */
      try {
        ensureSummarizerHook(state, agent, ctx)
      } catch {
        /* A patch failure must never break the turn. */
      }
      const rule = rules.get(agent?.session?.id)
      if (rule === undefined || (rule.thresholdTokens === undefined && rule.thresholdRatio === undefined)) return next()
      if (signal?.aborted === true) return next()
      try {
        const engine = serviceFrom(agent, ctx, 'compaction')
        const meter = serviceFrom(agent, ctx, 'tokenMeter')
        if (engine === undefined || typeof engine.compactRegion !== 'function') return next()
        if (meter === undefined || typeof meter.measure !== 'function') return next()
        const session = agent.session
        if (compactionLockOpen(session)) return next()
        const measurement = meter.measure(session)
        const total = Number(measurement?.totalTokens ?? 0)
        const trigger =
          rule.thresholdTokens !== undefined
            ? rule.thresholdTokens
            : Math.floor(Number(rule.contextWindow ?? 0) * rule.thresholdRatio)
        if (!(trigger > 0) || total < trigger) return next()
        const retain =
          rule.retainTokens !== undefined
            ? rule.retainTokens
            : rule.retainRatio !== undefined
              ? Math.floor(total * rule.retainRatio)
              : 0
        const selected = selectRange(session, Array.isArray(measurement?.nodes) ? measurement.nodes : [], retain)
        if (selected === null) return next()
        const result = await engine.compactRegion(selected.start, selected.end, agent, signal)
        ctx.logger?.info?.(
          `subagent-bridge: rule compaction shadowed ${selected.shadowedSeqs.length} items (seqs ${selected.start}-${selected.end}, ~${selected.shadowedTokens} tokens)`,
        )
        void result
      } catch (error) {
        /* A failing rule must never break the turn it was meant to protect. */
        ctx.logger?.warn?.(`subagent-bridge: rule compaction failed: ${messageOf(error)}; continuing the turn`)
      }
      return next()
    },
    { prepend: true },
  )
}

/** Whether an unmatched `compaction/start` marker is still open. */
function compactionLockOpen(session) {
  let open
  let latestSeed
  for (const event of typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []) {
    if (event?.type === 'compaction/start') open = event
    else if (event?.type === 'compaction/end') open = undefined
    else if (event?.type === 'session/end-seed') latestSeed = event
  }
  if (open === undefined) return false
  return latestSeed === undefined || Number(latestSeed.seq) < Number(open.seq)
}

/** Whether the session currently has an open turn, and which one. */
function openTurnOf(session) {
  let turn
  for (const event of typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []) {
    if (event?.type === 'turn/start') turn = event
    else if (event?.type === 'turn/end') turn = undefined
  }
  return turn
}

/**
 * Validate a caller-chosen span without throwing.
 * @param session - session supplying the surface.
 * @param nodes - priced nodes.
 * @param startSeq - first surface seq.
 * @param endSeq - last surface seq.
 * @returns the span description, or `{ error }`.
 */
export function explicitRange(session, nodes, startSeq, endSeq) {
  const surface = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const startIdx = surface.indexOf(Number(startSeq))
  const endIdx = surface.indexOf(Number(endSeq))
  if (startIdx === -1) return { error: `startSeq ${startSeq} is not on the session surface` }
  if (endIdx === -1) return { error: `endSeq ${endSeq} is not on the session surface` }
  if (startIdx > endIdx) return { error: `startSeq ${startSeq} comes after endSeq ${endSeq}` }
  const { before, after } = pairingBalance(session)
  const problems = []
  if (before[startIdx] !== true) problems.push(`startSeq ${startSeq} would split a tool call from its result`)
  if (after[endIdx] !== true) problems.push(`endSeq ${endSeq} would split a tool call from its result, or its step is still open`)
  if (problems.length > 0) return { error: problems.join('; ') }
  return {
    start: surface[startIdx],
    end: surface[endIdx],
    shadowedSeqs: surface.slice(startIdx, endIdx + 1),
    shadowedTokens: nodes.slice(startIdx, endIdx + 1).reduce((total, node) => total + Number(node?.tokens ?? 0), 0),
    retainedSeqs: surface.slice(endIdx + 1),
    retainedTokens: nodes.slice(endIdx + 1).reduce((total, node) => total + Number(node?.tokens ?? 0), 0),
  }
}

/**
 * Plan the span a rule would shadow, without mutating anything.
 * @param session - session supplying the surface.
 * @param nodes - priced nodes.
 * @param retainTokens - recent tail budget kept verbatim, when known.
 * @param range - explicit span, when the caller chose one.
 * @returns `{ range }` when a span is available, otherwise `{ error }`.
 */
export function planRange(session, nodes, retainTokens, range) {
  if (range !== undefined) {
    const described = explicitRange(session, nodes, range.startSeq, range.endSeq)
    return described.error === undefined ? { range: described } : { error: described.error }
  }
  const selected = selectRange(session, nodes, retainTokens)
  return selected === null
    ? { error: 'nothing is safely compactable under this rule (the surface is one indivisible span)' }
    : { range: selected }
}

/**
 * Resolve one service the way a session resolves it: its own agent context first,
 * then the host plane.
 * @param agent - the session's live agent.
 * @param ctx - host context.
 * @param name - service name.
 * @returns the service, or undefined when neither plane provides it.
 */
export function serviceFrom(agent, ctx, name) {
  /*
   * A preset may mount a service inside an isolated group, which puts it on the
   * composition subtree rather than any context reachable from here. The preset
   * registry is the supported way to read such a service: it walks the agent's
   * own mounted revision and returns the implementation owned by that subtree.
   */
  try {
    const presets = ctx.get('agentPresets')
    if (presets !== undefined && presets !== null && typeof presets.serviceFor === 'function') {
      const value = presets.serviceFor(agent, name)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    /* No preset registry, or a preset that no longer composes this agent. */
  }

  const scoped = agent?.ctx
  if (scoped !== undefined && scoped !== null) {
    for (const strict of [true, false]) {
      try {
        const value = scoped.get(name, strict)
        if (value !== undefined && value !== null) return value
      } catch {
        /* A closed fiber answers nothing; try the host plane instead. */
      }
    }
  }
  try {
    const value = ctx.get(name)
    if (value !== undefined && value !== null) return value
  } catch {
    /* Unavailable on this plane too. */
  }
  try {
    return ctx.get(name, false) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Compact one session under a caller rule.
 *
 * @param ctx - Host context.
 * @param sessionId - session to compact.
 * @param rule - retention, summary instruction, and whether the rule persists.
 * @param options - dryRun, signal, and bridge state.
 * @returns the committed result, or the plan when `dryRun` is set.
 */
export async function compactUnderRule(ctx, sessionId, rule, options = {}) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) {
    return { ok: false, error: 'session is not live in this Host: open it, or dispatch a turn to it, before compacting' }
  }
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (agent === undefined || agent === null) {
    return { ok: false, error: 'session has no live agent: open it in the app, then retry' }
  }
  /* Compaction is mounted per agent preset in an isolated group, so it is only
     reachable through the session's own context, never the host plane. */
  const engine = serviceFrom(agent, ctx, 'compaction')
  if (engine === undefined || engine === null) {
    return {
      ok: false,
      error:
        'the compaction engine is not mounted for this session\u2019s preset: probe dsh_services with this sessionId to see both planes',
    }
  }
  const meter = serviceFrom(agent, ctx, 'tokenMeter')
  if (meter === undefined || typeof meter.measure !== 'function') {
    return { ok: false, error: 'no token meter is reachable for this session, so compaction ranges cannot be priced' }
  }
  if (compactionLockOpen(session)) {
    return { ok: false, error: 'another compaction is already in flight for this session' }
  }

  let measurement
  try {
    measurement = meter.measure(session)
  } catch (error) {
    return { ok: false, error: `token meter failed: ${messageOf(error)}` }
  }
  const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : []
  const routed = agent?.session?.requestHeader?.()?.config
  const target =
    typeof routed?.provider === 'string' && routed.provider !== '' && typeof routed?.model === 'string' && routed.model !== ''
      ? { provider: routed.provider, model: routed.model }
      : undefined
  const policy = resolvePolicy(engine.config ?? {}, target)

  if (rule?.range !== undefined) {
    const described = explicitRange(session, nodes, rule.range.startSeq, rule.range.endSeq)
    if (described.error !== undefined) return { ok: false, error: described.error }
  }

  const retain =
    rule?.retainTokens !== undefined
      ? rule.retainTokens
      : rule?.retainRatio !== undefined
        ? Math.floor(Number(measurement?.totalTokens ?? 0) * rule.retainRatio)
        : typeof policy.retainTokens === 'number'
          ? policy.retainTokens
          : undefined
  const planned = planRange(session, nodes, retain, rule?.range)
  if (planned.error !== undefined) return { ok: false, error: planned.error }
  const range = planned.range

  const tokensBefore = Number(measurement?.totalTokens ?? 0)
  const plan = {
    startSeq: range.start,
    endSeq: range.end,
    shadows: range.shadowedSeqs.length,
    shadowedTokens: range.shadowedTokens,
    retained: range.retainedSeqs.length,
    retainedTokens: range.retainedTokens,
    tokensBefore,
    tokensAfter: Math.max(0, tokensBefore - range.shadowedTokens),
  }
  if (options.dryRun === true) return { ok: true, dryRun: true, plan, idle: agent.status !== 'running' }
  if (agent.status === 'running') {
    return {
      ok: false,
      error: 'session is mid-turn: compaction needs an idle session; end or pause the turn first',
      plan,
    }
  }

  const rules = options.state === undefined ? new Map() : rulesOf(options.state)
  const staged = {
    instruction: typeof rule?.instruction === 'string' ? rule.instruction : undefined,
    focus: typeof rule?.focus === 'string' ? rule.focus : undefined,
    consume: 'once',
  }
  const previous = rules.get(sessionId)
  rules.set(sessionId, staged)

  try {
    const committed = await commitCompaction(ctx, engine, session, agent, range, {
      ...options,
      rule: staged,
      shadowedTokenCount: range.shadowedTokens,
    })
    return { ok: true, ...plan, ...committed }
  } catch (error) {
    return { ok: false, error: messageOf(error), plan }
  } finally {
    if (previous === undefined) rules.delete(sessionId)
    else rules.set(sessionId, previous)
  }
}

/**
 * Commit one compaction.
 *
 * With an open turn the engine's own region entry point is used, which keeps the
 * automatic path's invariants. An idle session takes the manual marker sequence,
 * with the caller's retention rather than a fixed tail.
 * @param ctx - Host context.
 * @param engine - compaction engine.
 * @param session - session to mutate.
 * @param agent - live agent owning the session.
 * @param range - validated span.
 * @param options - signal, command identity, rule, and shadowed token count.
 * @returns the committed marker identities.
 */
async function commitCompaction(ctx, engine, session, agent, range, options) {
  const openTurn = openTurnOf(session)
  if (openTurn !== undefined && typeof engine.compactRegion === 'function') {
    const result = await engine.compactRegion(range.start, range.end, agent, options.signal)
    return {
      source: 'engine.compactRegion',
      shadowedRange: result?.shadowedRange ?? { start: range.start, end: range.end },
      summarySeq: result?.summarySeq,
      endSeq: result?.endSeq,
      shadowedTokenCount: result?.shadowedTokenCount,
    }
  }

  const compactionId = `bridge-${randomUUID()}`
  const lifecycle = {
    compactionId,
    ...(typeof options.commandId === 'string' ? { sourceCommandId: options.commandId } : {}),
    turn: null,
  }
  const header = session.requestHeader?.()
  const surface = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
  const headSeq = surface[0]
  const headEvent = headSeq === undefined ? undefined : session.eventAt?.(headSeq)
  const system = headEvent?.type === 'system/message' ? session.deriveEventMessage(headEvent) : null
  const regionMessages = range.shadowedSeqs
    .map((seq) => session.deriveEventMessage(session.eventAt?.(seq)))
    .filter((message) => message !== null && message !== undefined)
  const input = {
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: system === null ? regionMessages : [system, ...regionMessages],
  }

  const startEvent = session.append('compaction/start', lifecycle)
  let summaryEvent
  let closed = false
  try {
    const summaryResult = await customSummarize(ctx, engine, input, agent, options.signal, options.rule ?? {})

    const checkpoint = {
      id: randomUUID(),
      role: 'user',
      content: frameSummary(summaryResult.summary),
      source: {
        kind: 'compact-checkpoint',
        compactionId,
        ...(typeof options.commandId === 'string' ? { sourceCommandId: options.commandId } : {}),
      },
    }
    const meter = ctx.get('tokenMeter')
    if (typeof meter?.estimateMessage === 'function') {
      const framed = meter.estimateMessage(checkpoint)
      if (Number.isFinite(framed) && framed >= range.shadowedTokens) {
        throw new Error(
          `summary is not smaller than the shadowed content (${framed} estimated framed tokens >= ${range.shadowedTokens})`,
        )
      }
    }

    summaryEvent = session.append('compaction/summary', {
      compactionId,
      ...(typeof options.commandId === 'string' ? { sourceCommandId: options.commandId } : {}),
      summary: summaryResult.summary,
      rawOutput: summaryResult.rawOutput,
      llmStreamCall: true,
      shadowedRange: { start: range.start, end: range.end },
      shadowedSeqs: [...range.shadowedSeqs],
      shadowedTokenCount: options.shadowedTokenCount ?? range.shadowedTokens,
      provider: summaryResult.provider,
      model: summaryResult.model,
      ...(summaryResult.maxTokens === undefined ? {} : { maxTokens: summaryResult.maxTokens }),
      ...(summaryResult.usage === undefined ? {} : { usage: summaryResult.usage }),
    })
    session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...range.shadowedSeqs],
    })
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    if (typeof ctx.get('sessions')?.flush === 'function') await ctx.get('sessions').flush(session)
    return {
      source: 'bridge.transaction',
      shadowedRange: { start: range.start, end: range.end },
      summarySeq: Number(summaryEvent.seq),
      endSeq: Number(endEvent.seq),
      shadowedTokenCount: options.shadowedTokenCount ?? range.shadowedTokens,
    }
  } catch (error) {
    if (!closed) {
      try {
        session.append('compaction/end', {
          ...lifecycle,
          error: { message: messageOf(error) },
        })
      } catch {
        /* The orphaned start marker is the durable record of the failure. */
      }
    }
    throw error
  }
}