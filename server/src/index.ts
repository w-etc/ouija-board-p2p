import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * The matchmaking/signaling server.
 *
 * This is the ONLY server involved in a game. Its job is deliberately
 * small: pair a waiting "medium" with a waiting "ghost", then relay the
 * WebRTC handshake (SDP offer/answer + ICE candidates) between them so
 * their browsers can open a direct RTCDataChannel. Once that channel is
 * open, this server is no longer part of the conversation — planchette
 * movement travels peer-to-peer, not through here.
 */

type Role = "medium" | "ghost" | "any";

interface Player {
  id: string;
  ws: WebSocket;
  role: Role;
}

interface Room {
  id: string;
  medium: Player;
  ghost: Player;
}

const PORT = Number(process.env.PORT) || 8080;

const waiting: Player[] = [];
const rooms = new Map<string, Room>();
// so we can find a player's room by their id when they disconnect or signal
const roomByPlayerId = new Map<string, string>();

const wss = new WebSocketServer({ port: PORT });

console.log(`[matchmaking] listening on :${PORT}`);

wss.on("connection", (ws) => {
  const id = randomUUID();

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join" && typeof msg.role === "string") {
      const role: Role = msg.role === "medium" || msg.role === "ghost" ? msg.role : "any";
      tryMatch({ id, ws, role });
      return;
    }

    if (msg.type === "signal" && typeof msg.roomId === "string") {
      relaySignal(id, msg.roomId, msg.data);
      return;
    }
  });

  ws.on("close", () => {
    removeFromWaiting(id);

    const roomId = roomByPlayerId.get(id);
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const partner = room.medium.id === id ? room.ghost : room.medium;
    partner.ws.send(JSON.stringify({ type: "peer-left" }));

    rooms.delete(roomId);
    roomByPlayerId.delete(room.medium.id);
    roomByPlayerId.delete(room.ghost.id);
  });
});

function removeFromWaiting(id: string) {
  const idx = waiting.findIndex((p) => p.id === id);
  if (idx !== -1) waiting.splice(idx, 1);
}

function tryMatch(player: Player) {
  waiting.push(player);

  let medium: Player | undefined = waiting.find((p) => p.role === "medium");
  let ghost: Player | undefined = waiting.find((p) => p.role === "ghost");

  if (!medium || !ghost) {
    // No explicit medium+ghost pair waiting — fall back to pairing up two
    // "any" players and assigning them roles arbitrarily.
    const anyPlayers = waiting.filter((p) => p.role === "any");
    if (anyPlayers.length >= 2) {
      [medium, ghost] = anyPlayers;
    }
  }

  if (!medium || !ghost) return;

  removeFromWaiting(medium.id);
  removeFromWaiting(ghost.id);

  const roomId = randomUUID();
  rooms.set(roomId, { id: roomId, medium, ghost });
  roomByPlayerId.set(medium.id, roomId);
  roomByPlayerId.set(ghost.id, roomId);

  // The medium's browser is the one that creates the WebRTC offer; this is
  // an arbitrary but necessary tie-break (two peers can't both go first).
  medium.ws.send(JSON.stringify({ type: "matched", roomId, role: "medium", initiator: true }));
  ghost.ws.send(JSON.stringify({ type: "matched", roomId, role: "ghost", initiator: false }));

  console.log(`[matchmaking] paired room ${roomId}`);
}

function relaySignal(fromId: string, roomId: string, data: unknown) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.medium.id !== fromId && room.ghost.id !== fromId) return;

  const target = room.medium.id === fromId ? room.ghost : room.medium;
  target.ws.send(JSON.stringify({ type: "signal", data }));
}
