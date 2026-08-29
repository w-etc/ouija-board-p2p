# Ouija Board P2P — Project Memory

This file is the persistent memory for this project. Read it at the start of
every session before doing anything else. Keep it updated as decisions are
made — it's the thing that lets us pick this up across many sessions without
re-deriving context.

## The point of the project

This is talk-prep material for a presentation at the user's old job. The
talk's thesis: **P2P matchmaking servers let you build multiplayer/social
apps that connect strangers together without paying for a beefy always-on
relay server.** The matchmaking server's job is small and cheap — pair two
people up and help them find each other — after that the real traffic
(gameplay state) flows directly peer-to-peer and never touches the server
again.

To make that concrete, we're building a toy but real demo:

1. **Ouija board web app** — two roles, "medium" and "ghost", share a board
   in real time. One drags/moves the planchette, the other watches (and/or
   both influence it at once — see Open Questions).
2. **P2P matchmaking server** — a small, cheap-to-host service whose only
   job is to pair a waiting medium with a waiting ghost and act as the
   WebRTC *signaling* relay (SDP offer/answer + ICE candidates) so the two
   browsers can open a direct `RTCDataChannel`. Once that channel is open,
   the server is out of the loop entirely — planchette movement never
   passes through it.

The signaling-vs-data distinction *is* the talk. Slides/demo should make it
visually obvious when traffic stops touching the server.

## Architecture decisions made so far

- **Two packages, different toolchains** (not a single npm workspace root
  for both — `server/` is its own Go module):
  - `server/` — Go + `gorilla/websocket`. Originally prototyped in Node;
    switched to Go because that's the user's day-job language and what
    they'll actually be comfortable live-presenting/live-coding. The Node
    version is still in git history (first commit on this branch) if a
    side-by-side "same architecture, two languages" slide is ever wanted.
    Concurrency model: one goroutine per connection for reads, one for
    writes (gorilla connections aren't safe for concurrent writers), but
    all *matchmaking state* (`waiting`, `rooms`, `roomByPlayerID`) lives
    behind a single `Hub` goroutine that owns it exclusively and is only
    ever touched via channels (`join`, `signal`, `unregister`) — "share
    memory by communicating" instead of a mutex around a map. Worth
    calling out in the talk as the direct counterpart to what the
    single-threaded Node event loop gave us for free.
  - `client/` — Vite + vanilla TypeScript (no framework). Framework
    boilerplate would bury the WebRTC mechanics we actually want to show.
- **Signaling protocol** (server ⇄ client, over plain WebSocket JSON
  messages):
  - Client → server: `{type: "join", role: "medium" | "ghost" | "any"}`
  - Server → client: `{type: "matched", roomId, role, initiator}`
  - Relay (either direction, server just forwards): `{type: "signal",
    roomId, data: {kind: "offer"|"answer"|"ice", ...}}`
  - Server → client on disconnect: `{type: "peer-left"}`
  - Matching logic: prefer an explicit medium+ghost pair; fall back to
    pairing two "any" players and assigning roles arbitrarily.
- **WebRTC**: single `RTCDataChannel` per room, one public STUN server
  (`stun:stun.l.google.com:19302`) for NAT traversal — no TURN server (out
  of scope; would reintroduce a relay cost, which undercuts the talk's
  point unless we explicitly call it out as the tradeoff).
- **No "host"**: once the data channel is open, medium and ghost are fully
  symmetric peers — neither has authority over the other. The server
  always makes the medium the WebRTC *initiator* (creates the SDP offer)
  purely because the handshake needs someone to go first; that tie-break
  stops mattering the instant the channel opens.
- **Shared state model for the planchette**: both peers send their own
  pointer target position over the data channel; the rendered planchette
  position is the average of local + remote target, eased per frame. This
  is deliberate — it demonstrates state that emerges from two peers
  talking directly to each other, with *no server-side authority*, which
  is a nice visual/talk beat ("nobody's arbitrating this, they're both
  just... doing it").

## Repo layout

```
/
  CLAUDE.md          — this file
  README.md          — human-facing setup/run instructions
  package.json        — npm workspaces root (client only; server is a Go module)
  server/
    go.mod
    main.go            — matchmaking + signaling relay server (Hub + WS plumbing)
  client/
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    src/
      main.ts          — app bootstrap, role selection, wiring
      net.ts            — WebSocket signaling client + WebRTC setup
      board.ts          — ouija board layout/rendering + planchette physics
      style.css
```

## Status

- [x] Repo scaffolded (workspaces, server skeleton, client skeleton).
- [x] Matchmaking/signaling server implemented (in-memory queue, no
      persistence — fine for a demo).
- [x] Client: role picker, WebSocket join flow, WebRTC handshake, board
      rendering with a draggable, peer-averaged planchette.
- [ ] Visual polish on the board (currently a functional but plain arc
      layout of letters/numbers/yes/no/goodbye).
- [ ] Deploy the matchmaking server somewhere cheap (Fly.io / Render free
      tier / a $5 VPS / Cloudflare Durable Objects are candidates — good
      talk material either way since the point is "it's cheap").
- [ ] Deploy the client as a static site (Vercel/Netlify/GitHub Pages —
      trivial, it's just static files + a WS URL env var).
- [ ] TURN server discussion for the slides (why we're *not* using one,
      what it would cost if we did — this is a great "here's the tradeoff"
      slide).
- [ ] Slide deck / talk outline itself.

## Open questions (need the user's input, don't just decide)

1. **Interaction mechanic**: is it truly "both hands on the planchette"
   (current implementation), or should "ghost" have sole control and
   "medium" just observes/asks questions (closer to real ouija folklore)?
   Current code does the former because it's the more interesting P2P
   demo, but this is a product decision, not just a technical one.
2. **Deployment target for the matchmaking server** — depends on what the
   user wants to show live in the talk vs. what's cheapest/simplest to
   stand up beforehand.
3. **Talk format**: live coding? live demo with two phones/laptops on
   stage? pre-recorded fallback in case of conference wifi? Should shape
   how robust we make the reconnect/error-handling paths.
4. **Room size**: bug-for-bug it's always exactly one medium + one ghost.
   Worth ever supporting spectators (read-only third connection)? Not
   started; flagging as a possible "if there's time" feature.

## How to run locally (dev)

Requires Go 1.22+ and Node 20+.

```
npm install
npm run dev     # runs server (ws://localhost:8080, go run .) and client (Vite) together
```

Open two browser tabs at the client URL, pick "medium" in one and "ghost"
in the other (or "any"/"any" and let the server assign).
