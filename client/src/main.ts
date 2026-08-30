import { renderLetters, Planchette, type TapEvent } from "./board";
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
      statusEl.textContent = text;
      boardStatusEl.textContent = text;
    },
    onMatched(matchedRole: MatchedRole) {
      setupEl.hidden = true;
      boardEl.hidden = false;

      const isGhost = matchedRole === "ghost";
      chatFormEl.hidden = matchedRole !== "medium";

      const glyphsBySymbol = renderLetters(lettersEl, {
        onTap: isGhost
          ? (tap: TapEvent) => {
              planchette?.enqueue(tap);
              session?.send({ type: "tap", symbol: tap.symbol, x: tap.x, y: tap.y });
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
        return;
      }
      if (data.type === "chat" && typeof data.text === "string") {
        appendChatMessage(data.text, false);
        return;
      }
    },
    onPeerLeft() {
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
