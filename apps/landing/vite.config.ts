import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import mdx from 'fumadocs-mdx/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [mdx(), tanstackStart(), react()],
  resolve: {
    tsconfigPaths: true
  }
});
