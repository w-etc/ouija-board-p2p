/**
 * WebSocket signaling client + WebRTC data channel setup.
 *
 * This module talks to the matchmaking server just long enough to find a
 * partner and negotiate a direct RTCDataChannel — the instant that channel
 * opens, the matchmaking socket is closed (see wireChannel). From that
 * point on the server has no connection to either peer at all: not just
 * gameplay data, but "is my partner still there" liveness too, is detected
 * purely from WebRTC's own signals (the data channel's close event, or the
 * peer connection reaching "failed").
 */

export type RequestedRole = "medium" | "ghost" | "any";
export type MatchedRole = "medium" | "ghost";

export interface SessionCallbacks {
  onStatus: (text: string) => void;
  onMatched: (role: MatchedRole) => void;
  onChannelOpen: () => void;
  onMessage: (data: any) => void;
  onPeerLeft: () => void;
}

export interface RemoteAddress {
  address: string;
  port: number;
}

export interface Session {
  send(data: unknown): void;
  close(): void;
  /**
   * The peer's address, parsed from the ICE candidates they sent during
   * signaling. Nothing new is collected here — every ICE candidate we
   * receive already contains this in plain text (that's inherent to how
   * ICE/NAT traversal works, see net.ts's module comment), we're just
   * reading it back out instead of only handing it to addIceCandidate().
   * (getStats() would be the "proper" API for this, but Chromium blanks
   * candidate addresses there for privacy — parsing the candidate string
   * directly is what actually works, and is the same technique WebRTC
   * IP-leak checker tools have always used.)
   */
  getRemoteAddress(): RemoteAddress | null;
}

interface ParsedCandidate extends RemoteAddress {
  /** "host" (local network address — often mDNS-masked to a random .local name
   *  by the browser itself, same privacy mechanism behind the Firefox issue in
   *  CLAUDE.md), "srflx" (the real public address, discovered via STUN — this
   *  is the one that matters once the two peers are on different networks),
   *  or "relay" (unused here, we don't run a TURN server). */
  type: string;
}

/** Pulls the address/port/type out of a raw ICE candidate line, e.g. "candidate:842163049 1 udp 2113937151 203.0.113.5 54321 typ srflx ...". */
function parseCandidateAddress(candidateLine: string | undefined): ParsedCandidate | null {
  if (!candidateLine) return null;
  const match = candidateLine.match(/^candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ (\S+)/);
  if (!match) return null;
  return { address: match[1], port: Number(match[2]), type: match[3] };
}

