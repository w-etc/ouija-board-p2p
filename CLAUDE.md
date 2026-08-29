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
   in real time. The medium asks questions over a text chat; the ghost
   answers by tapping letters/symbols on the board, and the planchette
   glides to each tapped spot and holds there before moving on.
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
- **Interaction mechanic** (resolved — was open question #1): closer to
  real ouija folklore than the original "both hands on the planchette"
  prototype. Only the **medium** can write into a shared chat (asking
  questions); only the **ghost** can tap letters/numbers/YES/NO/GOODBYE on
  the board. Each tap is sent over the data channel as `{type: "tap",
  symbol, x, y}`; chat messages go as `{type: "chat", text}`. Both are
  peer-to-peer only, same as before — the matchmaking server never sees
  gameplay traffic.
- **Planchette rendering — replicated event queue, not averaged state**:
  every tap (the ghost's own, and every one relayed from the peer) is
  pushed through the same `Planchette.enqueue()`. The data channel
  delivers messages in order, so both browsers replay an identical
  sequence of taps independently and land on the same rendering without
  either one telling the other what to draw — CSS transitions the
  planchette to each tapped spot (~600ms) and holds it there (~1s) before
  advancing to the next queued tap. This replaced the earlier "average of
  both peers' live pointer position" model now that only one side (the
  ghost) drives the planchette; it's still a good talk beat, just a
  different P2P technique — event replication instead of state averaging.

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
      main.ts          — app bootstrap, role selection, chat + tap wiring
      net.ts            — WebSocket signaling client + WebRTC setup
      board.ts          — board layout/rendering + planchette tap queue
      style.css
```

## Status

- [x] Repo scaffolded (workspaces, server skeleton, client skeleton).
- [x] Matchmaking/signaling server implemented (in-memory queue, no
      persistence — fine for a demo).
- [x] Client: role picker, WebSocket join flow, WebRTC handshake, board
      rendering.
- [x] Interaction mechanic: medium-writes-chat / ghost-taps-board,
      planchette glides + holds per tap (browser-tested with two
      simulated clients — chat delivery, role-gated tappability, and the
      hold-then-advance queue timing all verified).
- [ ] Visual polish on the board (currently a functional but plain arc
      layout of letters/numbers/yes/no/goodbye).
- [ ] Deploy the matchmaking server somewhere cheap. Shortlist given to
      the user (2026-08-29), no pick made yet:
      - Fly.io / a cheap VPS (Hetzner/DigitalOcean, ~$4-5/mo) — best fit
        for "it's a single Go binary", no cold starts, good live-demo
        reliability. A VPS can also serve the built client via
        Caddy/nginx alongside the Go binary — "one cheap box does
        everything" is a strong single-slide story.
      - Render free tier / Railway — easiest to stand up, but Render's
        free tier cold-starts on idle, which is a real risk for a live
        demo (pre-warm it, or pay for the smallest paid tier instead).
      - Cloud Run — scales to zero, pay-per-use, supports WebSockets;
        reasonable "still cheap, but cloud-native" data point.
      - Cloudflare Workers/Durable Objects — near-zero idle cost, but
        would mean rewriting the server in JS, not Go; only worth it as
        an explicit "here's the serverless extreme" comparison, not as
        the thing we actually build.
- [ ] Deploy the client as a static site (Vercel/Netlify/Cloudflare
      Pages/GitHub Pages — trivial, it's just static files + a WS URL env
      var).
- [x] TURN server explanation given to the user (2026-08-29) — see the
      "No TURN server" decision above for the summary. Key points if this
      becomes a slide: STUN just helps peers discover their reachable
      address (cheap, what we use); TURN is a fallback *relay* for
      NATs/firewalls hostile to hole-punching (symmetric NAT, some
      corporate/hotel/conference networks) and it carries full traffic
      bandwidth like a real server would, which is exactly the cost the
      talk argues against. Hosted pay-per-GB TURN (Twilio, Cloudflare
      Realtime, metered.ca, Xirsys) exists if we ever need one. Given
      there's a live demo (see resolved open question #3), worth testing
      the venue network beforehand and having a mobile-hotspot fallback
      rather than quietly adding a TURN server "just in case" — the
      failure mode is itself part of the honest tradeoff story.
- [ ] Slide deck / talk outline itself.

## Open questions (need the user's input, don't just decide)

1. ~~Interaction mechanic~~ — resolved, see Architecture decisions.
2. **Deployment target for the matchmaking server** — depends on what the
   user wants to show live in the talk vs. what's cheapest/simplest to
   stand up beforehand. Candidate list given to the user; final pick
   still pending.
3. ~~Talk format~~ — resolved: no live coding, but there will be a live
   demo. This means reconnect/error-handling robustness and testing on
   venue wifi beforehand actually matter — flagging as follow-up work,
   not yet done.
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
