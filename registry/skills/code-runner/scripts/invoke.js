const inputStr = process.env.OCTOPUS_INPUT || '{}';
const input = JSON.parse(inputStr);
const query = input.query || input.text || '';

console.log(JSON.stringify({
  success: true,
  query: query,
  result: `[Mock Code Execution] I would execute the code: ${query.slice(0, 50)}... and return the stdout here.`
}));
