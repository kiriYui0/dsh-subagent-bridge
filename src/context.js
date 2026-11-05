/**
 * Context inspection: turn the Host's token meter, routing header, and compaction
 * policy into one readable report.
 *
 * Everything here is read-only. The report answers three questions a caller needs
 * before deciding to compact: how full is the window, where does the automatic
 * threshold actually sit, and which history items would a given rule shadow.
 *
 * No Host package is imported. The meter, the model catalogue, and the compaction
 * engine are reached through `ctx.get(...)` and are duck-typed, so the bridge keeps
 * working on a Host whose internals differ.
 */

/** Turn an arbitrary failure into a short message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Read one numeric field, ignoring anything that is not a finite number. */
function numberField(source, key) {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Balance the surface so a cut never splits a tool call from its result.
 *
 * Mirrors the Host's own pairing rule: a cut before a node is safe when no tool
 * call is outstanding at that position. The returned array has one entry per
 * surface node, `before[i]` being the safety of the cut immediately before node
 * `i` and `after[i]` the safety of the cut immediately after it.
 * @param session - session supplying the surface and its events.
 * @returns per-position cut safety.
 */
export function pairingBalance(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const before = []
  const after = []
  let outstanding = 0
  for (let index = 0; index < nodes.length; index += 1) {
    before.push(outstanding === 0)
    const event = session.eventAt?.(nodes[index])
    if (event?.type === 'assistant/message') {
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
      outstanding += blocks.filter((block) => block?.type === 'tool-call').length
    } else if (event?.type === 'tool/result') {
      outstanding -= 1
    }
    after.push(outstanding === 0)
  }
  return { before, after, nodes }
}

/** Describe one surface node by kind, without exposing its text. */
function nodeKind(event) {
  switch (event?.type) {
    case 'system/message':
      return 'system'
    case 'user/message':
      return 'user'
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return 'tool-result'
    case 'request/header':
      return 'header'
    default:
      return typeof event?.type === 'string' ? event.type : 'unknown'
  }
}

/** Flatten one message event into plain text, for previews only. */
function previewText(event, limit) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block?.text === 'string' && block.text !== '') parts.push(block.text)
    else if (block?.type === 'tool-call') parts.push(`[tool-call ${String(block.name ?? '')}]`)
    else if (block?.type === 'image') parts.push('[image]')
    else if (block?.type === 'file') parts.push('[file]')
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined
}

/**
 * Resolve the policy a routed target would actually use.
 *
 * Mirrors the Host's resolution order: the top-level values are the defaults, and
 * an exact `{ provider, model }` entry in `modelPolicies` overrides the subset it
 * names.
 * @param config - the compaction engine's resolved configuration.
 * @param target - routed provider/model, when one is recorded.
 * @returns the merged per-target policy.
 */
export function resolvePolicy(config, target) {
  const base = {
    thresholdRatio: numberField(config, 'thresholdRatio'),
    headroomTokens: numberField(config, 'headroomTokens'),
    retainRatio: numberField(config, 'retainRatio'),
    retainTokens: numberField(config, 'retainTokens'),
    maxTokens: numberField(config, 'maxTokens'),
    summarizationProvider: typeof config?.summarizationProvider === 'string' ? config.summarizationProvider : '',
    summarizationModel: typeof config?.summarizationModel === 'string' ? config.summarizationModel : '',
    auto: config?.auto === true,
    modelPolicies: config?.modelPolicies,
  }
  if (target === undefined) return base
  const policies = Array.isArray(config?.modelPolicies) ? config.modelPolicies : []
  const match = policies.find(
    (entry) => entry?.provider === target.provider && entry?.model === target.model,
  )
  if (match === undefined) return base
  const merged = { ...base }
  for (const key of Object.keys(base)) {
    if (match[key] !== undefined) merged[key] = match[key]
  }
  return merged
}

/**
 * Recompute the Host's trigger and retention budgets for one routed target.
 *
 * This is the same arithmetic the compaction engine uses, restated here so a
 * caller can see the real trigger rather than guessing from the ratio alone.
 * @param policy - merged per-target policy.
 * @param capacity - context window, reserved completion tokens, headroom.
 * @returns threshold and retention budgets, or the reason they cannot resolve.
 */
