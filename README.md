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

- `server/` — the matchmaking + WebRTC signaling server (Node.js, `ws`).
- `client/` — the board itself (Vite + vanilla TypeScript).

## Running locally

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

## Scripts

- `npm run dev` — run server + client together.
- `npm run build` — build both for production.
- `npm run typecheck` — typecheck both workspaces.
