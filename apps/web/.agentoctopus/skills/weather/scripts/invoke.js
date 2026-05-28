#!/usr/bin/env node
const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const query = input.query || '';

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

  const report = [
    `Weather in ${place}:`,
    `  Conditions : ${current.weatherDesc?.[0]?.value || ''}`,
    `  Temperature: ${current.temp_C}C / ${current.temp_F}F (feels like ${current.FeelsLikeC}C)`,
    `  Humidity   : ${current.humidity}%`,
    `  Wind       : ${current.windspeedKmph} km/h`,
  ].join('\n');

  console.log(JSON.stringify({ result: report }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