export function resolveBudgets(policy, capacity) {
  const { contextWindow, reservedCompletionTokens, headroomTokens } = capacity
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { error: 'the routed model declares no context window' }
  }
  const reserved = Number.isFinite(reservedCompletionTokens) ? reservedCompletionTokens : 0
  const headroom = Number.isFinite(headroomTokens) ? headroomTokens : 0
  const messageBudget = contextWindow - reserved
  if (messageBudget <= 0) {
    return { error: `the routed request reserves ${reserved} completion tokens of a ${contextWindow}-token window` }
  }
  const pressureBudget = messageBudget - headroom
  if (pressureBudget <= 0) {
    return { error: `completion (${reserved}) plus headroom (${headroom}) exhaust the ${contextWindow}-token window` }
  }
  const ratio = Number.isFinite(policy.thresholdRatio) ? policy.thresholdRatio : 0.8
  const thresholdTokens = Math.floor(Math.min(contextWindow * ratio, pressureBudget))
  const retainTokens =
    policy.retainTokens !== undefined
      ? policy.retainTokens
      : Math.floor(messageBudget * (Number.isFinite(policy.retainRatio) ? policy.retainRatio : 0.16))
  return {
    contextWindow,
    reservedCompletionTokens: reserved,
    headroomTokens: headroom,
    messageBudget,
    pressureBudget,
    thresholdRatio: ratio,
    thresholdTokens,
    retainTokens,
  }
}

/**
 * Pick the inclusive surface span a rule would shadow.
 *
 * Starts at the first non-system node, keeps a priced recent tail, never splits a
 * tool pair, and refuses to return an empty range.
 * @param session - session supplying the surface.
 * @param nodes - meter-priced surface nodes, in model-visible order.
 * @param retainTokens - recent tail budget kept verbatim.
 * @returns the span, or `null` when nothing is safely compactable.
 */
export function selectRange(session, nodes, retainTokens) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const surface = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  if (surface.length !== nodes.length) return null
  const head = session.eventAt?.(surface[0])
  const firstIdx = head?.type === 'system/message' ? 1 : 0
  const budget = Number.isFinite(retainTokens) ? retainTokens : 0

  let accumulated = 0
  let keepFromIdx = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += Number(nodes[index]?.tokens ?? 0)
    keepFromIdx = index
    if (accumulated >= budget) break
  }
  if (keepFromIdx <= firstIdx) return null

  const { before } = pairingBalance(session)
  while (keepFromIdx > firstIdx && before[keepFromIdx] !== true) keepFromIdx -= 1
  if (keepFromIdx <= firstIdx) return null

  const shadowed = surface.slice(firstIdx, keepFromIdx)
  const shadowedTokens = nodes.slice(firstIdx, keepFromIdx).reduce((total, node) => total + Number(node?.tokens ?? 0), 0)
  return {
    start: surface[firstIdx],
    end: surface[keepFromIdx - 1],
    shadowedSeqs: shadowed,
    shadowedTokens,
    retainedSeqs: surface.slice(keepFromIdx),
    retainedTokens: nodes.slice(keepFromIdx).reduce((total, node) => total + Number(node?.tokens ?? 0), 0),
  }
}

/**
 * Resolve the session, its agent, and the services the report needs.
 * @param ctx - Host context.
 * @param sessionId - session to inspect.
 * @returns live handles, or a reason the session cannot be inspected.
 */
/**
 * Describe one service as seen from a context.
 * @param ctx - context to query.
 * @param name - service name.
 * @returns resolution state plus the methods it exposes.
 */
function describeService(ctx, name) {
  if (ctx === undefined || ctx === null) return { resolved: false, note: 'no context' }
  let strict
  let loose
  try {
    strict = ctx.get(name)
  } catch (error) {
    return { resolved: false, error: messageOf(error) }
  }
  try {
    loose = ctx.get(name, false)
  } catch {
    loose = undefined
  }
  const value = strict ?? loose
  const resolved = strict !== undefined && strict !== null
  if (value === undefined || value === null) return { resolved: false, whenInactive: false }
  return {
    resolved,
    whenInactive: loose !== undefined && loose !== null,
    kind: value?.constructor?.name ?? typeof value,
    methods: ['measure', 'summarize', 'compactNow', 'compactRegion', 'resolveModelInfo', 'stream', 'estimateMessage', 'flush']
      .filter((method) => typeof value?.[method] === 'function'),
    ...(name === 'compaction' && value?.config !== undefined
      ? {
          config: {
            auto: value.config.auto,
            thresholdRatio: value.config.thresholdRatio,
            retainRatio: value.config.retainRatio,
            retainTokens: value.config.retainTokens,
            headroomTokens: value.config.headroomTokens,
          },
        }
      : {}),
  }
}

