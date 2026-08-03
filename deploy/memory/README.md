# Memmy Memory Docker deployment

This directory is the standalone runtime configuration. It uses the locally
built `memmy-memory:local` image and does not need the source tree as its
Compose build context.

Build or update the image from the source repository:

```bash
docker build -f /root/memmy-agent/Memory/Dockerfile -t memmy-memory:local /root/memmy-agent
```

Start and inspect the service from the deployment directory:

```bash
docker compose up -d
docker compose ps
docker compose logs -f memory
```

`docker compose down` preserves the named data and model-cache volumes. Do not
add `-v` unless permanent deletion of those volumes is intentional.

Windows users can double-click the numbered BAT files in order:

```text
00-configure-desktop.bat  Create the initial desktop remote-Memory config
01-start-memory.bat       Start the service
02-status-memory.bat      Show container and HTTP health
03-logs-memory.bat        Follow service logs
04-restart-memory.bat     Restart the container
05-stop-memory.bat        Stop without deleting volumes
06-update-memory.bat      Rebuild from WSL source and recreate the container
```

For day-to-day operation, double-click `Memmy-Memory-Menu.bat` and choose an
action from the unified menu. The numbered scripts remain available for direct
execution and automation.
