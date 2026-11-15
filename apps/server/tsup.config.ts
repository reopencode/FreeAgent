import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/mcp-stdio.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  removeNodeProtocol: false,
  // Everything is bundled so the packaged desktop app can run the server without node_modules,
  // except Playwright, which ships browser assets and is copied next to the bundle instead.
  noExternal: [/^(?!playwright$|playwright-core$|playwright\/|playwright-core\/).+/],
  external: ['node:sqlite', 'playwright', 'playwright-core', 'chromium-bidi'],
  // The packaged app copies dist/ on its own, so it needs its own package.json to load as ESM.
  async onSuccess() {
    const { writeFileSync } = await import('node:fs')
    writeFileSync('dist/package.json', JSON.stringify({ type: 'module' }) + '\n')
  },
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  }
})