/**
 * Report which Host services are reachable, from the host plane and from the
 * session's own agent context.
 *
 * Compaction is mounted per agent preset inside an isolated group, so a host-plane
 * plugin cannot see it. Splitting the report by plane is what makes that legible
 * instead of looking like a missing deployment.
 * @param ctx - Host context.
 * @param sessionId - optional session whose scoped context is also probed.
 * @returns the two-plane diagnosis.
 */
export function serviceDiagnosis(ctx, sessionId) {
  const names = ['sessions', 'agents', 'tokenMeter', 'compaction', 'llm', 'sessionController']
  const host = {}
  for (const name of names) host[name] = describeService(ctx, name)

  const report = { host, compactionPlane: 'agent preset (isolated)' }
  if (typeof sessionId !== 'string' || sessionId === '') {
    report.note =
      'pass sessionId to also probe the session-scoped context: compaction lives on that plane, not the host plane'
    return report
  }
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (agent === undefined || agent === null) {
    report.scoped = { error: 'session has no live agent, so its scoped context cannot be probed' }
    return report
  }
  const presets = (() => {
    try {
      const value = ctx.get('agentPresets')
      return value !== undefined && value !== null && typeof value.serviceFor === 'function' ? value : undefined
    } catch {
      return undefined
    }
  })()
  const sessionReport = {}
  for (const name of names) {
    let presetValue
    if (presets !== undefined) {
      try {
        presetValue = presets.serviceFor(agent, name)
      } catch (error) {
        presetValue = undefined
        sessionReport[name] = { presetError: messageOf(error) }
      }
    }
    if (sessionReport[name] === undefined) {
      sessionReport[name] = presetValue === undefined || presetValue === null
        ? describeService(agent.ctx, name)
        : {
            resolved: true,
            via: 'preset registry',
            kind: presetValue?.constructor?.name ?? typeof presetValue,
            methods: ['measure', 'summarize', 'compactNow', 'compactRegion', 'resolveModelInfo', 'stream', 'estimateMessage', 'flush']
              .filter((method) => typeof presetValue?.[method] === 'function'),
            ...(name === 'compaction' && presetValue?.config !== undefined
              ? {
                  config: {
                    auto: presetValue.config.auto,
                    thresholdRatio: presetValue.config.thresholdRatio,
                    retainRatio: presetValue.config.retainRatio,
                    retainTokens: presetValue.config.retainTokens,
                    headroomTokens: presetValue.config.headroomTokens,
                  },
                }
              : {}),
          }
    }
  }
  const scoped = agent.ctx
  report.scoped = {
    available: scoped !== undefined && scoped !== null,
    services: sessionReport,
    viaPreset:
      (() => {
        try {
          const presets = ctx.get('agentPresets')
          return presets !== undefined && presets !== null && typeof presets.serviceFor === 'function'
        } catch {
          return false
        }
      })(),
  }
  return report
}

export function resolveHandles(ctx, sessionId) {
  const session = ctx.get('sessions')?.get?.(sessionId)
  if (session === undefined || session === null) {
    return {
      error:
        'session is not live in this Host: open it (or dispatch a turn to it) first, because context is read from the running session surface',
    }
  }
  const agent = ctx.get('agents')?.get?.(sessionId)

  /*
   * The compaction backend is mounted per agent preset inside an isolated group
   * (`isolate: { compaction: true }`), not on the host plane. The host context
   * this plugin lives in therefore cannot see it: it is reachable only through
   * the session's own agent context.
   */
  const presets = (() => {
    try {
      const value = ctx.get('agentPresets')
      return value !== undefined && value !== null && typeof value.serviceFor === 'function' ? value : undefined
    } catch {
      return undefined
    }
  })()
  const resolve = (name) => {
    if (presets !== undefined && agent !== undefined) {
      try {
        const value = presets.serviceFor(agent, name)
        if (value !== undefined && value !== null) return value
      } catch {
        /* The agent may no longer be composed under a preset. */
      }
    }
    const scoped = agent?.ctx
    if (scoped !== undefined && scoped !== null) {
      for (const strict of [true, false]) {
        try {
          const value = scoped.get(name, strict)
          if (value !== undefined && value !== null) return value
        } catch {
          /* Fall through to the host plane. */
        }
      }
    }
    try {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    } catch {
      /* Not on the host plane either. */
    }
    return undefined
  }

  return {
    session,
    agent,
    meter: resolve('tokenMeter'),
    compaction: resolve('compaction'),
    llm: resolve('llm'),
    viaPreset: presets !== undefined,
    scoped: agent?.ctx !== undefined && agent?.ctx !== null,
  }
}

