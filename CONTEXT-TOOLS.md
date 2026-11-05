# Context tools (`dsh_context`, `dsh_services`, `dsh_compact`)

Fork addition over upstream `dsh-subagent-bridge` 0.21.0.

The upstream bridge exposes 10 tools for *dispatching* work. It deliberately exposes no way to
inspect or steer a session's context. These three tools close that gap.

## Why it needed a separate plane

The DSH web bundle disables the host-plane compactor:

```yaml
# @deepseek-ai/dsh-web-app/cordis.patch.yml
- id: compaction-basic
  disabled: true
```

Each agent preset mounts its own copy inside an isolated group:

```yaml
# @deepseek-ai/dsh-web-app/presets/standard.patch.yml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
```

So from a host-plane plugin, `ctx.get('compaction')` is **always undefined** — and
`agent.ctx.get('compaction')` is too, because that context only scopes effects.

The supported entry point is the preset registry:

```js
ctx.get('agentPresets').serviceFor(agent, 'compaction')
```

It walks the composition subtree the agent itself mounted and returns the implementation that
subtree owns. `serviceFrom()` in `src/compaction.js`, `resolveHandles()` in `src/context.js`,
and the diagnosis all resolve this way.

## The trigger is not the ratio

```
thresholdTokens = min(contextWindow × thresholdRatio, contextWindow − reservedOutput − headroom)
```

Defaults: `thresholdRatio` 0.8, `headroomTokens` 65536.

| Case | Naive ratio | Real trigger |
| --- | --- | --- |
| 1M window, 384k output reserved, 0.8 | 800,000 | 550,464 |
| 1M window, nothing reserved, 0.8 | 800,000 | 800,000 |

`dsh_context` reports the resolved number, so nobody has to guess which case they are in.

## Tools

### `dsh_context`

Read-only. Answers: how full is it, where is the real trigger, and what would a given rule cost?

```
dsh_context({ sessionId })
dsh_context({ sessionId, includeNodes: true, previewChars: 80 })
dsh_context({ sessionId, range: { startSeq: 8, endSeq: 40 } })
```

Returns token occupancy, context window, resolved trigger, retention budget, compaction
history, and a dry-run plan naming the exact surface seq range a rule would shadow.

### `dsh_compact`

Compact now, under a rule passed per call.

```
dsh_compact({ sessionId, retainTokens: 20000, focus: "keep every unresolved bug" })
dsh_compact({ sessionId, range: { startSeq: 8, endSeq: 40 } })
dsh_compact({ sessionId, focus: "...", rule: "keep" })   // standing policy
```

- `range` beats retention.
- `focus` appends to the standard checkpoint sections; `instruction` replaces the directive.
- `rule: "keep"` also governs later **automatic** compactions of that session.
- `dryRun: true` plans without writing.
- Retention never splits a tool call from its result (pairing-balanced cuts).
- Sessions must be idle; `dryRun` still answers with `idle: false`.

### `dsh_services`

Diagnoses service resolution on both planes. Added because the compaction plane is easy to
misread as a missing deployment.

```
dsh_services({ sessionId })
```

## Implementation

| File | Role |
| --- | --- |
| `src/context.js` | token metering, real-trigger math, safe cut points, dry-run plan, two-plane diagnosis |
| `src/compaction.js` | `summarize()` hook, per-session rules, durable marker transaction, auto trigger |
| `src/tools.js` | the three schemas |
| `src/http.js` | MCP dispatch and argument validation |
| `src/api.js` | wiring to Host services |
| `src/settings.js` | `contextTools` switch (default `true`) |
| `test/context-compaction.test.mjs` | 19 tests |

`summarize()` is the compaction engine's documented sole subclass hook. The bridge assigns an
own property on each session-scoped engine that consults a per-session rule map; sessions
without a rule keep calling the prototype method, so stock behaviour is untouched.

The durable transaction writes the same marker sequence the engine itself writes
(`compaction/start` → `compaction/summary` → replacement `user/message` → `compaction/end`),
so `/compact`, the automatic listeners, and the compaction lock all keep working.

## Known limits

- **Live sessions only.** Reads come from the running session surface; a cold session answers
  `session is not live`. Dispatch one turn to warm it.
- **Idle sessions only** for real compaction.
- **`rule: "keep"` lives in process memory** and is lost on Host restart.

## Tests

```sh
node --test test/*.test.mjs
```

118 pass on this fork: 99 upstream + 19 for these tools.
