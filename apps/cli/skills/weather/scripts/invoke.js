#!/usr/bin/env node
// Weather skill — calls wttr.in (free, no API key)
const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const query = input.query || '';

// Extract location: strip common phrases like "weather in", "forecast for"
const location = query
  .replace(/\b(what('s| is) the |get |show |weather|forecast|temperature|conditions?|climate)\b/gi, '')
  .replace(/\b(in|for|at|of)\b/gi, '')
  .trim()
  .split(/\s+/)
  .join('+') || 'London';

async function main() {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'AgentOctopus/0.1' } });

  if (!res.ok) {
    console.error(`wttr.in error: ${res.status}`);
    process.exit(1);
  }

  const data = await res.json();
  const current = data.current_condition?.[0];
  const area = data.nearest_area?.[0];

  if (!current) {
    console.log(JSON.stringify({ result: 'No weather data found for that location.' }));
    return;
  }

  const place = [
    area?.areaName?.[0]?.value,
    area?.country?.[0]?.value,
  ].filter(Boolean).join(', ') || location;

  const tempC = current.temp_C;
  const tempF = current.temp_F;
  const desc = current.weatherDesc?.[0]?.value || '';
  const humidity = current.humidity;
  const windKmph = current.windspeedKmph;
  const feelsC = current.FeelsLikeC;

  const report = [
    `Weather in ${place}:`,
    `  Conditions : ${desc}`,
    `  Temperature: ${tempC}°C / ${tempF}°F (feels like ${feelsC}°C)`,
    `  Humidity   : ${humidity}%`,
    `  Wind       : ${windKmph} km/h`,
  ].join('\n');

  console.log(JSON.stringify({ result: report }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
