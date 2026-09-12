import { renderLetters, Planchette, MOVE_MS, type TapEvent } from "./board";
import { connect, type MatchedRole, type RequestedRole, type Session } from "./net";

const WS_URL = (import.meta.env.VITE_MATCHMAKING_URL as string | undefined) ?? "ws://localhost:8080";

const setupEl = document.getElementById("setup")!;
const boardEl = document.getElementById("board")!;
const statusEl = document.getElementById("status")!;
const boardStatusEl = document.getElementById("board-status")!;
const lettersEl = document.getElementById("letters")!;
const planchetteEl = document.getElementById("planchette")!;
const chatLogEl = document.getElementById("chat-log")!;
const chatFormEl = document.getElementById("chat-form") as HTMLFormElement;
const chatInputEl = document.getElementById("chat-input") as HTMLInputElement;

let session: Session | null = null;
let planchette: Planchette | null = null;
let currentRole: MatchedRole | null = null;
// Set once the session reaches a terminal state we put custom copy on
// (goodbye, peer-left) — guards that message against the WebSocket's own
// "close" event firing moments later with a generic status update.
let sessionEnded = false;
// Whether GOODBYE was the last symbol tapped — the ritual completed properly
// versus someone just vanishing mid-session. Only the ghost ever taps, so
// this is set locally when the ghost taps it, or on receipt of that tap
// message when we're the medium.
let lastTapWasGoodbye = false;

document.querySelectorAll<HTMLButtonElement>("#role-buttons button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const role = btn.dataset.role as RequestedRole;
    startSession(role);
  });
});

chatFormEl.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = chatInputEl.value.trim();
  if (!text) return;

  appendChatMessage(text, true);
  session?.send({ type: "chat", text });
  chatInputEl.value = "";
});

function startSession(role: RequestedRole) {
  document.querySelectorAll<HTMLButtonElement>("#role-buttons button").forEach((b) => (b.disabled = true));

  session = connect(WS_URL, role, {
    onStatus(text) {
      if (sessionEnded) return;
      statusEl.textContent = text;
      boardStatusEl.textContent = text;
    },
    onMatched(matchedRole: MatchedRole) {
      currentRole = matchedRole;
      lastTapWasGoodbye = false;
      sessionEnded = false;
      setupEl.hidden = true;
      boardEl.hidden = false;

      const isGhost = matchedRole === "ghost";
      chatFormEl.hidden = matchedRole !== "medium";

      const glyphsBySymbol = renderLetters(lettersEl, {
        onTap: isGhost
          ? (tap: TapEvent) => {
              planchette?.enqueue(tap);
              session?.send({ type: "tap", symbol: tap.symbol, x: tap.x, y: tap.y });

              if (tap.symbol === "GOODBYE") {
                lastTapWasGoodbye = true;
                // Let the planchette actually arrive before the screen changes.
                window.setTimeout(() => {
                  sessionEnded = true;
                  boardStatusEl.textContent = "You have said your goodbyes. The connection is closed.";
                  session?.close();
                }, MOVE_MS);
              }
            }
          : undefined,
      });

      planchette = new Planchette(planchetteEl, glyphsBySymbol);

      boardStatusEl.textContent = isGhost
        ? "Tap a letter or symbol to answer."
        : "Ask a question below and watch for an answer.";
    },
    onChannelOpen() {
      boardStatusEl.textContent = "Connected directly to your partner — the server is no longer involved.";
    },
    onMessage(data) {
      if (data.type === "tap" && planchette) {
        planchette.enqueue({ symbol: data.symbol, x: data.x, y: data.y });
        if (data.symbol === "GOODBYE") lastTapWasGoodbye = true;
        return;
      }
      if (data.type === "chat" && typeof data.text === "string") {
        appendChatMessage(data.text, false);
        return;
      }
    },
    onPeerLeft() {
      sessionEnded = true;
      if (lastTapWasGoodbye) {
        boardStatusEl.textContent =
          currentRole === "medium" ? "The ghost has said its goodbyes and departed." : "You said your goodbyes.";
        return;
      }

      if (currentRole === "ghost") {
        const remote = session?.getRemoteAddress();
        boardStatusEl.textContent = remote
          ? `The medium vanished without saying goodbye. Folklore says it lingers — last seen at ${remote.address}:${remote.port}.`
          : "The medium vanished without saying goodbye. Refresh to find a new one.";
        return;
      }

      boardStatusEl.textContent = "Your partner disconnected. Refresh to find a new one.";
    },
  });
}

function appendChatMessage(text: string, mine: boolean) {
  const el = document.createElement("div");
  el.className = mine ? "chat-message mine" : "chat-message";
  el.textContent = text;
  chatLogEl.appendChild(el);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}
