---
name: weather
description: Get current weather and forecasts
version: "1.2.0"
emoji: "🌤️"
os: [darwin, linux]
primaryEnv: OPENWEATHER_API_KEY
requires:
  bins: [curl]
  anyBins: [python3, python]
  env: [OPENWEATHER_API_KEY]
user-invocable: true
disable-model-invocation: false
---

# Weather Skill

Use `curl wttr.in/<city>` to get weather.
