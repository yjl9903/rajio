import { defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'rajio',
    compatibilityDate: '2026-06-21',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: '@tanstack/react-start/server-entry',
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: true
    }
  }
});
