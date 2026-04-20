# Rating System

Every skill is evaluated on 5 dimensions. The router uses a composite score to prefer high-performing skills and penalize failing ones.

## Dimensions

| Dimension | Range | Type | Source |
|---|---|---|---|
| `completion` | 0–1 | Objective | Auto-collected success/failure count |
| `quality` | 0–5 | Subjective | EMA of user thumbs-up/down feedback |
| `reliability` | 0–1 | Objective | 1 − (error rate from auto-collected metrics) |
| `latency` | 0–1 | Objective | Normalized response speed (1.0 at 0ms, decays to 0.0 at 2000ms) |
| `tokenCost` | 0–1 | Objective | Cost efficiency (1.0 at 0 tokens, decays to 0.0 at 500 tokens) |

## Task-type weights

The router computes a composite `routingScore` (0–1) as a weighted average. Weights adapt by task type:

| Task type | completion | quality | reliability | latency | tokenCost |
|---|---|---|---|---|---|
| `one-shot` | 0.30 | 0.25 | 0.20 | 0.15 | 0.10 |
| `long-running` | 0.25 | 0.20 | 0.30 | 0.10 | 0.15 |
| `agent-collab` | 0.20 | 0.30 | 0.25 | 0.10 | 0.15 |

- **one-shot** — completion and quality matter most
- **long-running** — reliability is weighted highest (crashes are costly)
- **agent-collab** — quality is weighted highest (output feeds other agents)

## Scoring formula

```
routingScore = w_completion × completion
             + w_quality × (quality / 5)
             + w_reliability × reliability
             + w_latency × latency
             + w_tokenCost × tokenCost
```

Quality is normalized from 0–5 to 0–1 before weighting.

## Feedback sources

- **CLI** — thumbs up/down after `octopus ask`
- **Web** — thumbs up/down in the chat UI
- **Agent platforms** — NLP keyword sentiment detection
- **Auto-collected** — success/failure counts, latency, token usage

Feedback uses exponential moving average (EMA) with weight 0.1 per event.

## Penalties

- **Negative feedback** — recent thumbs-down events apply a penalty to the routing score
- **Catch-all detection** — skills with overly broad descriptions (e.g., "use for any request") get a heavy penalty to prevent them from dominating routing

## Rating sync

Share ratings across instances using GitHub Gist:

```bash
octopus sync --setup-gist     # first-time setup
octopus sync --ratings --pull # pull from cloud
octopus sync --ratings --push # push to cloud
octopus sync --ratings        # bidirectional
```

See also: [Routing](routing.md) | [Skills](skills.md) | [Configuration](../getting-started/configuration.md)
