# Hosting a teamroom server

You only need a server for team mode. Parallel agents on one machine coordinate through `.git/teamroom/` with no server at all (`teamroom init`).

In team mode, everyone runs the `teamroom` CLI and their agents on their own machine. Only the room server is shared. It is one small Node process that stores rooms as JSON files.

## What the server needs

- **A persistent disk.** Rooms live in `TEAMROOM_DATA_DIR`. Serverless platforms (Vercel, Netlify Functions, Cloudflare Workers) wipe the filesystem between requests, so they do not work.
- **One instance.** Rate limits are in memory and writes are locked per disk. One small machine serves many teams.
- **HTTPS.** Member tokens travel in the `Authorization` header.

## Configuration

`teamroom serve` reads these environment variables. Flags win when both are set.

| Variable | Flag | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | `--port` | `8787` | Port to listen on |
| `HOST` | `--host` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` in a container. |
| `TEAMROOM_DATA_DIR` | `--data-dir` | `.teamroom-data` | Where room files live |
| `TEAMROOM_TRUST_PROXY` | `--trust-proxy` | `false` | Take the client IP from `X-Forwarded-For` (the entry your proxy appended). Enable only behind a proxy you control. |
| `TEAMROOM_CREATE_KEY` | | unset | When set, creating a room requires this key. Joining with an invite link never does. At least 16 characters. |

On a public server, set `TEAMROOM_CREATE_KEY` so strangers cannot create rooms on your disk. People who create rooms pass it with `teamroom create --create-key <key>` or the same environment variable.

## Fly.io

The repo ships a `Dockerfile` and `fly.toml`. From the repo root:

```sh
fly auth login
fly launch --copy-config --no-deploy --name <your-app-name>
fly volumes create teamroom_data --size 1 --region cdg
fly secrets set TEAMROOM_CREATE_KEY="$(openssl rand -base64 24)"
fly deploy --ha=false
```

- `--ha=false` keeps it to one machine. A volume attaches to one machine, and a second one would see different rooms.
- Idle machines stop and wake on the next request. The first hook after a quiet spell waits about a second; hooks run in the background, so nobody notices. Set `min_machines_running = 1` in `fly.toml` to keep it warm.
- Your server is then `https://<your-app-name>.fly.dev`. Check it with `curl https://<your-app-name>.fly.dev/health`.

Back up the volume with `fly volumes snapshots list`. Fly takes daily snapshots by default.

## Docker anywhere else

```sh
docker build -t teamroom .
docker run -d -p 8787:8787 -v teamroom-data:/data -e TEAMROOM_CREATE_KEY=... teamroom
```

Put a reverse proxy with HTTPS in front (Caddy does it in two lines), and set `TEAMROOM_TRUST_PROXY=true`.

## What the server stores

File paths, branch names, commit ids, short notes, and member names. Never file contents. Tokens and invite codes are stored as SHA-256 hashes. If people outside your team use your server, tell them this.
