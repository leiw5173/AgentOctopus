#!/usr/bin/env node
// Translation skill — calls MyMemory free API (no key required, 5000 chars/day)
const input = JSON.parse(process.env.OCTOPUS_INPUT || '{}');
const query = input.query || '';

// Language code map (common names → ISO 639-1)
const LANG_CODES = {
  french: 'fr', spanish: 'es', german: 'de', italian: 'it', portuguese: 'pt',
  japanese: 'ja', chinese: 'zh', korean: 'ko', arabic: 'ar', russian: 'ru',
  dutch: 'nl', polish: 'pl', turkish: 'tr', hindi: 'hi', thai: 'th',
  vietnamese: 'vi', greek: 'el', czech: 'cs', swedish: 'sv', danish: 'da',
  finnish: 'fi', norwegian: 'no', hebrew: 'he', indonesian: 'id', malay: 'ms',
  romanian: 'ro', hungarian: 'hu', ukrainian: 'uk',
};

function detectTargetLang(q) {
  const lower = q.toLowerCase();
  for (const [name, code] of Object.entries(LANG_CODES)) {
    if (lower.includes(name)) return { code, name };
  }
  const m = lower.match(/\bto\s+([a-z]{2})\b/);
  if (m) return { code: m[1], name: m[1] };
  return { code: 'fr', name: 'French' };
}

function extractText(q) {
  return q
    .replace(/translate\s+(to\s+\w+\s+)?["']?/gi, '')
    .replace(/\b(to|in|into)\s+(french|spanish|german|italian|portuguese|japanese|chinese|korean|arabic|russian|dutch|polish|turkish|hindi|thai|vietnamese|greek|czech|swedish|danish|finnish|norwegian|hebrew|indonesian|malay|romanian|hungarian|ukrainian|[a-z]{2})\b/gi, '')
    .replace(/["']/g, '')
    .trim();
}

async function main() {
  const { code: langCode, name: langName } = detectTargetLang(query);
  const text = extractText(query) || query;

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${langCode}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'AgentOctopus/0.1' } });

  if (!res.ok) {
    console.error(`MyMemory error: ${res.status}`);
    process.exit(1);
  }

  const data = await res.json();
  const translated = data.responseData?.translatedText;

  if (!translated) {
    console.log(JSON.stringify({ result: 'Translation failed — no result returned.' }));
    return;
  }

  const langLabel = langName.charAt(0).toUpperCase() + langName.slice(1);
  console.log(JSON.stringify({
    result: `"${text}" in ${langLabel}: ${translated}`,
  }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
