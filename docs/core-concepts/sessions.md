# Sessions

AgentOctopus maintains per-user conversation sessions so follow-up queries can reference earlier context.

## Session model

- **Key**: `platform + channelId + userId`
- **TTL**: 30 minutes after last activity
- **History**: last 50 messages per session
- **Cleanup**: expired sessions are removed automatically

## Usage

Sessions are managed automatically. When a query includes a `sessionId`, the router continues that conversation. Without a session ID, a new session is created.

### CLI

```bash
octopus ask "what's the weather in Tokyo"
# → Returns response with sessionId

octopus ask "how about London" --session <sessionId>
# → Follow-up in same session
```

### API

```bash
# First query — creates session
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "what is the weather in Paris"}'
# → {"sessionId": "abc-123", ...}

# Follow-up in same session
curl -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "how about London", "sessionId": "abc-123"}'
```

## IM bot sessions

Slack, Discord, and Telegram bots maintain sessions per user/channel automatically. No session ID management needed — the bot infers the session from the message context.

See also: [Routing](routing.md) | [REST API](../api-reference/rest-api.md) | [IM Bots](../integrations/im-bots.md)
