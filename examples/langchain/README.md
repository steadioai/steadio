# LangChain + SteadIO

Route LangChain's `ChatOpenAI` through SteadIO with two extra parameters.

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
python basic_chain.py
```

## What changes in your code

Before (direct OpenAI):
```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o-mini")
```

After (routed through SteadIO):
```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-4o-mini",
    openai_api_base="http://localhost:3001/openai",
    default_headers={
        "X-SteadIO-Key": os.environ["STEADIO_KEY"],
        "X-Agent-Id": "langchain-agent",
    },
)
```

Your chains, prompts, and output parsers are unchanged.

## Expected output

```
Running LangChain chain through SteadIO proxy...

Summary: Large language models (LLMs) are powerful neural networks that can
perform various language tasks, but their increasing use at scale raises
significant cost management challenges for AI product teams.

Open http://localhost:5173 to see cost attribution for 'langchain-agent'.
```

## Using with LCEL chains

The `default_headers` flow works with any LCEL expression:

```python
# Multi-step chain — all calls tagged to the same agent
chain = prompt | llm | parser
result = chain.invoke({"input": "..."})
```

Each LLM call in the chain is tracked separately in the SteadIO dashboard, so you can see cost per chain step.

## Using with agents and tools

```python
from langchain.agents import create_openai_functions_agent, AgentExecutor

agent = create_openai_functions_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools)
```

The `llm` already has SteadIO headers, so every tool call the agent makes is attributed to `langchain-agent` automatically.
