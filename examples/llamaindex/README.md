# LlamaIndex + SteadIO

Route LlamaIndex LLM calls through SteadIO by passing a pre-built OpenAI client.

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
python basic_query.py
```

## What changes in your code

Before (direct OpenAI):
```python
from llama_index.llms.openai import OpenAI

llm = OpenAI(model="gpt-4o-mini")
```

After (routed through SteadIO):
```python
import openai
from llama_index.llms.openai import OpenAI

# Build a custom client with SteadIO routing
openai_client = openai.OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url="http://localhost:3001/openai",
    default_headers={
        "X-SteadIO-Key": os.environ["STEADIO_KEY"],
        "X-Agent-Id": "llamaindex-agent",
    },
)

# Pass the client to LlamaIndex
llm = OpenAI(model="gpt-4o-mini", openai_client=openai_client)
```

## Expected output

```
Querying through SteadIO proxy via LlamaIndex...

Response: A vector database is a specialized database that stores data as
high-dimensional vectors, enabling fast similarity search. It's used in AI
applications to efficiently retrieve semantically similar content, such as
documents or images, based on meaning rather than exact keyword matches.

Usage: 42 in / 58 out

Open http://localhost:5173 to see cost attribution for 'llamaindex-agent'.
```

## Using with index and query engine

The same custom client works with the full LlamaIndex pipeline:

```python
from llama_index.core import VectorStoreIndex, SimpleDirectoryReader
from llama_index.core import Settings

Settings.llm = llm  # set globally

documents = SimpleDirectoryReader("./data").load_data()
index = VectorStoreIndex.from_documents(documents)
query_engine = index.as_query_engine()

# Every LLM call during indexing and querying is attributed to 'llamaindex-agent'
response = query_engine.query("What is this document about?")
```

## Using with async

LlamaIndex also accepts `openai.AsyncOpenAI` for async workflows:

```python
import openai

async_client = openai.AsyncOpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url="http://localhost:3001/openai",
    default_headers={
        "X-SteadIO-Key": os.environ["STEADIO_KEY"],
        "X-Agent-Id": "llamaindex-agent-async",
    },
)

llm = OpenAI(model="gpt-4o-mini", openai_client=async_client)
```
