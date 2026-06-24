# Multi-agent pipeline with per-agent cost attribution

The core SteadIO differentiator: when you run multiple agents, you can see exactly which agent is spending what.

This example runs a three-agent pipeline (researcher → writer → reviewer) and shows each agent's cost separately in the dashboard.

## Prerequisites

- SteadIO running locally (`make demo` in repo root)
- Python 3.9+
- An OpenAI API key

## Setup

```bash
# 1. Start SteadIO (from repo root)
make demo
# Copy the API key printed at the end — looks like el_demo_abc123...

# 2. Install dependencies
pip install -r requirements.txt

# 3. Set env vars
export STEADIO_KEY=el_demo_abc123...   # key from make demo
export OPENAI_API_KEY=sk-...           # your OpenAI key

# 4. Run
python multi_agent_demo.py
```

## How per-agent attribution works

Each agent gets its own OpenAI client with a different `X-Agent-Id` header:

```python
def make_agent_client(agent_id: str) -> OpenAI:
    return OpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        base_url="http://localhost:3001/openai",
        default_headers={
            "X-SteadIO-Key": os.environ["STEADIO_KEY"],
            "X-Agent-Id": agent_id,        # different per agent
        },
    )

researcher = make_agent_client("researcher-agent")
writer     = make_agent_client("writer-agent")
reviewer   = make_agent_client("reviewer-agent")
```

Every call each agent makes is attributed to that agent's ID. The dashboard shows cost broken out per agent, so you can answer: "Who is spending the most?"

## Expected output

```
Running multi-agent pipeline on: 'the impact of LLM cost management on AI startup viability'
------------------------------------------------------------

[researcher-agent] Gathering key points...
Research complete. (87 in / 143 out tokens)

[writer-agent] Drafting paragraph...
Draft complete. (178 in / 98 out tokens)

[reviewer-agent] Reviewing and improving draft...
Review complete. (134 in / 87 out tokens)

============================================================
FINAL OUTPUT
============================================================
Effective LLM cost management has become a critical factor in AI startup
viability, as unchecked model spending can quickly erode margins and
destabilize unit economics...

============================================================
PIPELINE COST SUMMARY
============================================================
  researcher-agent:    87 in /  143 out tokens
  writer-agent:       178 in /   98 out tokens
  reviewer-agent:     134 in /   87 out tokens
  ─────────────────────────────────────────
  Total:              399 in /  328 out tokens

Open http://localhost:5173 to see per-agent cost breakdown in the dashboard.
Each agent appears as a separate row with its own spend and token counts.
```

## What you'll see in the dashboard

After running, open `http://localhost:5173`. You'll see three new agents:

| Agent | Spend | Model |
|---|---|---|
| researcher-agent | ~$0.00008 | gpt-4o-mini |
| writer-agent | ~$0.00007 | gpt-4o-mini |
| reviewer-agent | ~$0.00006 | gpt-4o-mini |

As your pipeline runs more, you'll see cost trend lines per agent. If one agent starts spiking (e.g., researcher is being called in a loop), you'll see it immediately.

## Setting per-agent budget caps

You can cap each agent independently:

```bash
# Researcher can spend up to $2/day
curl -X POST http://localhost:3002/api/budgets \
  -H "Content-Type: application/json" \
  -d '{"scope": "agent", "scopeId": "researcher-agent", "period": "daily", "capUsd": 2.00, "enforcementMode": "kill"}'

# Writer capped at $1/day
curl -X POST http://localhost:3002/api/budgets \
  -H "Content-Type: application/json" \
  -d '{"scope": "agent", "scopeId": "writer-agent", "period": "daily", "capUsd": 1.00, "enforcementMode": "kill"}'
```

When an agent hits its cap, the proxy returns HTTP 402 for that agent only. Other agents in the pipeline continue to run unless they also hit their caps.

## Extending to more agents

This pattern scales to any number of agents. Use descriptive IDs that reflect your actual architecture:

```python
# Examples for a real product
ingestion   = make_agent_client("ingestion-agent")
classifier  = make_agent_client("classifier-agent")
summarizer  = make_agent_client("summarizer-agent")
embedder    = make_agent_client("embedder-agent")
responder   = make_agent_client("responder-agent")
```

The dashboard groups by agent ID, so consistent naming across your codebase gives you a complete cost picture.
