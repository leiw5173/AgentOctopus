const inputStr = process.env.OCTOPUS_INPUT || '{}';
const input = JSON.parse(inputStr);
const query = input.query || input.text || '';

console.log(JSON.stringify({
  success: true,
  query: query,
  result: `[Mock Web Search Result for "${query}"] AgentOctopus is a zero-install intelligent routing layer for skills and MCPs.`
}));
