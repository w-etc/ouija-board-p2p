# Ouija Board P2P

A two-player ouija board — one player is the **medium**, one is the
**ghost** — built to demonstrate a P2P matchmaking architecture: a small,
cheap-to-run server only pairs players up and helps their browsers
negotiate a direct WebRTC connection. After that handshake, all gameplay
traffic (the planchette moving around the board) flows directly between
the two browsers. The server never sees it.

See [`CLAUDE.md`](./CLAUDE.md) for the full project context, architecture
decisions, and roadmap — that's the file to read before picking this back
up in a new session.

## Project layout

- `server/` — the matchmaking + WebRTC signaling server (Go, `gorilla/websocket`).
- `client/` — the board itself (Vite + vanilla TypeScript).

## Running locally

Requires Go 1.22+ and Node 20+.

```sh
npm install
npm run dev
```

This runs the matchmaking server on `ws://localhost:8080` and the client
dev server (Vite) together. Open the printed client URL in two separate
browser tabs/windows, pick a role in each ("medium" / "ghost" / "either"),
and once matched you should see "Connected directly to your partner" —
that's the point where the WebSocket server steps out of the picture.

To point the client at a different matchmaking server (e.g. a deployed
one), copy `client/.env.example` to `client/.env.local` and set
`VITE_MATCHMAKING_URL`.

**Use Chrome/Chromium, not Firefox.** Firefox's WebRTC ICE handshake
reliably fails here — even between two tabs on the same machine — almost
certainly due to its mDNS host-candidate obfuscation. See "Known issues /
gotchas" in `CLAUDE.md` for the full diagnosis.

## Scripts

- `npm run dev` — run server + client together.
- `npm run build` — build both for production.
- `npm run typecheck` — typecheck both workspaces.

## Deploying

Both pieces deploy for free, no credit card required.

**Client → GitHub Pages.** `.github/workflows/deploy-pages.yml` builds and
deploys the client automatically on every push to
`claude/p2p-ouija-matchmaking-olrj29`. One-time manual step: in this repo's
Settings → Pages, set "Build and deployment" → Source to **GitHub
Actions** (can't be done via API, has to be clicked once). After that the
site is live at `https://w-etc.github.io/ouija-board-p2p/`.

**Server → Render.** `render.yaml` at the repo root is a Render Blueprint
that deploys `server/` as-is (it already reads `PORT` from the
environment, which is Render's convention). Steps:

1. Sign up at [render.com](https://render.com) — free, no card, "Continue
   with GitHub" works.
2. New → Blueprint, select this repo, click Apply.
3. Once it's live, copy the service's `https://...onrender.com` URL and
   turn it into a `wss://...onrender.com` URL.
4. Set that as a repository variable named `VITE_MATCHMAKING_URL` (repo
   Settings → Secrets and variables → Actions → Variables tab), then
   re-run the Pages workflow (or push again) so the client picks it up —
   Vite bakes this in at build time, it's not read at runtime.

The free Render plan spins down after 15 minutes idle and takes about a
minute to wake back up on the next connection — fine for development, but
warm it up with a request a few minutes before a live demo.
