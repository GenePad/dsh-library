// Builds client.js, the browser half, from src/client (esbuild).
//
//   node tools/build-client.mjs           writes client.js
//   node tools/build-client.mjs --check   exits 1 when client.js differs from a fresh build
//
// dsh loads client.js as a classic script; the wrapper mirrors the harness's
// client module system: `require` resolves the shell-seeded platform modules,
// which therefore stay external.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(PLUGIN, 'client.js')
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

export async function bundleClient() {
  // The in-app PDF viewer runs pdf.js in MAIN-THREAD mode: the viewer module
  // registers pdfjs-dist's WorkerMessageHandler on `globalThis.pdfjsWorker`,
  // so no engine worker needs embedding here.
  const result = await build({
    absWorkingDir: PLUGIN,
    entryPoints: ['src/client/index.js'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: PLATFORM_MODULES,
    treeShaking: false,
    minify: true,
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  })
  const mainWarnings = result.warnings.filter(warning => !/import\.meta/.test(warning.text))
  if (mainWarnings.length > 0) throw new Error(`esbuild warnings:\n${mainWarnings.map(warning => warning.text).join('\n')}`)
  return [
    '// Generated from src/client by `npm run build` (tools/build-client.mjs). Do not edit by hand.',
    'window.__ModuleLoader__.load({',
    "  id: 'dsh-library',",
    '  factory: (require) => {',
    'const module = { exports: {} }',
    result.outputFiles[0].text.trimEnd(),
    // A plain exports object tagged as a module, matching the tsdown preset.
    "return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })",
    '  },',
    '})',
    '',
  ].join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await bundleClient()
  if (process.argv.includes('--check')) {
    let current = null
    try {
      current = readFileSync(OUTPUT, 'utf8')
    } catch {
      // A missing bundle counts as stale.
    }
    if (current !== next) {
      console.error('client.js is stale: run `npm run build`')
      process.exit(1)
    }
  } else {
    writeFileSync(OUTPUT, next)
    console.log(`client.js written (${next.length} bytes)`)
  }
}
