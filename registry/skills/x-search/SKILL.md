---
name: x-search
description: >
  Search X (Twitter) posts using the xAI Grok API with real-time access to X content.
tags: [x, twitter, social, search]
version: 1.0.0
adapter: subprocess
hosting: local
input_schema:
  query: string
output_schema:
  report: string
auth: api_key
rating: 3.0
metadata: { "openclaw": { "emoji": "🐦", "env": ["XAI_API_KEY"], "primaryEnv": "XAI_API_KEY", "homepage": "https://console.x.ai" } }
invocations: 0
credentials:
  - key: XAI_API_KEY
    label: "xAI API Key (get one at console.x.ai)"
    required: true
---

## Instructions

Search X (Twitter) for posts matching the user's query using the xAI Grok API.
Parse the query, call the Grok live-search endpoint, and return a concise
plain-text summary of the top results including author handles and timestamps.
