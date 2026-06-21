import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import mdx from 'fumadocs-mdx/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), mdx(), tanstackStart(), react()],
  resolve: {
    tsconfigPaths: true
  }
});