/**
 * Build the context report for one session.
 * @param ctx - Host context.
 * @param sessionId - session to inspect.
 * @param options - rule to plan for, and whether to include node previews.
 * @returns the report, or `{ error }` when the session or meter is unavailable.
 */
export async function contextReport(ctx, sessionId, options = {}) {
  const handles = resolveHandles(ctx, sessionId)
  if (handles.error !== undefined) return handles
  const { session, agent, meter, compaction, llm } = handles
  if (meter === undefined || typeof meter.measure !== 'function') {
    return { error: 'this Host exposes no token meter, so context occupancy cannot be measured' }
  }

  let measurement
  try {
    measurement = meter.measure(session)
  } catch (error) {
    return { error: `token meter failed: ${messageOf(error)}` }
  }

  const header = session.requestHeader?.()
  const routeConfig = header?.config
  const target =
    typeof routeConfig?.provider === 'string' && routeConfig.provider !== '' && typeof routeConfig?.model === 'string' && routeConfig.model !== ''
      ? { provider: routeConfig.provider, model: routeConfig.model }
      : agent?.options?.provider !== undefined && agent?.options?.model !== undefined
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined

  const policy = resolvePolicy(compaction?.config ?? {}, target)

  let capacity
  let budgets
  if (target !== undefined && llm !== undefined && typeof llm.resolveModelInfo === 'function') {
    try {
      const info = await llm.resolveModelInfo(target.provider, target.model)
      const contextWindow = numberField(info?.context, 'contextWindow')
      budgets = resolveBudgets(policy, {
        contextWindow,
        reservedCompletionTokens: numberField(routeConfig, 'maxTokens') ?? numberField(info, 'defaultMaxTokens') ?? 0,
        headroomTokens: policy.headroomTokens,
      })
      capacity = { contextWindow, defaultMaxTokens: numberField(info, 'defaultMaxTokens') }
    } catch (error) {
      capacity = { error: messageOf(error) }
    }
  } else if (target === undefined) {
    capacity = { error: 'no routed request yet: the session has not called a model' }
  }

  const totalTokens = Number(measurement?.totalTokens ?? 0)
  const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : []
  const surface = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []

  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const compactions = []
  let activeCompaction
  for (const event of events) {
    if (event?.type === 'compaction/summary') {
      const data = event.data ?? {}
      compactions.push({
        seq: Number(event.seq),
        time: Number(event.time),
        shadowedRange: data.shadowedRange,
        shadowedCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
        shadowedTokens: Number(data.shadowedTokenCount ?? 0),
        provider: data.provider,
        model: data.model,
      })
    }
    if (event?.type === 'compaction/start' && activeCompaction === undefined) {
      activeCompaction = { seq: Number(event.seq), time: Number(event.time) }
    }
    if (event?.type === 'compaction/end') activeCompaction = undefined
  }

  const rule = options.rule ?? {}
  const planRetain =
    rule.range !== undefined
      ? undefined
      : rule.retainTokens !== undefined
        ? rule.retainTokens
        : rule.retainRatio !== undefined
          ? Math.floor((budgets?.messageBudget ?? totalTokens) * rule.retainRatio)
          : budgets?.retainTokens
  const plan =
    rule.range !== undefined
      ? describeExplicitRange(session, nodes, rule.range.startSeq, rule.range.endSeq)
      : selectRange(session, nodes, planRetain)

  const detailed = options.preview === true
  const nodeRows = nodes.map((node, index) => {
    const seq = Number(node?.seq ?? surface[index])
    const event = session.eventAt?.(seq)
    return {
      seq,
      kind: nodeKind(event),
      tokens: Number(node?.tokens ?? 0),
      ...(typeof event?.data?.message?.role === 'string' ? { role: event.data.message.role } : {}),
      ...(detailed ? { preview: previewText(event, Number(options.previewChars ?? 160)) } : {}),
    }
  })

  const thresholdTokens = budgets?.thresholdTokens
  return {
    sessionId,
    ...(typeof agent?.status === 'string' ? { status: agent.status } : {}),
    ...(target === undefined ? {} : { model: `${target.provider}/${target.model}` }),
    tokens: {
      total: totalTokens,
      surface: Number(measurement?.surfaceTokens ?? 0),
      surfaceDelta: Number(measurement?.surfaceDeltaTokens ?? 0),
      baseline: measurement?.baseline,
      ...(thresholdTokens === undefined
        ? {}
        : {
            threshold: thresholdTokens,
            toThreshold: thresholdTokens - totalTokens,
            fillRatio: thresholdTokens === 0 ? null : Number((totalTokens / thresholdTokens).toFixed(4)),
            windowFillRatio:
              budgets?.contextWindow === undefined || budgets.contextWindow === 0
                ? null
                : Number((totalTokens / budgets.contextWindow).toFixed(4)),
          }),
    },
    ...(capacity === undefined ? {} : { capacity }),
    ...(budgets === undefined ? {} : { budgets }),
    policy: {
      auto: policy.auto,
      thresholdRatio: policy.thresholdRatio,
      retainRatio: policy.retainRatio,
      retainTokens: policy.retainTokens,
      summarization:
        policy.summarizationProvider === ''
          ? 'the session\u2019s own routed model'
          : `${policy.summarizationProvider}/${policy.summarizationModel}`,
    },
    nodeCount: nodes.length,
    headSeq: surface[0] ?? null,
    lastSeq: Number(session.seq ?? 0),
    ...(activeCompaction === undefined ? {} : { activeCompaction }),
    compactions,
    plan:
      plan === null
        ? { compactable: false, reason: 'nothing is safely compactable under this rule' }
        : {
            compactable: true,
            startSeq: plan.start,
            endSeq: plan.end,
            shadows: plan.shadowedSeqs.length,
            shadowedTokens: plan.shadowedTokens,
            retained: plan.retainedSeqs.length,
            retainedTokens: plan.retainedTokens,
            projectedTotal: totalTokens - plan.shadowedTokens,
            ...(plan.error === undefined ? {} : { error: plan.error }),
          },
    ...(detailed ? { nodes: nodeRows } : {}),
  }
}

