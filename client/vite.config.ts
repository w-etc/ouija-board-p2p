import { defineConfig } from "vite";

// GitHub Pages serves this as a project site — https://w-etc.github.io/ouija-board-p2p/
// — so production builds need every asset URL prefixed with that subpath. Local dev
// stays at the root so `npm run dev` URLs don't change.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/ouija-board-p2p/" : "/",
  server: {
    port: 5173,
  },
}));
