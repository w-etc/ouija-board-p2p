/**
 * Ouija board layout + planchette rendering.
 *
 * Positions are all normalized to [0, 1] x [0, 1] in board space so the
 * board can be resized freely. Layout is a rough approximation of a
 * classic ouija board: two arcs of letters, a row of numbers, and
 * YES / NO / GOODBYE in fixed spots. Purely cosmetic — feel free to
 * rework this without touching net.ts.
 */

export interface Point {
  x: number;
  y: number;
}

export interface TapEvent extends Point {
  symbol: string;
}

interface ArcOptions {
  count: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  startDeg: number;
  endDeg: number;
}

function arcPositions({ count, cx, cy, rx, ry, startDeg, endDeg }: ArcOptions): Point[] {
  const positions: Point[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const deg = startDeg + t * (endDeg - startDeg);
    const rad = (deg * Math.PI) / 180;
    positions.push({
      x: cx + rx * Math.sin(rad),
      y: cy - ry * Math.cos(rad),
    });
  }
  return positions;
}

export interface RenderLettersOptions {
  /** Only the ghost can tap symbols — the medium's board is read-only. */
  onTap?: (tap: TapEvent) => void;
}

/** Maps each board symbol to its rendered element, so a Planchette can highlight whichever one it lands on. */
export type GlyphMap = Map<string, HTMLElement>;

export function renderLetters(container: HTMLElement, options: RenderLettersOptions = {}): GlyphMap {
  container.innerHTML = "";

  const rowA = "ABCDEFGHIJKLM".split("");
  const rowB = "NOPQRSTUVWXYZ".split("");
  const numbers = "0123456789".split("");
  const glyphsBySymbol: GlyphMap = new Map();

  const place = (chars: string[], opts: ArcOptions, wordClass = false) => {
    const positions = arcPositions(opts);
    chars.forEach((ch, i) => {
      const { x, y } = positions[i];
      const el = document.createElement("span");
      el.className = wordClass ? "glyph word" : "glyph";
      el.textContent = ch;
      el.style.left = `${x * 100}%`;
      el.style.top = `${y * 100}%`;

      if (options.onTap) {
        el.classList.add("tappable");
        el.addEventListener("pointerdown", () => options.onTap!({ symbol: ch, x, y }));
      }

      glyphsBySymbol.set(ch, el);
      container.appendChild(el);
    });
  };

  place(rowA, { count: rowA.length, cx: 0.5, cy: 0.42, rx: 0.44, ry: 0.24, startDeg: -80, endDeg: 80 });
  place(rowB, { count: rowB.length, cx: 0.5, cy: 0.58, rx: 0.44, ry: 0.24, startDeg: -80, endDeg: 80 });
  place(numbers, { count: numbers.length, cx: 0.5, cy: 0.8, rx: 0.44, ry: 0.16, startDeg: -78, endDeg: 78 });

  place(["YES"], { count: 1, cx: 0.14, cy: 0.14, rx: 0, ry: 0, startDeg: 0, endDeg: 0 }, true);
  place(["NO"], { count: 1, cx: 0.86, cy: 0.14, rx: 0, ry: 0, startDeg: 0, endDeg: 0 }, true);
  place(["GOODBYE"], { count: 1, cx: 0.5, cy: 0.94, rx: 0, ry: 0, startDeg: 0, endDeg: 0 }, true);

  return glyphsBySymbol;
}

const MOVE_MS = 600;
const HOLD_MS = 1000;

/**
 * Drives the planchette element from a queue of tapped symbols.
 *
 * Every tap — the ghost's own, and every one relayed from the peer over
 * the data channel — gets pushed through the exact same `enqueue()`. The
 * data channel delivers messages in order, so both browsers replay the
 * identical sequence of taps independently and end up showing the same
 * thing without either one telling the other what to render. That's the
 * P2P framing again, just via replicated events instead of averaged
 * positions: nobody's arbitrating this, both sides are just applying the
 * same tap history.
 *
 * The planchette itself is a plain ring (no fill) — it used to be a solid
 * disc, which meant it hid the very letter it was pointing at. Since the
 * ring never covers anything, legibility instead comes from the landed
 * glyph itself: whichever element `glyphsBySymbol` maps the tapped symbol
 * to gets a `.landed` class (same glow treatment as the existing hover
 * state) for as long as the planchette sits on it.
 */
export class Planchette {
  private queue: TapEvent[] = [];
  private busy = false;
  private timer = 0;
  private landedEl: HTMLElement | null = null;

  constructor(
    private el: HTMLElement,
    private glyphsBySymbol: GlyphMap,
  ) {}

  enqueue(tap: TapEvent) {
    this.queue.push(tap);
    if (!this.busy) this.advance();
  }

  private advance = () => {
    const next = this.queue.shift();
    if (!next) {
      this.busy = false;
      return;
    }

    this.busy = true;
    this.el.style.left = `${next.x * 100}%`;
    this.el.style.top = `${next.y * 100}%`;

    this.landedEl?.classList.remove("landed");
    this.landedEl = this.glyphsBySymbol.get(next.symbol) ?? null;
    this.landedEl?.classList.add("landed");

    this.timer = window.setTimeout(this.advance, MOVE_MS + HOLD_MS);
  };

  destroy() {
    window.clearTimeout(this.timer);
    this.landedEl?.classList.remove("landed");
  }
}
