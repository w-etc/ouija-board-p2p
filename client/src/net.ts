/**
 * WebSocket signaling client + WebRTC data channel setup.
 *
 * This module talks to the matchmaking server just long enough to find a
 * partner and negotiate a direct RTCDataChannel. Once `onChannelOpen`
 * fires, `send()` goes straight peer-to-peer — the WebSocket is only kept
 * open afterwards so we can hear about the partner leaving.
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

  ws.addEventListener("open", () => {
    cb.onStatus("Connected to matchmaking server. Looking for a partner...");
    ws.send(JSON.stringify({ type: "join", role: requestedRole }));
  });

  ws.addEventListener("message", (ev) => {
    void handleServerMessage(JSON.parse(ev.data));
  });

  ws.addEventListener("close", () => {
    cb.onStatus("Disconnected from matchmaking server.");
  });

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
      cb.onStatus("Your partner disconnected.");
      cb.onPeerLeft();
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

    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendSignal({ kind: "ice", candidate: ev.candidate.toJSON() });
    };

    pc.onconnectionstatechange = () => {
      console.log("[webrtc] connectionState:", pc?.connectionState);

      if (pc?.connectionState === "connected") {
        cb.onStatus("Connected directly to your partner — the server is no longer involved.");
      } else if (pc?.connectionState === "failed") {
        cb.onStatus(
          "Could not establish a direct connection. This can happen on restrictive networks " +
            "(corporate/conference wifi, symmetric NAT) that block WebRTC's peer-to-peer handshake " +
            "without a TURN relay server, which this demo intentionally doesn't run. Try a mobile " +
            "hotspot instead.",
        );
      }
      // "disconnected" is deliberately not surfaced here — it's often
      // transient (ICE can flap back to "connected" on its own) and, more
      // importantly, it has no way to know about a graceful GOODBYE. The
      // server-mediated "peer-left" message is the authoritative signal
      // for "your partner is actually gone" and is what carries the
      // correct, goodbye-aware message — showing a generic one here too
      // just races it and sometimes wins, flashing the wrong message
      // first.
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
    ch.onopen = () => cb.onChannelOpen();
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
      channel?.close();
      pc?.close();
      ws.close();
    },
    getRemoteAddress,
  };
}
