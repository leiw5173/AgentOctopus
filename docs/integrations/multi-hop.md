# Multi-hop Planner

For complex queries that involve multiple skills, the Planner decomposes the request into sub-tasks, runs them in parallel (or sequentially if there are dependencies), and synthesizes a single answer.

## Usage

```ts
import { Planner, Router, Executor, SkillRegistry, createChatClient, createEmbedClient } from 'agentoctopus';

// ... set up registry, router, executor as usual ...

const planner = new Planner(chatClient, router, executor);
const result = await planner.run(
  'translate hello to French and check the weather in Paris',
  registry.getAll(),
);

console.log(result.finalAnswer);
// → "Bonjour! The weather in Paris is 22°C and sunny."

console.log(result.plan.isMultiHop);     // true
console.log(result.stepResults.length);  // 2
result.stepResults.forEach(s => {
  console.log(`${s.skill || 'LLM'}: ${s.output} (confidence: ${s.confidence})`);
});
```

## How it works

1. The LLM decomposes the query into sub-tasks
2. Steps without dependencies run in parallel
3. Steps that depend on a prior step's output wait and receive context automatically
4. Results are synthesized into a single answer

See also: [Routing](../core-concepts/routing.md) | [Skills](../core-concepts/skills.md)
