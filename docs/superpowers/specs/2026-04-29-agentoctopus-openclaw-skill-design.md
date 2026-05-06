# Design: AgentOctopus OpenClaw Skill (SKILL.md)

## Purpose

Create a `SKILL.md` that ships as the entry point when OpenClaw users run `clawhub install agentoctopus`. The skill teaches OpenClaw agents what AgentOctopus is (an intelligent skill router) and how to use its CLI commands.

## Scope

- Covers all `octopus` CLI commands an agent would use day-to-day
- Explains the routing pipeline conceptually so agents understand when to use it
- Node.js examples for programmatic usage
- No HTTP API reference — that lives in the existing docs

## Skill type

Reference skill — teaches OpenClaw agents how to use the AgentOctopus CLI.

## File location

`registry/skills/agentoctopus/SKILL.md`

Follows the existing ClawHub skill pattern. When published to ClawHub, `clawhub install agentoctopus` downloads this file into the user's skills directory.

## Frontmatter

```yaml
---
name: agentoctopus
description: Use when you need to route queries to specialized skills — AgentOctopus is an intelligent skill router that semantically matches queries to the highest-quality skills and falls back to direct LLM answers when no skill fits
---
```

## Section plan

### 1. Overview

What AgentOctopus is: a skill router. Give it natural language, it picks the best skill, executes it, returns the result. No matching skill → direct LLM answer. 3-stage pipeline: embedding index → cosine similarity + quality ratings → LLM re-rank.

### 2. Quick Start

```
octopus onboard              # one-time setup
octopus ask "your query"     # route a query
```

### 3. Core Commands

- `octopus ask <query>` — route a query; flags: `--debug`, `--no-prompt`
- `octopus list` — available skills with star ratings
- `octopus sync` — sync skills from ClawHub + ratings from GitHub Gist; key flags: `--check`, `--force`, `--dry-run`, `--category`, `--pull`, `--push`
- `octopus search <query>` — search local skills by name, description, and tags
- `octopus add <slug>` — install a skill; flags: `--version`, `--force`
- `octopus remove <name>` — remove an installed skill
- `octopus update` — check/install latest @agentoctopus packages; flags: `--check`, `-y`

### 4. Setup & Configuration

- `octopus onboard` — interactive wizard for LLM, skills, execution mode
- `octopus connect openclaw` — import existing OpenClaw LLM config
- `octopus config set <key> <value>` — write to ~/.agentoctopus/.env
- `octopus config list` — show resolved configuration
- `octopus start` — start gateway server (port 3002)

### 5. How Routing Works

3 stages: embedding → cosine similarity + keyword boost → LLM re-rank with "none" fallback. Retry: up to 3 candidates on failure. All fail → LLM direct answer. Credential missing → setup guide. Binary missing → install instructions.

### 6. Common Patterns

Initial setup flow, daily query flow, keeping skills fresh (`octopus sync`), adding new skills (`octopus search` → `octopus add`), programmatic usage with `@agentoctopus/gateway`.

### 7. Node.js Usage

```ts
import { createAgentRouter } from '@agentoctopus/gateway';
import express from 'express';
```
