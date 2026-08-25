import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served from https://digit-software.app/cutting/app/ via cPanel Git
  // Version Control (deploy branch, static output only) — matches the
  // sub-path pattern the other modules (rma, ai-brain) use on that domain.
  base: "/cutting/app/",
  plugins: [react()],
  server: {
    // host 0.0.0.0 so the dev server is reachable from outside the container
    host: true,
    port: 3000,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 3000,
    strictPort: true,
  },
});
