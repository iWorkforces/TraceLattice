# TraceLattice

[![npm version](https://img.shields.io/npm/v/tracelattice?color=blue&label=npm)](https://www.npmjs.com/package/tracelattice)

An MCP server that gives AI agents structured sequential thinking with tool and skill recommendations. Thoughts live in a DAG, reasoning strategies are pluggable, and confidence scores can be calibrated against recorded outcomes.

## Features

- 11 thought types: regular, hypothesis, verification, critique, synthesis, meta, tool_call, tool_observation, assumption, decomposition, backtrack
- DAG-based thought graph with 8 edge kinds (sequence, branch, merge, verifies, critiques, derives_from, tool_invocation, revises) and topological traversal
- Pluggable reasoning strategies. Sequential by default, or Tree-of-Thought with BFS/beam search and plateau detection
- Tool interleave: suspend a thinking chain, run a tool call, then resume where you left off
- Confidence calibration using Beta(2,2) priors, Brier score, and Expected Calibration Error (ECE)
- Branch compression: cold branches get rolled into summaries automatically, with a sliding-window dehydration policy
- Outcome recording for tool_call/tool_observation results with metadata
- Tool and skill recommendations with confidence scores, rationales, and automatic discovery
- Per-session isolation with TTL eviction and LRU caching
- CLI transports: stdio (default), SSE (legacy), and Streamable HTTP (production). A stateless HTTP JSON-RPC transport is also available as a library transport
- Strict TypeScript, Valibot validation, 2100 passing tests, 18-service DI container

## Install

Requires [Node.js](https://nodejs.org/) v22+ for development and build tooling. The packaged CLI is built with a Bun shebang, so install [Bun](https://bun.sh/) when running the `tracelattice` binary directly.

```bash
npm install -g tracelattice
```

## Configure your MCP client

The default transport is stdio. Add the server to your client:

### Claude Code

User-scoped (`~/.claude.json`) or project-scoped (`.mcp.json` in project root):

```json
{
  "mcpServers": {
    "tracelattice": {
      "command": "tracelattice"
    }
  }
}
```

Or via CLI:

```bash
claude mcp add tracelattice -- tracelattice
```

### Codex CLI

User-scoped (`~/.codex/config.toml`) or project-scoped (`.codex/config.toml`):

```toml
[mcp_servers.tracelattice]
command = "tracelattice"
```

Or via CLI:

```bash
codex mcp add tracelattice -- tracelattice
```

### Grok Build

Add TraceLattice as a local MCP server:

```bash
grok mcp add tracelattice -- tracelattice
```

For a project-scoped MCP configuration, add `--scope project`:

```bash
grok mcp add --scope project tracelattice -- tracelattice
```

### OpenCode

Global (`~/.config/opencode/opencode.json`) or project-scoped (`.opencode.json`):

```json
{
  "mcpServers": {
    "tracelattice": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "tracelattice"
      ],
      "enabled": true,
      "environment": {
        "MAX_HISTORY_SIZE": "10000",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

## Configuration

### Server

Set `LOG_LEVEL` in the process environment to `debug`, `info`, `warn`, or `error`:

```bash
LOG_LEVEL=debug tracelattice
```

Environment variables override values from configuration files.

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_HISTORY_SIZE` | `10000` | Maximum thoughts to keep in history |
| `MAX_BRANCHES` | `50` | Maximum number of branches |
| `MAX_BRANCH_SIZE` | `100` | Maximum size of each branch |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `PRETTY_LOG` | `true` | Enable pretty log output |
| `SESSION_MAX_PER_OWNER` | `50` | Maximum isolated sessions per owner |
| `TRACELATTICE_TOOL_INTERLEAVE_TTL_MS` | `60000` | Suspended tool-call token TTL in ms |
| `TRACELATTICE_TOOL_INTERLEAVE_SWEEP_MS` | `60000` | Expired suspension cleanup interval in ms |

### Config files

Configuration files are loaded from the first matching path in this order: a custom path passed to `ConfigLoader`, `.claude/config.json`, `.claude/config.yaml`, `.claude/config.yml`, then the same filenames under `~/.claude/`. Environment variables override file values.

```yaml
maxHistorySize: 10000
maxBranches: 50
maxBranchSize: 100
skillDirs:
  - .claude/skills
  - ~/.claude/skills
discoveryCache:
  ttl: 300000
  maxSize: 100
persistence:
  enabled: false
  backend: memory # memory, file, or sqlite
  options:
    dataDir: ./.tracelattice
    dbPath: ./.tracelattice/history.db
features:
  dagEdges: true
  reasoningStrategy: sequential # sequential or tot
  calibration: true
  compression: true
  toolInterleave: true
  newThoughtTypes: true
  outcomeRecording: true
toolInterleaveTtlMs: 60000
toolInterleaveSweepMs: 60000
maxSessionsPerOwner: 50
```

### Feature flags

All feature flags default to enabled in `ServerConfig`. Set a boolean flag to `false` or `0` to opt out, or to `true` or `1` to opt back in.

| Variable | Description |
|----------|-------------|
| `TRACELATTICE_FEATURES_DAG_EDGES` | Enable DAG edges for thought relationships |
| `TRACELATTICE_FEATURES_CALIBRATION` | Enable confidence calibration with Beta(2,2) priors |
| `TRACELATTICE_FEATURES_COMPRESSION` | Enable branch compression for cold branches |
| `TRACELATTICE_FEATURES_TOOL_INTERLEAVE` | Enable suspend/resume for tool calls |
| `TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES` | Enable tool_call, tool_observation, assumption, decomposition, backtrack |
| `TRACELATTICE_FEATURES_OUTCOME_RECORDING` | Enable outcome recording for tool results |
| `TRACELATTICE_FEATURES_REASONING_STRATEGY` | Strategy: `sequential` (default) or `tot` |

### Transport

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSPORT_TYPE` | `stdio` | Transport: `stdio`, `sse`, or `streamable-http` |
| `STREAMABLE_HTTP_PORT` | `3000` | Port for Streamable HTTP server |
| `STREAMABLE_HTTP_HOST` | `localhost` | Host for Streamable HTTP server |
| `STREAMABLE_HTTP_STATEFUL` | `true` | Enable stateful session tracking |
| `SSE_PORT` | `3000` | Port for SSE server |
| `SSE_HOST` | `localhost` | Host for SSE server |
| `SSE_ENABLE_POOL` | `true` | Enable connection pool for session isolation |
| `SSE_MAX_SESSIONS` | `100` | Maximum concurrent SSE sessions |
| `SSE_SESSION_TIMEOUT` | `300000` | SSE session timeout (ms) |
| `CORS_ORIGIN` | `*` | CORS origin |
| `ENABLE_CORS` | `true` | Enable CORS preflight |
| `ALLOWED_HOSTS` | derived from bound host | Comma-separated allowed `Host` header values |

### Skill discovery

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILL_DIRS` | `.claude/skills:<home>/.claude/skills` | Colon-separated skill directories |
| `DISCOVERY_CACHE_TTL` | `300` | Discovery cache TTL in seconds when set through env; stored internally as ms |
| `DISCOVERY_CACHE_MAX_SIZE` | `100` | Discovery cache max entries |

## Transports

Set `TRANSPORT_TYPE` to pick one:

| Transport | When to use | Command |
|-----------|-------------|---------|
| `stdio` (default) | Local MCP clients | `tracelattice` |
| `sse` (legacy) | Multi-user setups, backwards compatibility | `TRANSPORT_TYPE=sse tracelattice` |
| `streamable-http` | Production deployments | `TRANSPORT_TYPE=streamable-http tracelattice` |

The Streamable HTTP endpoint defaults to `POST /mcp` for JSON-RPC requests and supports stateful sessions via the `Mcp-Session-Id` header. The SSE transport defaults to `GET /sse` and `POST /sse/message`. The library also exposes `HttpTransport` for stateless JSON-RPC over HTTP, but the CLI does not select it with `TRANSPORT_TYPE`.

## Development

```bash
npm install
npm run dev              # MCP inspector (bunx @modelcontextprotocol/inspector dist/cli.js)
npm test                 # vitest run
npm run test:watch       # vitest watch
npm run test:coverage    # vitest run --coverage
npm run type-check       # tsc --noEmit
npm run lint             # eslint src/
npm run lint:fix         # eslint src/ --fix
npm run format           # prettier --write
npm run format:check     # prettier --check
npm run build            # rslib build + rsbuild build + postbuild-cli.mjs
npm run build:lib        # rslib build only
npm run build:cli        # rsbuild build + postbuild-cli.mjs
npm start                # bun dist/cli.js
```

## Architecture

```
src/
├── core/               # Domain logic
│   ├── graph/          # DAG edges: Edge, EdgeStore, GraphView
│   ├── evaluator/      # SignalComputer, Aggregator, PatternDetector, Calibrator
│   ├── compression/    # CompressionService, DehydrationPolicy, InMemorySummaryStore
│   ├── reasoning/      # OutcomeRecorder + strategies (Sequential, TreeOfThought, StrategyFactory)
│   └── tools/          # InMemorySuspensionStore (suspend/resume)
├── contracts/          # Shared interfaces and branded ID types (cross-module coupling point)
├── persistence/        # File, SQLite, Memory backends (with saveEdges/loadEdges)
├── transport/          # SSE, Streamable HTTP, HTTP JSON-RPC
├── di/                 # IoC container (18 services) + ServiceRegistry
├── registry/           # Tool/Skill discovery with frontmatter parsing and LRU cache
├── config/             # YAML + env var loading
├── cache/              # LRU+TTL discovery cache
├── logger/             # Structured logging (JSON/pretty)
├── pool/               # Multi-user session pool
├── metrics/            # Prometheus metrics
├── health/             # Aggregate health checking
├── watchers/           # File-system watchers for tool/skill discovery
├── context/            # Request context via AsyncLocalStorage
└── types/              # Shared type definitions
```

## License

MIT
