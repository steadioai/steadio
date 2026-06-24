#!/usr/bin/env python3
"""
LangChain + SteadIO: pass base_url and extra headers to ChatOpenAI.

LangChain wraps the OpenAI client, so you can inject SteadIO through the
same openai_api_base / default_headers mechanism.
"""

import os
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

STEADIO_KEY = os.environ.get("STEADIO_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
STEADIO_PROXY = os.environ.get("STEADIO_PROXY", "http://localhost:3001/openai")

if not STEADIO_KEY:
    raise SystemExit("Set STEADIO_KEY to your SteadIO API key (from `make demo` output)")
if not OPENAI_API_KEY:
    raise SystemExit("Set OPENAI_API_KEY to your OpenAI API key")

# Route through SteadIO by setting openai_api_base and default_headers.
# Everything else is standard LangChain.
llm = ChatOpenAI(
    model="gpt-4o-mini",
    openai_api_key=OPENAI_API_KEY,
    openai_api_base=STEADIO_PROXY,
    default_headers={
        "X-SteadIO-Key": STEADIO_KEY,
        "X-Agent-Id": "langchain-agent",
    },
)

prompt = ChatPromptTemplate.from_messages([
    ("system", "You are an expert at summarizing text in one sentence."),
    ("user", "Summarize this: {text}"),
])

chain = prompt | llm | StrOutputParser()

print("Running LangChain chain through SteadIO proxy...")

result = chain.invoke({
    "text": (
        "Large language models (LLMs) are neural networks trained on vast amounts of text. "
        "They can generate coherent text, answer questions, write code, and perform many "
        "other language tasks. The cost of running LLMs at scale is a significant concern "
        "for organizations building AI-powered products."
    )
})

print(f"\nSummary: {result}")
print("\nOpen http://localhost:5173 to see cost attribution for 'langchain-agent'.")
