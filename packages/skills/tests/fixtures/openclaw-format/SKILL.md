---
name: weather
description: Get current weather and forecasts
version: "1.2.0"
openclaw:
  skillKey: weather-v2
  primaryEnv: OPENWEATHER_API_KEY
  os: [darwin, linux]
  requires:
    bins: [curl]
    env: [OPENWEATHER_API_KEY]
  install:
    - kind: brew
      formula: curl
---

# Weather Skill

Use `curl wttr.in/<city>` to get weather.
