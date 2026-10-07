import { cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts'
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  hooks: {
    'build:done': async () => {
      const skillsDir = resolve(import.meta.dirname, 'skills');
      await rm(skillsDir, { recursive: true, force: true });
      await cp(resolve(import.meta.dirname, '../../skills/rajio'), resolve(skillsDir, 'rajio'), {
        recursive: true
      });
    }
  }
});
