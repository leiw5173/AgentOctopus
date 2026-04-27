---
name: x-search
description: >
  Search X (Twitter) posts using the xAI Grok API with real-time access to X content.
tags: [x, twitter, social, search]
version: "1.0.0"
requires:
  bins: [curl, python3]
  env: [XAI_API_KEY]
---

## Instructions

Search X (Twitter) for posts matching the user's query using the xAI Grok API.
Parse the query, call the Grok live-search endpoint, and return a concise
plain-text summary of the top results including author handles and timestamps.