/**
 * Describe a caller-chosen span, reporting rather than throwing on a bad cut.
 * @param session - session supplying the surface.
 * @param nodes - meter-priced nodes.
 * @param startSeq - first surface seq.
 * @param endSeq - last surface seq.
 * @returns the span description.
 */
export function describeExplicitRange(session, nodes, startSeq, endSeq) {
  const surface = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
  const startIdx = surface.indexOf(Number(startSeq))
  const endIdx = surface.indexOf(Number(endSeq))
  if (startIdx === -1) return { start: startSeq, end: endSeq, shadowedSeqs: [], shadowedTokens: 0, retainedSeqs: [], retainedTokens: 0, error: `startSeq ${startSeq} is not on the surface` }
  if (endIdx === -1) return { start: startSeq, end: endSeq, shadowedSeqs: [], shadowedTokens: 0, retainedSeqs: [], retainedTokens: 0, error: `endSeq ${endSeq} is not on the surface` }
  if (startIdx > endIdx) return { start: startSeq, end: endSeq, shadowedSeqs: [], shadowedTokens: 0, retainedSeqs: [], retainedTokens: 0, error: `startSeq ${startSeq} is after endSeq ${endSeq}` }
  const { before, after } = pairingBalance(session)
  const problems = []
  if (before[startIdx] !== true) problems.push(`startSeq ${startSeq} splits a tool call from its result`)
  if (after[endIdx] !== true) problems.push(`endSeq ${endSeq} splits a tool call from its result, or its step is still open`)
  const shadowedSeqs = surface.slice(startIdx, endIdx + 1)
  return {
    start: surface[startIdx],
    end: surface[endIdx],
    shadowedSeqs,
    shadowedTokens: nodes.slice(startIdx, endIdx + 1).reduce((total, node) => total + Number(node?.tokens ?? 0), 0),
    retainedSeqs: surface.slice(endIdx + 1),
    retainedTokens: nodes.slice(endIdx + 1).reduce((total, node) => total + Number(node?.tokens ?? 0), 0),
    ...(problems.length === 0 ? {} : { error: problems.join('; ') }),
  }
}