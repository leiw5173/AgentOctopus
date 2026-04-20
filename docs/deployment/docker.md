# Docker

## Cloud deployment

Gateway + web UI:

```bash
docker compose --profile cloud up --build
# → Gateway on http://localhost:3002, Web UI on http://localhost:3000
```

## Local deployment

Gateway only, syncs skills from cloud:

```bash
CLOUD_URL=https://your-cloud-instance:3002 docker compose --profile local up --build
# → Gateway on http://localhost:3002
```

## Custom Dockerfile

```dockerfile
FROM node:18-alpine
RUN npm install -g @agentoctopus/gateway
EXPOSE 3002
CMD ["agentoctopus-gateway"]
```

```bash
docker build -t agentoctopus-gateway .
docker run -p 3002:3002 --env-file .env agentoctopus-gateway
```

## Other process managers

### PM2

```bash
npm install -g @agentoctopus/gateway pm2
pm2 start agentoctopus-gateway --name agentoctopus
pm2 save
pm2 startup
```

### systemd

```ini
[Unit]
Description=AgentOctopus Gateway
After=network.target

[Service]
Type=simple
User=agentoctopus
WorkingDirectory=/opt/agentoctopus
EnvironmentFile=/opt/agentoctopus/.env
ExecStart=/usr/bin/agentoctopus-gateway
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

See also: [Cloud & Local Modes](cloud-local.md) | [Security](security.md) | [Configuration](../getting-started/configuration.md)
