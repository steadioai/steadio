# Elevation Networks — Documentation

These docs cover everything you need to get up and running.

## Guides

| Document | Description |
|---|---|
| [Quick Start](./quick-start.md) | Docker setup, first request in 10 minutes |
| [Integration Guide](./integration-guide.md) | Point Python, Node.js, or curl clients at the proxy |
| [Feature Walkthrough](./feature-walkthrough.md) | Cost attribution, budgets, alerts, runaway detection |
| [FAQ & Troubleshooting](./faq.md) | Common issues, auth, streaming, supported models |

## Architecture Overview

```
Your LLM Client
    │  base_url → http://localhost:3001/openai
    │  X-Elevation-Key, X-Agent-Id headers
    ▼
Elevation Proxy (3001)
    │  Auth check → Budget check → Forward to provider
    │  Fire-and-forget cost event
    ▼
Cost Engine (3002)
    │  Calculate cost → Budget enforce → Runaway detect
    │  Store in PostgreSQL + Redis
    ▼
Dashboard (5173)
    │  Cost by agent/team, budgets, runaway history
```

## Key Endpoints

| Service | Endpoint | Purpose |
|---|---|---|
| Proxy | `http://localhost:3001/openai/*` | OpenAI-compatible proxy |
| Proxy | `http://localhost:3001/anthropic/*` | Anthropic proxy |
| Proxy | `http://localhost:3001/google/*` | Google Gemini proxy |
| Cost Engine | `http://localhost:3002/api/budgets` | Budget CRUD |
| Cost Engine | `http://localhost:3002/api/runaways` | Runaway event history |
| Dashboard | `http://localhost:5173` | Web UI |
