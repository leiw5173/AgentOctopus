#!/usr/bin/env node
// IP Lookup skill — calls ip-api.com (free, no key, 45 req/min)
const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const query = input.query || '';

function extractTarget(q) {
  // Match an IPv4, IPv6, or domain
  const ipv4 = q.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  if (ipv4) return ipv4[1];
  const domain = q.match(/\b([a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z]{2,})+)\b/);
  if (domain) return domain[1];
  return null;
}

async function main() {
  const target = extractTarget(query);

  if (!target) {
    console.log(JSON.stringify({
      result: 'Please provide an IP address (e.g. 8.8.8.8) or domain name (e.g. github.com) to look up.',
    }));
    return;
  }
  const url = `http://ip-api.com/json/${encodeURIComponent(target)}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`;

  const res = await fetch(url, { headers: { 'User-Agent': 'AgentOctopus/0.1' } });

  if (!res.ok) {
    console.error(`ip-api error: ${res.status}`);
    process.exit(1);
  }

  const d = await res.json();

  if (d.status === 'fail') {
    console.log(JSON.stringify({ result: `Lookup failed: ${d.message}` }));
    return;
  }

  const report = [
    `IP / Host  : ${d.query}`,
    `Location   : ${d.city}, ${d.regionName}, ${d.country}`,
    `Coordinates: ${d.lat}, ${d.lon}`,
    `Timezone   : ${d.timezone}`,
    `ISP        : ${d.isp}`,
    `Org        : ${d.org}`,
    `AS         : ${d.as}`,
  ].join('\n');

  console.log(JSON.stringify({ result: report }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
