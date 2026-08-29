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

export interface Session {
  send(data: unknown): void;
  close(): void;
}

export function connect(wsUrl: string, requestedRole: RequestedRole, cb: SessionCallbacks): Session {
  const ws = new WebSocket(wsUrl);

  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let roomId: string | null = null;
  let remoteDescSet = false;
  let pendingCandidates: RTCIceCandidateInit[] = [];

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
      } else if (pc?.connectionState === "disconnected") {
        cb.onStatus("Connection to your partner dropped.");
      }
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
  };
}
