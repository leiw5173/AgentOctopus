---
name: web-search
description: >
  Searches the web for current information, news, or answers to questions
  that require up-to-date knowledge not found in the base model.
tags: [search, web, research, news]
version: 1.0.0
adapter: subprocess
hosting: local
input_schema:
  query: string
output_schema:
  results: array
auth: none
rating: 4.8
invocations: 0
---

## Instructions

Extract the search query from `OCTOPUS_INPUT` and return search results.
