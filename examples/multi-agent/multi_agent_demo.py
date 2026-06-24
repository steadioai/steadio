#!/usr/bin/env python3
"""
Multi-agent pipeline with per-agent cost attribution via SteadIO.

Each agent uses a different X-Agent-Id header. The SteadIO dashboard shows
cost broken out per agent, so you can see exactly where your money goes.

Pipeline: researcher → writer → reviewer
"""

import os
from openai import OpenAI

STEADIO_KEY = os.environ.get("STEADIO_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
STEADIO_PROXY = os.environ.get("STEADIO_PROXY", "http://localhost:3001/openai")

if not STEADIO_KEY:
    raise SystemExit("Set STEADIO_KEY to your SteadIO API key (from `make demo` output)")
if not OPENAI_API_KEY:
    raise SystemExit("Set OPENAI_API_KEY to your OpenAI API key")


def make_agent_client(agent_id: str) -> OpenAI:
    """Create an OpenAI client tagged to a specific agent."""
    return OpenAI(
        api_key=OPENAI_API_KEY,
        base_url=STEADIO_PROXY,
        default_headers={
            "X-SteadIO-Key": STEADIO_KEY,
            "X-Agent-Id": agent_id,          # per-agent attribution key
        },
    )


def call(client: OpenAI, system: str, user: str, model: str = "gpt-4o-mini") -> tuple[str, int, int]:
    """Call the LLM and return (text, input_tokens, output_tokens)."""
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    text = resp.choices[0].message.content
    return text, resp.usage.prompt_tokens, resp.usage.completion_tokens


# Each agent gets its own client — different X-Agent-Id per agent
researcher = make_agent_client("researcher-agent")
writer = make_agent_client("writer-agent")
reviewer = make_agent_client("reviewer-agent")

topic = "the impact of LLM cost management on AI startup viability"

print(f"Running multi-agent pipeline on: '{topic}'")
print("-" * 60)

# Stage 1: researcher gathers key points
print("\n[researcher-agent] Gathering key points...")
research, r_in, r_out = call(
    researcher,
    system="You are a research assistant. Extract 3-5 key facts on the given topic.",
    user=f"Topic: {topic}",
)
print(f"Research complete. ({r_in} in / {r_out} out tokens)")

# Stage 2: writer drafts a paragraph from the research
print("\n[writer-agent] Drafting paragraph...")
draft, w_in, w_out = call(
    writer,
    system="You are a technical writer. Write a single clear paragraph from the provided research notes.",
    user=f"Research notes:\n{research}",
)
print(f"Draft complete. ({w_in} in / {w_out} out tokens)")

# Stage 3: reviewer critiques and improves the draft
print("\n[reviewer-agent] Reviewing and improving draft...")
final, rv_in, rv_out = call(
    reviewer,
    system=(
        "You are an editor. Review the draft for clarity and conciseness. "
        "Return the improved version only, no commentary."
    ),
    user=f"Draft:\n{draft}",
)
print(f"Review complete. ({rv_in} in / {rv_out} out tokens)")

# Summary
total_in = r_in + w_in + rv_in
total_out = r_out + w_out + rv_out

print("\n" + "=" * 60)
print("FINAL OUTPUT")
print("=" * 60)
print(final)

print("\n" + "=" * 60)
print("PIPELINE COST SUMMARY")
print("=" * 60)
print(f"  researcher-agent:  {r_in:>5} in / {r_out:>4} out tokens")
print(f"  writer-agent:      {w_in:>5} in / {w_out:>4} out tokens")
print(f"  reviewer-agent:    {rv_in:>5} in / {rv_out:>4} out tokens")
print(f"  ─────────────────────────────────────────")
print(f"  Total:             {total_in:>5} in / {total_out:>4} out tokens")
print()
print("Open http://localhost:5173 to see per-agent cost breakdown in the dashboard.")
print("Each agent appears as a separate row with its own spend and token counts.")
