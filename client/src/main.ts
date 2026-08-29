import { renderLetters, Planchette, type Point } from "./board";
import { connect, type RequestedRole, type Session } from "./net";

const WS_URL = (import.meta.env.VITE_MATCHMAKING_URL as string | undefined) ?? "ws://localhost:8080";

const setupEl = document.getElementById("setup")!;
const boardEl = document.getElementById("board")!;
const statusEl = document.getElementById("status")!;
const boardStatusEl = document.getElementById("board-status")!;
const surfaceEl = document.getElementById("board-surface")!;
const lettersEl = document.getElementById("letters")!;
const planchetteEl = document.getElementById("planchette")!;

let session: Session | null = null;
let planchette: Planchette | null = null;

const MOVE_THROTTLE_MS = 40;
let lastSentAt = 0;

document.querySelectorAll<HTMLButtonElement>("#role-buttons button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const role = btn.dataset.role as RequestedRole;
    startSession(role);
  });
});

function startSession(role: RequestedRole) {
  document.querySelectorAll<HTMLButtonElement>("#role-buttons button").forEach((b) => (b.disabled = true));

  session = connect(WS_URL, role, {
    onStatus(text) {
      statusEl.textContent = text;
      boardStatusEl.textContent = text;
    },
    onMatched() {
      setupEl.hidden = true;
      boardEl.hidden = false;
      renderLetters(lettersEl);

      planchette = new Planchette(planchetteEl, surfaceEl, (p: Point) => {
        const now = performance.now();
        if (now - lastSentAt < MOVE_THROTTLE_MS) return;
        lastSentAt = now;
        session?.send({ type: "move", x: p.x, y: p.y });
      });
    },
    onChannelOpen() {
      boardStatusEl.textContent = "Connected directly to your partner. Move the planchette.";
    },
    onMessage(data) {
      if (data.type === "move" && planchette) {
        planchette.setRemote({ x: data.x, y: data.y });
      }
    },
    onPeerLeft() {
      boardStatusEl.textContent = "Your partner disconnected. Refresh to find a new one.";
    },
  });
}
