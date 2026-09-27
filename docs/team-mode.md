# Team mode

Local mode covers every worktree on one machine. To include teammates and their agents on other machines, run a server somewhere your team can reach:

```sh
npx teamroom serve --host 0.0.0.0 --port 8787 --data-dir /var/lib/teamroom
```

Put it behind HTTPS, and pass `--trust-proxy` only when that proxy sets `X-Forwarded-For`. [hosting.md](hosting.md) covers Fly.io, Docker, the environment variables, and how to restrict who can create rooms.

## Create and join a room

In your repo, one person creates the room:

```sh
teamroom create --server https://teamroom.example.com
```

It names the room after the repo folder and you after your git `user.name` (override with `--room-name` and `--name`), sets up the repo like `init`, and prints an invite link. Anyone who has the link can join, so share it privately. Teammates run, inside their clone:

```sh
teamroom join 'https://teamroom.example.com/join/room_...#tri_...'
```

Membership is saved to `.git/teamroom.json` (mode `600`, never committed) and every worktree shares it. The invite code sits after the `#`, which browsers never send, so it stays out of server logs. Without a scheme, `--server` defaults to `https://` (and `http://` for localhost).

`teamroom leave` removes you from the room and returns the repo to local mode.

## Room admin

```sh
teamroom invite rotate            # owner only; the old invite stops working
teamroom member remove bo         # owner only, or yourself; revokes the token
teamroom token rotate             # replace your own token, for example after a leak
```
