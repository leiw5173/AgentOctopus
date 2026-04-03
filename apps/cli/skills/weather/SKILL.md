---
name: weather
description: >
  Get current weather conditions and forecast for any city or location.
  Use when the user asks about weather, temperature, rain, forecast,
  or conditions in a place — e.g. "What's the weather in Tokyo?".
tags: [weather, forecast, temperature, climate]
version: 1.0.0
adapter: subprocess
hosting: local
input_schema:
  query: string
output_schema:
  report: string
auth: none
rating: 4.8
invocations: 0
---

## Instructions

Parse the location from the user's query and call wttr.in to get the current weather report.
Return a concise plain-text summary including temperature, conditions, humidity, and wind.
