// Debug helper: unminified client bundle for readable smoke stacks (not shipped).
import { writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const result = await build({
  absWorkingDir: process.cwd(),
  entryPoints: ['src/client/index.js'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'],
  treeShaking: false,
  charset: 'utf8',
  write: false,
  logLevel: 'silent',
})
const worker = globalThis.__W__ ?? "''"
writeFileSync('client.debug.js', 'window.__ModuleLoader__.load({id:"dsh-library",factory:(require)=>{const module={exports:{}};\n'
  + 'window.__DSH_LIBRARY_PDF_WORKER__=' + JSON.stringify(worker) + ';\n'
  + result.outputFiles[0].text + '\nreturn Object.defineProperty({...module.exports},Symbol.toStringTag,{value:"Module"})}})')
console.log('client.debug.js written')
