---
name: weather
description: Get current weather and forecasts
version: "1.2.0"
os: [darwin]
primaryEnv: TOP_LEVEL_KEY
requires:
  bins: [curl]
user-invocable: true
openclaw:
  skillKey: weather-v2
  primaryEnv: OPENCLOUD_KEY
  os: [darwin, linux, windows]
  requires:
    bins: [curl, jq]
    env: [OPENWEATHER_API_KEY]
  install:
    - kind: brew
      formula: curl
---

# Weather Skill
