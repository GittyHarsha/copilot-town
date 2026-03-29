# 🏘️ Copilot Town

**Multi-agent orchestration for GitHub Copilot CLI.**

Run a fleet of specialized Copilot agents that discover each other, relay messages, and collaborate on complex tasks — a town of AI specialists each doing what they do best.

![Copilot Town](https://img.shields.io/badge/copilot-plugin-blue)
![Version](https://img.shields.io/badge/version-0.1.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## Why

One Copilot session is powerful. A **team** of them is unstoppable.

- 🧠 **Specialized agents** — A docs expert, a test writer, a code reviewer — each with domain knowledge via `.agent.md` templates
- 🔄 **Inter-agent messaging** — Agents relay messages to each other through the hub, with auto-wake for stopped agents
- 🏗️ **Session-first model** — Every Copilot CLI session is an agent. Templates are optional roles. Zero config to start
- 📡 **MCP-powered** — 16 tools let any agent programmatically query, talk to, spawn, and manage others
- 🪟 **psmux orchestration** — Auto-provision terminal panes, manage windows, launch agents from the dashboard
- 🏷️ **Auto-titling** — psmux windows automatically show agent names

## Features

| Tab | What it does |
|-----|-------------|
| **Dashboard** `1` | Agent cards with live status (running/idle/stopped), create/resume/stop agents, relay panel, conversation history |
| **Town** `2` | Animated ring visualization of your agent network with relay connections |
| **Panes** `3` | Terminal grid + full pane management — swap, zoom, break, rotate, move, resize, layout presets |
| **Chat** `4` | Browse and search conversation history across all agents (full-text search) |
| **Sessions** `5` | Copilot session lifecycle — register sessions as named agents, view orphaned sessions |
| **Graph** `6` | Force-directed graph of agent relay messages with frequency-weighted edges |
| **Settings** `7` | Hub config, agent display names, dark/light theme |

> Number keys `1`–`7` switch tabs. `Ctrl+K` opens the command palette.

## Quick Start

```powershell
# Install the plugin
copilot plugin install GittyHarsha/copilot-town
```

The server **auto-starts** when Copilot loads the plugin — no manual setup needed.

To start the server manually (no Copilot session required), run the script from the plugin's `scripts/` directory:
```powershell
# Windows (PowerShell)
& "~/.copilot/installed-plugins/_direct/GittyHarsha--copilot-town/scripts/copilot-town.ps1" start

# All commands: start | stop | status | open
```

> **Tip:** Add an alias to your PowerShell profile for convenience:
> ```powershell
> Set-Alias copilot-town "~/.copilot/installed-plugins/_direct/GittyHarsha--copilot-town/scripts/copilot-town.ps1"
> # Then just: copilot-town start
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

Every Copilot session with the plugin installed gets these 16 tools automatically:

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
│   ├── ensure-server.cjs    # MCP bridge (16 tools) + silent server auto-launcher
│   ├── session-hook.cjs     # Auto-registers sessions + creates global launcher
│   └── copilot-town.ps1     # CLI wrapper for start/stop/open/status
├── server/
│   ├── index.ts             # Express + dual WebSocket (status + terminal)
│   ├── routes/              # REST API (agents, psmux, relays, sessions, config, …)
│   └── services/
│       ├── agents.ts        # Discovery engine, status detection, lifecycle
│       └── psmux.ts         # Cross-platform mux abstraction (40+ operations)
├── client/
│   ├── src/                 # React + Vite + Tailwind
│   └── dist/                # Pre-built (zero build step for users)
└── data/                    # Runtime state (gitignored)
```

**Key design decisions:**
- **Session-first identity** — `agent.id` = Copilot session UUID. Templates are optional roles, not identities
- **Silent server** — `ensure-server.cjs` spawns the server with `detached: false` on Windows (no console flash) and responds to MCP `initialize` immediately (no blocking)
- **Auto-wake relay** — when relaying to a stopped agent, the hub auto-resumes it in a new pane, polls for copilot prompt readiness, then delivers the message
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
| `GET /psmux/sessions` | List psmux sessions |
| `GET /psmux/panes` | List all panes |
| `POST /psmux/panes/:target/*` | Pane operations (split, swap, zoom, break, join, resize, rotate) |
| `GET /relays` | Relay message log |
| `GET /events` | Recent events |
| `GET/PUT /config` | Hub configuration |

WebSocket endpoints: `/ws` (status updates), `/ws/terminal` (live terminal streams).

## License

MIT
