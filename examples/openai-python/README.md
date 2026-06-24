# OpenAI SDK + SteadIO

Route OpenAI Python SDK calls through SteadIO with two configuration changes.

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
python basic_completion.py
```

## What changes in your code

Before (direct OpenAI):
```python
from openai import OpenAI
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
```

After (routed through SteadIO):
```python
from openai import OpenAI
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url="http://localhost:3001/openai",
    default_headers={
        "X-SteadIO-Key": os.environ["STEADIO_KEY"],
        "X-Agent-Id": "my-agent",          # tag for cost attribution
    },
)
```

That's it. All `client.chat.completions.create()` calls work unchanged.

## Expected output

```
Sending request through SteadIO proxy...

Response: The capital of France is Paris.

Usage: 28 in / 12 out

Open http://localhost:5173 to see cost attribution for 'my-openai-agent'.
```

After running, open the dashboard (`http://localhost:5173`) and look for `my-openai-agent` in the agent list. You'll see:
- Token counts and USD cost for this request
- Cost trend over time
- Budget utilization if you've set a cap

## Setting a budget cap

```bash
curl -X POST http://localhost:3002/api/budgets \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "agent",
    "scopeId": "my-openai-agent",
    "period": "daily",
    "capUsd": 1.00,
    "enforcementMode": "kill"
  }'
```

When the agent hits $1, the proxy returns HTTP 402 and the OpenAI client raises `openai.BadRequestError`. The agent stops. You don't get the bill.

## Changing the agent ID

Set `X-Agent-Id` to any string to tag requests. Use different IDs per service, task type, or user so you can drill into costs in the dashboard.
