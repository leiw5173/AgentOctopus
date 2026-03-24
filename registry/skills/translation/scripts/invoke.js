const inputStr = process.env.OCTOPUS_INPUT || '{}';
const input = JSON.parse(inputStr);

// A simple mock translation script for MVP
const query = input.query || input.text || '';
const lower = query.toLowerCase();

let result = 'Bonjour' + (query.length > 10 ? ' (Mock Translation)' : '');
if (lower.includes('spanish') || lower.includes('español')) {
  result = 'Hola' + (query.length > 10 ? ' (Mock Translation)' : '');
} else if (lower.includes('german')) {
  result = 'Hallo' + (query.length > 10 ? ' (Mock Translation)' : '');
} else if (lower.includes('japanese')) {
  result = 'Konnichiwa' + (query.length > 10 ? ' (Mock Translation)' : '');
}

console.log(JSON.stringify({
  success: true,
  result: result,
  original_query: query
}));
