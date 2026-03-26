# @agentoctopus/registry

Skill manifest loader and rating store for AgentOctopus.

## Install

```bash
npm install @agentoctopus/registry
```

## Usage

### Load skills from a directory

Skills are defined as `SKILL.md` files with YAML frontmatter. Point the registry at a folder:

```ts
import { SkillRegistry } from '@agentoctopus/registry';

const registry = new SkillRegistry('./registry/skills');
await registry.load();

const skills = registry.getAll();
console.log(skills.map(s => s.manifest.name));
// ['weather', 'translation', 'ip-lookup']
```

### Skill manifest format

Each skill lives in its own folder with a `SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does and when to use it.
tags: [tag1, tag2]
version: 1.0.0
endpoint: https://api.example.com/invoke
adapter: http
---

## Instructions

Detailed instructions for the LLM on how/when to invoke this skill.
```

Supported adapters: `http`, `mcp`, `subprocess`.

### Rating store

Persist and retrieve skill ratings (used by the router to prefer higher-rated skills):

```ts
import { RatingStore } from '@agentoctopus/registry';

const store = new RatingStore('./registry/ratings.json');

store.record('my-skill', true);   // positive feedback
store.record('my-skill', false);  // negative feedback

const entry = store.get('my-skill');
// { rating: 3.5, invocations: 10 }
```

### Remote catalog

Fetch skills from a remote catalog URL:

```ts
import { fetchRemoteCatalog } from '@agentoctopus/registry';

const skills = await fetchRemoteCatalog('https://example.com/catalog.json');
```

## License

Apache 2.0
