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

## Live deployment (confirmed working 2026-08-30)

- Client: **https://w-etc.github.io/ouija-board-p2p/**
- Matchmaking server: **wss://ouija-matchmaking.onrender.com** (Render free
  tier — cold-starts after 15 min idle, pre-warm before demoing live)

See the deployment entry in Status below for how these are configured and
how to redeploy either one.

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

## Known issues / gotchas

- **Firefox fails the WebRTC handshake, even two tabs on one machine**
  (2026-08-29). Symptom: `net.ts`'s connection-state logging shows
  `iceConnectionState: failed` and Firefox prints "ICE failed, add a TURN
  server and see about:webrtc for more details" — even for a same-machine
  loopback connection that needs no NAT traversal at all. Confirmed via
  live test: same code, same machine, Chrome connects fine, Firefox does
  not. Root cause is almost certainly Firefox's mDNS host-candidate
  obfuscation (it hides real local IPs behind a random `<uuid>.local`
  hostname in ICE candidates; if the OS can't resolve `.local` mDNS names,
  even localhost fails) rather than anything in our signaling/WebRTC code
  — the offer/answer/tap/chat protocol is verified correct by automated
  same-origin Chromium tests. Diagnosing this took a few rounds because
  the symptom (no messages arriving in either direction) looked identical
  to "connected but silently dropping messages," which turned out to be a
  real separate gap we fixed along the way: `net.ts`'s `send()` used to
  drop outbound messages with no feedback whenever the channel wasn't
  open, and connection failures weren't surfaced to the UI at all — both
  now logged/shown, which is how the Firefox ICE failure became visible
  in the first place instead of just "nothing happens."
  - **Decision: use Chrome/Chromium for the live demo.** The presenter
    controls the browser on stage, so this is a "pick your browser"
    problem rather than something the app needs to work around. Not
    pursuing a Firefox-specific fix (e.g. instructing users to flip
    `media.peerconnection.ice.obfuscate_host_addresses` in
    `about:config`) since it's not something we can control for an
    audience member following along on their own machine anyway, and
    doesn't affect the demo itself.
  - Worth an audience aside if it comes up: this is actually a fitting
    real-world footnote for the STUN/TURN slide — "peer-to-peer" still
    depends on the browser's own address-discovery mechanics working,
    and different browsers implement that differently.

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
- [x] Responsive/mobile layout (2026-08-29) — motivated by the live demo's
      corporate-wifi risk (see TURN server notes below): if venue wifi
      blocks WebRTC, the fallback is phones on a mobile hotspot, so the
      client needed to actually work on a phone, not just not-crash.
      Role buttons stack full-width on narrow screens, body padding/type
      scale down, chat input stays at 16px (avoids iOS auto-zoom-on-focus),
      planchette size and glyph font-size use `clamp()`. Board switches to
      a taller (4:5) aspect ratio under 600px width — portrait phones have
      vertical room a 3:2 landscape ratio was wasting, and since glyph
      positions are already fractions of the container, this alone spread
      the letter arcs out further with no layout math changes. Widened the
      numbers row's arc (`board.ts`) since it was the most cramped element
      at small sizes. Browser-tested at iPhone SE and Pixel 5 viewports
      with real touch taps (Playwright + device emulation): no horizontal
      overflow, full tap→planchette→chat flow works, 44px role-button
      targets. **Known limitation, not fully solved**: touch targets for
      individual letters are ~27px (below the ~44px guideline) and a few
      adjacent-letter pairs at the ends of each arc are close enough to
      slightly overlap — 13 letters arced across a ~300px-wide phone
      screen is a hard physical constraint, not a bug to chase further;
      enlarging targets more would make the overlap worse, not better.
      Same crowding a real paper board has at the ends of its letter rows.
- [ ] Visual polish on the board (currently a functional but plain arc
      layout of letters/numbers/yes/no/goodbye).
- [x] **Deployed and confirmed working live (2026-08-30).**
      - Server: **Render free Web Service**, deployed via the `render.yaml`
        blueprint (`runtime: go`, `rootDir: server`, `healthCheckPath:
        /healthz`) — picked specifically for the no-credit-card requirement;
        re-researched the hosting shortlist at the time since these policies
        drift (Fly.io dropped its card-free tier entirely in 2024, which is
        why it's not this). Live at `https://ouija-matchmaking.onrender.com`
        (`wss://ouija-matchmaking.onrender.com` for the client). Free plan
        cold-starts after 15 min idle (~1 min to wake) — **pre-warm it with
        a request a few minutes before the live demo.** If cold-start risk
        ever becomes a dealbreaker, a cheap VPS/Fly.io (now card-required)
        or Cloudflare Workers/Durable Objects (card-free, no cold starts,
        but means rewriting the server in JS) are the alternatives — not
        pursued since Go is the point (see toolchain decision above).
      - Client: **GitHub Pages**, via `.github/workflows/deploy-pages.yml`
        (builds on every push to `claude/p2p-ouija-matchmaking-olrj29`,
        deploys via `actions/deploy-pages`) and `vite.config.ts`'s `base:
        "/ouija-board-p2p/"` for production builds only. Live at
        `https://w-etc.github.io/ouija-board-p2p/`, built with
        `VITE_MATCHMAKING_URL` pointed at the Render URL above (set as a
        repo variable — Vite bakes it in at build time, so re-set + rebuild
        if the Render URL ever changes).
      - Both required one manual step each that Claude Code couldn't do via
        API (no GitHub MCP tool exposes the Pages source setting; no Render
        credentials available): flipping repo Settings → Pages → Source to
        GitHub Actions, and the Render blueprint signup/apply + copying its
        URL into the repo variable. Both done by the user; end-to-end round
        confirmed working from the live URLs.
- [ ] **Cost-at-scale estimates for the talk (requested 2026-08-29, not
      started)**: the talk needs concrete $ figures for running the
      matchmaking server at different scales — user gave 100 ouija boards
      (200 concurrent players), 1,000 boards, 10,000 boards as the
      benchmark points (more orders of magnitude likely worth adding,
      e.g. 100,000). This is the payoff of the whole "cheap matchmaking,
      P2P gameplay" thesis, so it deserves real numbers, not hand-waving:
      - Needs a per-connection resource model first: each player is one
        persistent WebSocket held by the Go server for the ~duration of a
        session (matchmaking wait + however long their board session
        runs), plus the brief signaling relay traffic (a handful of
        small JSON messages per room: offer/answer/ICE candidates) —
        gameplay traffic (chat/taps) never touches the server, which is
        exactly why this should stay cheap even at scale. Memory per
        goroutine + WS connection is small (each `Player`/`Hub` state is
        tiny); the real scaling questions are concurrent connection count
        vs. a given host's connection/memory limits, and how session
        duration affects concurrency at a given boards/hour rate.
      - Should map those N-boards figures to concrete instance sizes on
        the shortlisted platforms (Fly.io/VPS/Cloud Run/Render) and give
        $/mo at each, plus calling out where a tier boundary gets crossed
        (e.g. "free tier covers X, above that you need $Y/mo").
      - Worth benchmarking the actual Go server (or at least reasoning
        from gorilla/websocket's known overhead) rather than pulling
        numbers out of the air, given this is the headline evidence for
        the talk's argument.
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
2. ~~Deployment target~~ — resolved, see "Live deployment" above.
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
