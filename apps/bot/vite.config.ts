import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/main.ts"],
    outDir: "dist",
    clean: true,
    platform: "node",
    target: "node24",
    deps: { alwaysBundle: () => true, onlyBundle: false },
  },
});
