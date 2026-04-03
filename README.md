# 🏘️ Copilot Town

**Multi-agent orchestration for GitHub Copilot CLI.**

Run a fleet of specialized Copilot agents that discover each other, relay messages, and collaborate on complex tasks — a town of AI specialists each doing what they do best.

![Copilot Town](https://img.shields.io/badge/copilot-plugin-blue)
![Version](https://img.shields.io/badge/version-0.2.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## Why

One Copilot session is powerful. A **team** of them is unstoppable.

- 🧠 **Specialized agents** — A docs expert, a test writer, a code reviewer — each with domain knowledge via `.agent.md` templates
- 🔄 **Inter-agent messaging** — Agents relay messages to each other through the hub, with auto-wake for stopped agents
- 🏗️ **Session-first model** — Every Copilot CLI session is an agent. Templates are optional roles. Zero config to start
- 📡 **MCP-powered** — 20 tools let any agent programmatically query, talk to, spawn, and manage others
- ⚡ **Headless agents** — Run Copilot sessions without a terminal pane via the SDK — interact through the web dashboard
- ⛓ **YAML workflows** — Define multi-agent pipelines (like GitHub Actions for AI agents) with DAG execution, review loops, gates, and conditional steps
- 🪟 **psmux orchestration** — Auto-provision terminal panes, manage windows, launch agents from the dashboard
- 🏷️ **Auto-titling** — psmux windows automatically show agent names

## Features

| Tab | What it does |
|-----|-------------|
| **Dashboard** `1` | Agent cards with live status, create/resume/stop agents, relay panel, inline chat for headless agents |
| **Live** `2` | Mission-control grid — monitor and interact with all headless agents simultaneously, with live streaming |
| **Panes** `3` | Terminal grid + full pane management — swap, zoom, break, rotate, move, resize, layout presets |
| **Sessions** `4` | Copilot session management — register sessions, conversation history with full-text search |
| **Graph** `5` | Force-directed graph of agent relay messages with frequency-weighted edges |
| **Workflows** `6` | YAML-defined multi-agent pipelines — create, edit, run, monitor, and delete workflows and stage files |
| **Settings** `7` | Hub config, agent display names, dark/light theme |

> Number keys `1`–`7` switch tabs. `Ctrl+K` opens the command palette.

## Quick Start

```powershell
# Install the plugin
copilot plugin install GittyHarsha/copilot-town
```

The server **auto-starts** when Copilot loads the plugin — no manual setup needed.

To start the server manually (no Copilot session required):
```powershell
# After first Copilot session, a launcher is created automatically:
~\.copilot\copilot-town.cmd start    # start | stop | status | open

# Or run the script directly from the plugin directory:
# (path depends on how the plugin was installed)
copilot plugin list   # confirm copilot-town is installed
```

> **Tip:** The plugin ships `scripts/copilot-town.ps1` which handles start/stop/status/open.
> Add an alias to your PowerShell profile for convenience:
> ```powershell
> # Find your plugin path first, then:
> Set-Alias copilot-town "<plugin-path>/scripts/copilot-town.ps1"
> ```

From any Copilot session, use natural language — the MCP tools are invoked automatically:
- `"open copilot town"` → opens dashboard
- `"show agent status"` → lists all agents
- `"relay a message to X"` → sends message to another agent
- `"spawn a new agent called researcher"` → creates agent in new pane

## How It Works

```
┌──────────┐    relay     ┌──────────┐    relay     ┌──────────┐
│  docs    │ ──────────→  │   hub    │ ──────────→  │  test    │
│  expert  │ ←──────────  │ (router) │ ←──────────  │  writer  │
└──────────┘              └──────────┘              └──────────┘
     ↑                         ↑                         ↑
     └─────────────── Copilot Town Hub ──────────────────┘
                        (auto-discovery)
```

1. **Agents launch** in psmux panes (manually, or auto-provisioned from the dashboard)
2. **Auto-discovery** — the hub scans all psmux panes for Copilot CLI indicators, detecting status in real time
3. **Relay messaging** — agents send messages through the hub via HTTP API or MCP tools. If the target is stopped, it's auto-woken first
4. **Observe & orchestrate** — the dashboard shows live status, or use MCP tools programmatically

### Agent Lifecycle

| Status | How it's detected |
|--------|------------------|
| **running** | Copilot is executing — tool confirmation dialogs, working indicators visible in pane |
| **idle** | Copilot is at the prompt waiting for input (`Type @ to mention`, `shift+tab` visible) |
| **stopped** | No lock file, no pane, or explicitly stopped via API |

Detection uses a multi-strategy approach: lock files (`inuse.<PID>.lock`), pane output analysis, and session map tracking — with an 8-second cache to keep it fast.

## MCP Tools

Every Copilot session with the plugin installed gets these 20 tools automatically:

| Tool | Description |
|------|-------------|
| `copilot_town_open` | Open the dashboard in your browser |
| `copilot_town_status` | Get status of all agents |
| `copilot_town_relay` | Send a message between agents (auto-wakes stopped targets) |
| `copilot_town_list_templates` | List available `.agent.md` templates |
| `copilot_town_register` | Register current session as a named agent (auto-detects pane via PID) |
| `copilot_town_whoami` | Get your own agent identity — name, session ID, pane, status |
| `copilot_town_get_agent` | Get details of a specific agent by name or ID |
| `copilot_town_set_status` | Set your current task/status text (visible to other agents and dashboard) |
| `copilot_town_broadcast` | Send a message to ALL other agents at once |
| `copilot_town_read_output` | Read the last N lines of another agent's terminal output |
| `copilot_town_set_meta` | Update your agent metadata — description, model, flags, template |
| `copilot_town_spawn` | Spawn a new agent in a new terminal pane |
| `copilot_town_stop_agent` | Stop another agent by name or ID |
| `copilot_town_promote` | Promote an agent to headless mode (runs via SDK, no terminal) |
| `copilot_town_demote` | Demote a headless agent back to pane mode |
| `copilot_town_set_model` | Change an agent's model at runtime |
| `copilot_town_set_mode` | Switch session mode (e.g., plan mode) |
| `copilot_town_share_note` | Share a key-value note with the team (any agent can read it) |
| `copilot_town_get_notes` | Read shared notes from the team |
| `copilot_town_wake` | Wake a stopped agent and optionally send a message |

## Pane Management

The **Panes** tab provides full terminal multiplexer control from the browser:

**Per-pane actions:**
`↑↓` Swap · `⤢` Zoom · `⊡` Break to window · `⟳` Rotate · `↗` Move · `⇔` Resize

**Per-window:**
Split horizontal/vertical · 5 layout presets (tiled, stacked, side-by-side, main-h, main-v)

**Per-session:**
Create · Rename · Kill · Add windows

## Headless Agents

Headless agents run Copilot sessions via the SDK — no terminal pane required. Interact entirely through the web dashboard.

- **Create** from Dashboard → `+ New` → choose headless mode
- **Chat** via the inline chat panel (Dashboard) or the **Live Grid** (mission control for all headless agents)
- **Promote/demote** — move pane agents to headless and back with MCP tools
- **SDK controls** — enqueue prompts (`Ctrl+Q`), steer mid-turn (just hit Enter), abort, compact context
- **Auto-revive** — stopped headless agents are automatically revived when you open their chat or click ⚡ Wake Agent
- **Streaming** — real-time token streaming with auto-scroll that follows output while you're at the bottom, pauses when you scroll up
- **Thinking indicators** — elapsed timer shows how long the agent has been thinking, with a slow-response warning after 30 seconds
- **Message attribution** — relay messages from other agents show `↗ from agent-name`; dashboard messages display cleanly without labels

### Agent Collaboration

Headless agents get **5 collaboration tools** via a built-in MCP server (`mcp-collab.ts`) that launches automatically per session:

| Tool | Description |
|------|-------------|
| `get_agents` | List all agents with status, type, model, and current task |
| `relay_message` | Send a message to another agent and get their response |
| `share_note` | Post a key-value note for the entire team to read |
| `read_notes` | Read shared team notes |
| `set_status` | Update your status on the dashboard |

Each headless agent also receives a **team-aware system prompt** with a live roster of all agents, shared notes summary, and collaboration guidelines. Agents use tools directly — no scripts, no workarounds.

The **Live Grid** (`2`) shows all headless agents in a configurable grid (1–4 columns), with per-cell chat, status indicators, wake button for stopped agents, and expand-to-full-panel.

## Workflows

Define multi-agent pipelines in YAML — like GitHub Actions, but for AI agents.

```yaml
name: Research Report
description: Deep research on any topic
icon: 📚
inputs:
  topic:
    description: What to research
    required: true
steps:
  - id: research
    prompt: "Research this topic thoroughly: ${{ inputs.topic }}"
  - id: critique
    needs: [research]
    prompt: |
      Critically analyze this research:
      ${{ steps.research.output }}
  - id: synthesize
    needs: [research, critique]
    prompt: |
      Create a polished report combining:
      ${{ steps.research.output }}
      Addressing: ${{ steps.critique.output }}
```

**Key capabilities:**
- **DAG execution** — steps run in parallel when dependencies allow
- **Review loops** — `review:` sends output back for iterative improvement
- **Gate steps** — `type: gate` pauses for human approval in the UI
- **Conditional steps** — `if: steps.triage.output contains 'critical'`
- **Shared sessions** — `session:` lets multiple steps share the same agent context
- **Stage files** — `prompt_file:` references reusable `.md` prompt templates in `data/stages/`
- **Retry & fallback** — `retry:`, `on_fail:`, `continue_on_fail:`
- **Structured output** — `outputs: json` parses agent output as JSON for downstream interpolation

See [`data/workflows/WORKFLOW_REFERENCE.md`](data/workflows/WORKFLOW_REFERENCE.md) for the full YAML specification.

## Install

```powershell
copilot plugin install GittyHarsha/copilot-town
```

Or from source:
```powershell
git clone https://github.com/GittyHarsha/copilot-town.git
cd copilot-town
npm install
cd client && npm install && npx vite build
```

## Requirements

- [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
- Node.js 18+
- [**psmux**](https://github.com/psmux/psmux) — terminal multiplexer for pane management and agent discovery

```powershell
winget install marlocarlo.psmux
```

Without psmux, the dashboard and relay messaging still work, but pane management, terminal grid, and auto-discovery of running agents are disabled.

## Configuration

Set via the Settings page or environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_TOWN_PORT` | `3848` | Server port |
| `COPILOT_TOWN_PROJECT_DIR` | cwd | Project root (for `.github/agents/`) |
| `COPILOT_TOWN_USER_AGENTS_DIR` | `~/.copilot/agents` | User agent templates |

## Architecture

```
copilot-town/
├── plugin.json              # Copilot CLI plugin manifest
├── .mcp.json                # MCP server config → runs ensure-server.cjs
├── hooks.json               # sessionStart/sessionEnd lifecycle hooks
├── scripts/
│   ├── ensure-server.cjs    # MCP bridge (20 tools) + silent server auto-launcher
│   ├── session-hook.cjs     # Auto-registers sessions + creates global launcher
│   └── copilot-town.ps1     # CLI wrapper for start/stop/open/status
├── server/
│   ├── index.ts             # Express + 3 WebSocket servers (status, terminal, headless)
│   ├── mcp-collab.ts        # MCP stdio server for headless agent collaboration tools
│   ├── routes/              # REST API (agents, psmux, relays, sessions, workflows, …)
│   └── services/
│       ├── agents.ts        # Discovery engine, status detection, lifecycle
│       ├── headless.ts      # SDK-based headless agent management
│       ├── workflows.ts     # YAML workflow engine with DAG execution
│       ├── psmux.ts         # Cross-platform mux abstraction (40+ operations)
│       └── copilot-sdk.ts   # Copilot CLI SDK client wrapper
├── client/
│   ├── src/                 # React + Vite + Tailwind (dark/light theme)
│   └── dist/                # Pre-built (zero build step for users)
└── data/
    ├── workflows/           # YAML workflow definitions
    └── stages/              # Reusable .md prompt templates
```

**Key design decisions:**
- **Session-first identity** — `agent.id` = Copilot session UUID. Templates are optional roles, not identities
- **Silent server** — `ensure-server.cjs` spawns the server with `detached: false` on Windows (no console flash) and responds to MCP `initialize` immediately (no blocking)
- **Auto-wake relay** — when relaying to a stopped agent, the hub auto-resumes it in a new pane, polls for copilot prompt readiness, then delivers the message
- **MCP collaboration** — headless agents get team tools via a per-session stdio MCP server (`mcp-collab.ts`), not SDK `registerTools()` (which only stores local handlers). This ensures tools persist across session revives
- **PID-based pane detection** — on register, the MCP bridge sends `process.ppid` and the server walks the process tree to match against pane PIDs (cross-platform: Win32_Process on Windows, `ps -o ppid` on Unix)
- **Auto-titling** — psmux windows are automatically renamed to match agent names on spawn, resume, and periodic sync
- **Pane layout tracking** — `psmux_layout` in `agent-sessions.json` maps pane targets to agent names, surviving pane renumbering
- **Lock file detection** — checks `inuse.<PID>.lock` files with `process.kill(pid, 0)` for reliable stopped-state detection

## API

The server exposes a REST API at `http://localhost:3848/api/`:

| Endpoint | Description |
|----------|-------------|
| `GET /agents` | List all agents with status |
| `GET /agents/:id` | Agent details |
| `PUT /agents/:id` | Update agent metadata (name, description, model, flags) |
| `GET /agents/:id/output` | Capture pane output |
| `POST /agents/relay` | Relay message between agents (auto-wakes stopped targets) |
| `POST /agents/register` | Register a session as an agent (with PID-based pane detection) |
| `POST /agents/:id/stop` | Stop agent |
| `POST /agents/:id/resume` | Resume agent (auto-provisions pane) |
| `POST /agents/:id/start` | Start from template |
| `POST /agents/:id/task` | Set agent task/status text |
| `POST /agents/broadcast` | Send message to all agents |
| `POST /agents/spawn` | Spawn a new agent in a new pane |
| `GET /agents/templates` | List `.agent.md` templates |
| `GET /notes` | Read shared notes |
| `POST /notes` | Share a note (key-value) |
| `GET /conversations` | List sessions (supports `?q=` FTS) |
| `GET /conversations/:id` | Conversation turns |
| `GET /workflows` | List workflow definitions |
| `GET /workflows/:id` | Get workflow with raw YAML |
| `POST /workflows` | Create/update workflow from YAML |
| `DELETE /workflows/:id` | Delete a workflow |
| `POST /workflows/:id/run` | Execute a workflow with inputs |
| `GET /workflows/runs/list` | List workflow runs |
| `DELETE /workflows/runs/:id` | Cancel a running workflow |
| `GET /workflows/stages/list` | List stage prompt files |
| `POST /workflows/stages` | Create/update a stage file |
| `DELETE /workflows/stages/:name` | Delete a stage file |
| `GET /psmux/sessions` | List psmux sessions |
| `GET /psmux/panes` | List all panes |
| `POST /psmux/panes/:target/*` | Pane operations (split, swap, zoom, break, join, resize, rotate) |
| `GET /relays` | Relay message log |
| `GET /events` | Recent events |
| `GET/PUT /config` | Hub configuration |

WebSocket endpoints:
- `/ws/status` — live agent status updates
- `/ws/terminal?target=<pane>` — live terminal output streams
- `/ws/headless?agent=<name>` — headless agent chat with streaming (send prompts, receive token-by-token output)

## License

MIT
