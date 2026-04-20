# What is AgentOctopus?

AgentOctopus is an intelligent routing layer that connects natural-language requests to the best available skill. Users express their intent in plain language, and AgentOctopus automatically selects, invokes, and returns results from the most appropriate skill — no manual tool selection required.

## The problem it solves

AI agents and assistants need to call tools and APIs, but hard-coding every integration is fragile and doesn't scale. AgentOctopus provides a single entry point where:

- **Users** say what they want in plain language
- **AgentOctopus** figures out which skill handles it best
- **Skills** execute and return results

If no skill matches, the query falls back to a direct LLM answer — so nothing is lost.

## How it's different

| Approach | AgentOctopus |
|---|---|
| Hard-coded tool calls | Intent-based routing — add skills without changing caller code |
| Single LLM for everything | Specialized skills with rating-aware selection |
| Manual tool selection | Automatic: embedding similarity + LLM re-rank + rating scores |
| No quality feedback | 5-dimension rating system with auto-collected metrics |

See also: [Key Features](key-features.md) | [How It Works](how-it-works.md) | [Quick Start](../getting-started/quick-start.md)
