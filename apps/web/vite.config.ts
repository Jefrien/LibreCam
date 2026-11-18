import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const workspace = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const { PORT } = loadEnv(mode, workspace, "PORT");
  const proxy = {
    "/api": {
      target: `http://127.0.0.1:${process.env.PORT ?? PORT ?? "3000"}`,
      ws: true,
    },
  };
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: { proxy },
    preview: { proxy },
  };
});
