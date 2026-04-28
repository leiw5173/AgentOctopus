---
name: weather
description: >
  Get current weather conditions and forecast for any city or location.
  Use when the user asks about weather, temperature, rain, forecast,
  or conditions in a place — e.g. "What's the weather in Tokyo?".
tags: [weather, forecast, temperature, climate]
version: "1.0.0"
requires:
  bins: [curl]
---

## Instructions

Parse the location from the user's query and call wttr.in to get the current weather report.
Return a concise plain-text summary including temperature, conditions, humidity, and wind.
