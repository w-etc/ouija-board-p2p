/**
 * Ouija board layout + planchette rendering.
 *
 * Positions are all normalized to [0, 1] x [0, 1] in board space so the
 * board can be resized freely. Layout is a rough approximation of a
 * classic ouija board: two arcs of letters, a row of numbers, and
 * YES / NO / GOODBYE in fixed spots. Purely cosmetic — feel free to
 * rework this without touching net.ts.
 */

interface ArcOptions {
  count: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  startDeg: number;
  endDeg: number;
}

function arcPositions({ count, cx, cy, rx, ry, startDeg, endDeg }: ArcOptions): Array<{ x: number; y: number }> {
  const positions: Array<{ x: number; y: number }> = [];
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

export function renderLetters(container: HTMLElement) {
  container.innerHTML = "";

  const rowA = "ABCDEFGHIJKLM".split("");
  const rowB = "NOPQRSTUVWXYZ".split("");
  const numbers = "0123456789".split("");

  const place = (chars: string[], opts: ArcOptions, wordClass = false) => {
    const positions = arcPositions(opts);
    chars.forEach((ch, i) => {
      const el = document.createElement("span");
      el.className = wordClass ? "glyph word" : "glyph";
      el.textContent = ch;
      el.style.left = `${positions[i].x * 100}%`;
      el.style.top = `${positions[i].y * 100}%`;
      container.appendChild(el);
    });
  };

  place(rowA, { count: rowA.length, cx: 0.5, cy: 0.42, rx: 0.44, ry: 0.24, startDeg: -80, endDeg: 80 });
  place(rowB, { count: rowB.length, cx: 0.5, cy: 0.58, rx: 0.44, ry: 0.24, startDeg: -80, endDeg: 80 });
  place(numbers, { count: numbers.length, cx: 0.5, cy: 0.78, rx: 0.36, ry: 0.12, startDeg: -70, endDeg: 70 });

  place(["YES"], { count: 1, cx: 0.14, cy: 0.14, rx: 0, ry: 0, startDeg: 0, endDeg: 0 }, true);
  place(["NO"], { count: 1, cx: 0.86, cy: 0.14, rx: 0, ry: 0, startDeg: 0, endDeg: 0 }, true);
  place(["GOODBYE"], { count: 1, cx: 0.5, cy: 0.94, rx: 0, ry: 0, startDeg: 0, endDeg: 0 }, true);
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Drives the planchette element. The displayed position is an eased blend
 * of a local target (this browser's own pointer) and a remote target
 * (whatever the peer last reported over the data channel) — nobody's
 * arbitrating this, both peers are just contributing to the same visual
 * state directly.
 */
export class Planchette {
  private local: Point = { x: 0.5, y: 0.5 };
  private remote: Point = { x: 0.5, y: 0.5 };
  private displayed: Point = { x: 0.5, y: 0.5 };
  private raf = 0;

  constructor(
    private el: HTMLElement,
    private surface: HTMLElement,
    private onLocalMove: (p: Point) => void,
  ) {
    this.attachDrag();
    this.loop();
  }

  setRemote(p: Point) {
    this.remote = p;
  }

  private attachDrag() {
    let dragging = false;

    const toPoint = (ev: PointerEvent): Point => {
      const rect = this.surface.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
      return { x, y };
    };

    this.el.addEventListener("pointerdown", (ev) => {
      dragging = true;
      this.el.classList.add("dragging");
      this.el.setPointerCapture(ev.pointerId);
    });

    this.el.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      this.local = toPoint(ev);
      this.onLocalMove(this.local);
    });

    const stop = (ev: PointerEvent) => {
      dragging = false;
      this.el.classList.remove("dragging");
      this.el.releasePointerCapture(ev.pointerId);
    };

    this.el.addEventListener("pointerup", stop);
    this.el.addEventListener("pointercancel", stop);
  }

  private loop = () => {
    const targetX = (this.local.x + this.remote.x) / 2;
    const targetY = (this.local.y + this.remote.y) / 2;

    const ease = 0.18;
    this.displayed.x += (targetX - this.displayed.x) * ease;
    this.displayed.y += (targetY - this.displayed.y) * ease;

    this.el.style.left = `${this.displayed.x * 100}%`;
    this.el.style.top = `${this.displayed.y * 100}%`;

    this.raf = requestAnimationFrame(this.loop);
  };

  destroy() {
    cancelAnimationFrame(this.raf);
  }
}