export function connect(wsUrl: string, requestedRole: RequestedRole, cb: SessionCallbacks): Session {
  const ws = new WebSocket(wsUrl);

  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let roomId: string | null = null;
  let remoteDescSet = false;
  let pendingCandidates: RTCIceCandidateInit[] = [];
  let remoteCandidates: ParsedCandidate[] = [];
  // True once *we* closed the matchmaking socket on purpose — either
  // because the data channel just opened and it's no longer needed, or
  // because the whole session is being torn down (Session.close()).
  // Guards the ws "close" listener against showing a spurious disconnect
  // message for a close we ourselves triggered.
  let intentionalWsClose = false;
  // True once Session.close() ran locally — guards notifyPeerGone from
  // firing off our *own* channel.close()/pc.close() call (e.g. after
  // tapping GOODBYE) as if the peer had vanished.
  let closedLocally = false;
  let peerGoneNotified = false;

  ws.addEventListener("open", () => {
    cb.onStatus("Connected to matchmaking server. Looking for a partner...");
    ws.send(JSON.stringify({ type: "join", role: requestedRole }));
  });

  ws.addEventListener("message", (ev) => {
    void handleServerMessage(JSON.parse(ev.data));
  });

  ws.addEventListener("close", () => {
    if (intentionalWsClose) return;
    cb.onStatus("Disconnected from matchmaking server.");
  });

  // Once the data channel is open there's no server connection left to
  // notify onPeerLeft's caller through — this is the only path left.
  function notifyPeerGone() {
    if (peerGoneNotified || closedLocally) return;
    peerGoneNotified = true;
    cb.onPeerLeft();
  }

  async function handleServerMessage(msg: any) {
    if (msg.type === "matched") {
      roomId = msg.roomId;
      cb.onStatus(`Matched as ${msg.role}. Establishing a direct connection...`);
      cb.onMatched(msg.role);
      await setupPeerConnection(msg.initiator);
      return;
    }

    if (msg.type === "signal") {
      await handleSignal(msg.data);
      return;
    }

    if (msg.type === "peer-left") {
      // Only reachable pre-connection — once the channel opens, our own
      // socket is already closed and we can't receive this anymore.
      cb.onStatus("Your partner disconnected.");
      notifyPeerGone();
      return;
    }
  }

  function sendSignal(data: unknown) {
    ws.send(JSON.stringify({ type: "signal", roomId, data }));
  }

  async function setupPeerConnection(initiator: boolean) {
    pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    let hasConnectedOnce = false;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendSignal({ kind: "ice", candidate: ev.candidate.toJSON() });
    };

    pc.onconnectionstatechange = () => {
      console.log("[webrtc] connectionState:", pc?.connectionState);

      if (pc?.connectionState === "connected") {
        hasConnectedOnce = true;
        cb.onStatus("Connected directly to your partner — the server is no longer involved.");
      } else if (pc?.connectionState === "failed") {
        if (hasConnectedOnce) {
          // We were connected and ICE couldn't recover — the matchmaking
          // socket is long closed by this point (see wireChannel), so
          // this is now the *only* way a silent, no-close-frame network
          // drop gets noticed at all. notifyPeerGone carries the
          // goodbye-aware messaging the same as a clean channel close.
          notifyPeerGone();
        } else {
          cb.onStatus(
            "Could not establish a direct connection. This can happen on restrictive networks " +
              "(corporate/conference wifi, symmetric NAT) that block WebRTC's peer-to-peer handshake " +
              "without a TURN relay server, which this demo intentionally doesn't run. Try a mobile " +
              "hotspot instead.",
          );
        }
      }
      // "disconnected" is deliberately not surfaced here — it's often
      // transient (ICE can flap back to "connected" on its own). We wait
      // for the firmer "failed" (or the data channel's own close event)
      // before declaring the peer gone.
    };

    pc.oniceconnectionstatechange = () => {
      console.log("[webrtc] iceConnectionState:", pc?.iceConnectionState);
    };
    pc.onicegatheringstatechange = () => {
      console.log("[webrtc] iceGatheringState:", pc?.iceGatheringState);
    };
    pc.onicecandidateerror = (ev) => {
      console.warn("[webrtc] icecandidateerror:", ev);
    };

    if (initiator) {
      channel = pc.createDataChannel("ouija");
      wireChannel(channel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ kind: "offer", sdp: offer.sdp });
    } else {
      pc.ondatachannel = (ev) => {
        channel = ev.channel;
        wireChannel(channel);
      };
    }

    setTimeout(() => {
      if (channel?.readyState !== "open") {
        cb.onStatus("Still trying to connect directly to your partner — this is taking longer than usual.");
      }
    }, 8000);
  }

  function wireChannel(ch: RTCDataChannel) {
    ch.onopen = () => {
      cb.onChannelOpen();
      // The handshake is done and there's nothing left for the
      // matchmaking server to do — closing this now is what makes "the
      // server is out of the loop entirely" literally true, not just
      // true for gameplay traffic.
      intentionalWsClose = true;
      ws.close();
    };
    ch.onclose = () => notifyPeerGone();
    ch.onmessage = (ev) => {
      try {
        cb.onMessage(JSON.parse(ev.data));
      } catch {
        // ignore malformed payloads
      }
    };
  }

  async function handleSignal(data: any) {
    if (!pc) return;

    if (data.kind === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      remoteDescSet = true;
      await flushCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ kind: "answer", sdp: answer.sdp });
      return;
    }

    if (data.kind === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      remoteDescSet = true;
      await flushCandidates();
      return;
    }

    if (data.kind === "ice") {
      const parsed = parseCandidateAddress(data.candidate?.candidate);
      if (parsed) remoteCandidates.push(parsed);

      if (remoteDescSet) {
        await pc.addIceCandidate(data.candidate);
      } else {
        pendingCandidates.push(data.candidate);
      }
      return;
    }
  }

  async function flushCandidates() {
    for (const candidate of pendingCandidates) {
      await pc!.addIceCandidate(candidate);
    }
    pendingCandidates = [];
  }

  function getRemoteAddress(): RemoteAddress | null {
    // Prefer the STUN-discovered public address — on the real internet
    // that's the one that's actually informative. Host candidates are
    // only useful as a fallback for same-network testing, since in real
    // cross-network use they're just a private LAN address (and often
    // mDNS-masked to a random .local name before it even reaches here).
    return remoteCandidates.find((c) => c.type === "srflx") ?? remoteCandidates.at(-1) ?? null;
  }

  return {
    send(data: unknown) {
      if (channel && channel.readyState === "open") {
        channel.send(JSON.stringify(data));
      } else {
        console.warn("[webrtc] dropped outgoing message, data channel not open:", channel?.readyState, data);
      }
    },
    close() {
      closedLocally = true;
      intentionalWsClose = true;
      channel?.close();
      pc?.close();
      ws.close();
    },
    getRemoteAddress,
  };
}
