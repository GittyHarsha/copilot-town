# 🏘️ Copilot Town

**Multi-agent orchestration for GitHub Copilot CLI.**

Run a fleet of specialized Copilot agents that talk to each other, relay messages, share context, and collaborate on complex tasks — like a town of AI specialists each doing what they do best.

![Copilot Town](https://img.shields.io/badge/copilot-plugin-blue)
![Version](https://img.shields.io/badge/version-0.1.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## Why

One Copilot session is powerful. A **team** of them is unstoppable.

- 🧠 **Specialized agents** — A docs expert, a test writer, a code reviewer — each with deep domain knowledge in their `.agent.md` template
- 🔄 **Inter-agent messaging** — Agents relay messages to each other. Ask one agent a question and it routes to the right specialist
- 🏗️ **Session-first model** — Every Copilot CLI session is an agent. Templates are optional roles. No config needed to get started
- 📡 **MCP-powered** — The hub exposes tools (`copilot_town_status`, `copilot_town_relay`) so any agent can programmatically query and talk to others
- 🪟 **psmux orchestration** — Auto-provision terminal panes, manage windows, launch agents with one click

## Features

- 🔄 **Agent Relay** — Route messages between agents, build multi-agent workflows
- 📊 **Live Dashboard** — See all agents at a glance with real-time status
- 🏘️ **Town View** — Animated visualization of your agent network and relay connections
- ▦ **Terminal Grid** — View all agent panes in a single window
- 🚀 **Launch** — Spin up new sessions with template/model/flag picker
- 💬 **Chat** — Send messages to any agent from the UI
- ⏱ **Sessions** — Browse conversation history across all agents
- ⚙ **Settings** — Rename agents, configure the town

## Quick Start

```bash
# Install the plugin
copilot plugin install harshanp_microsoft/copilot-town

# The server auto-starts. Open the dashboard:
open http://localhost:3848

# Or from any copilot session, use the MCP tool:
# "open copilot town" → triggers copilot_town_open
```

## How It Works

1. **You launch agents** in psmux panes (or let Copilot Town auto-provision them)
2. **Agents discover each other** — the hub scans panes for Copilot CLI indicators
3. **Agents communicate** — via relay messages, routed through the hub
4. **You observe and orchestrate** — from the dashboard, or programmatically via MCP tools

```
┌──────────┐    relay     ┌──────────┐    relay     ┌──────────┐
│  docs    │ ──────────→  │ registry │ ──────────→  │  test    │
│  expert  │ ←──────────  │  (router)│ ←──────────  │  writer  │
└──────────┘              └──────────┘              └──────────┘
     ↑                         ↑                         ↑
     └─────────────── Copilot Town Hub ──────────────────┘
                        (auto-discovery)
```

## Install

```bash
copilot plugin install harshanp_microsoft/copilot-town
```

Or from source:
```bash
git clone https://github.com/harshanp_microsoft/copilot-town.git
cd copilot-town
npm install
cd client && npm install && npx vite build
```

## Requirements

- [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
- Node.js 18+
- **psmux** (recommended) — terminal multiplexer for agent panes, discovery, and orchestration

### Installing a terminal multiplexer

```powershell
# Windows
winget install marlocarlo.psmux

# macOS
brew install tmux

# Linux (usually pre-installed)
sudo apt install tmux   # Debian/Ubuntu
```

> **Note on psmux:** [psmux](https://github.com/psmux/psmux) is a third-party open-source terminal multiplexer for Windows. If you prefer not to install pre-built binaries via winget, you can clone the repo and build from source to use as a pinned, auditable runtime. On Mac/Linux, tmux is the well-established standard and ships with most distributions.

Copilot Town auto-detects whichever is available (`psmux` on Windows, `tmux` on Mac/Linux). Without either, the dashboard and relay messaging still work, but pane management, terminal grid, and auto-discovery of running agents are disabled.

## Configuration

Set via Settings page or environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_TOWN_PORT` | `3848` | Server port |
| `COPILOT_TOWN_PROJECT_DIR` | cwd | Project root (for .github/agents/) |
| `COPILOT_TOWN_USER_AGENTS_DIR` | `~/.copilot/agents` | User agent templates |

## Architecture

- **Discovery**: Scans psmux panes for Copilot CLI indicators — zero config
- **Identity**: Session ID (UUID) = agent. Templates (`.agent.md`) = optional roles
- **Relay**: HTTP API + WebSocket for real-time agent-to-agent messaging
- **MCP bridge**: Exposes hub as MCP tools so agents can query each other programmatically
- **Hooks**: `sessionStart`/`sessionEnd` auto-register agents

## Plugin Structure

```
copilot-town/
├── plugin.json          # Copilot CLI plugin manifest
├── .mcp.json            # Auto-starts server as MCP server
├── hooks.json           # Session lifecycle hooks
├── scripts/             # Hook + server launcher scripts
├── server/              # Express + WebSocket backend
├── client/              # React frontend
│   └── dist/            # Pre-built (zero build step)
└── data/                # Runtime (gitignored)
```

## License

MIT
