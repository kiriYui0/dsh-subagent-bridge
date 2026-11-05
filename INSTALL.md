# dsh-subagent-bridge (fork)

`kiriYui0/dsh-subagent-bridge` — fork of
[Dogtiti/dsh-subagent-bridge](https://github.com/Dogtiti/dsh-subagent-bridge) at 0.21.0,
plus three context tools and a rule-driven compactor.

[`CONTEXT-TOOLS.md`](CONTEXT-TOOLS.md) — what the addition does and why compaction lives on a
different service plane.

## Install on another machine

The profile owns its plugin list; add the git dependency and the bundle row.

```sh
# 1. add the dependency
cd ~/.dsh/profiles/desktop          # or ~/.dsh/profiles/web
pnpm add "git+https://github.com/kiriYui0/dsh-subagent-bridge.git"

# 2. make sure the bundle is listed in package.json → dsh.profile.bundles
#    (append "dsh-subagent-bridge" if it is not already there)

# 3. restart DeepSeek Harness
```

Verify the endpoint answers with 13 tools:

```sh
cat ~/.dsh/bridge/endpoint.json          # take url + token
curl -s -X POST "<url>" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

### Point Codex at it

```toml
# ~/.codex/config.toml
[mcp_servers.dsh-bridge]
url = "http://127.0.0.1:47821/mcp/<token>"
```

`~/.dsh/bridge/endpoint.json` holds the exact URL, including the token.

### Claude Code

```sh
claude mcp add --transport http dsh-bridge "<the url above>" --scope user
```

## Updating this fork from upstream

```sh
git remote add upstream https://github.com/Dogtiti/dsh-subagent-bridge.git
git fetch upstream && git merge upstream/main
```

The addition touches `index.js`, `src/api.js`, `src/http.js`, `src/settings.js`,
`src/tools.js`, two new modules, and one test file — a small surface, so merges stay cheap.
When upstream changes the tool list or `api.js` method order, expect to resolve those two
spots by hand.

## Tests

```sh
node --test test/*.test.mjs
```

118 pass: 99 upstream, 19 for the context tools.

## Differences from upstream

| Area | Upstream | Here |
| --- | --- | --- |
| Tools | 10 | 13 (`dsh_context`, `dsh_services`, `dsh_compact`) |
| Context inspection | none | token occupancy, real trigger, dry-run plan |
| Compaction control | fixed ratio, fixed summary shape | per-call span + per-call summary directive, optional standing rule |
| Version | 0.21.0 | 0.22.0 |
