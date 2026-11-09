// Rebuild the prebuilt Word template:  node tools/rebuild-word-template.mjs
//
// assets/word/DshLibrary.dotm ships compiled VBA (word/vbaProject.bin), so
// editing the .bas files or customUI.xml is NOT enough — the template has to
// be regenerated through Word COM (import modules -> SaveAs2(15) ->
// injectCustomUI -> inspectTemplate) or installs would keep the old Ribbon.
// Word must not be running while this script executes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWordInstaller } from '../src/host/office/installer.js'
import { safeRemoveTree } from '../src/host/util.js'

const exec = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(here, '..')
const target = path.join(packageDir, 'assets', 'word', 'DshLibrary.dotm')

// Cheap VBA lint catching the mistakes that actually bit us: wrong argument
// counts on our own helpers and module-level declarations placed after a
// procedure (VBA rejects anything but comments there). A failure here aborts
// the rebuild BEFORE Word imports a broken module and pops a compile dialog.
function lintVba(source, file) {
  const problems = []
  // DshLibAgentGetStr/GetLong take exactly (args, key, default).
  for (const match of source.matchAll(/DshLibAgentGet(Str|Long)\(([^()]*)\)/g)) {
    const depth = match[2].split(',').length
    if (depth !== 3) problems.push(`${file}: DshLibAgentGet${match[1]} needs 3 args: ${match[0].slice(0, 80)}`)
  }
  // Module-level Dim/Private declarations must precede the first procedure.
  // Procedure-local Dims are indented in our codebase; module-level ones are
  // always at column 0, so test the RAW line.
  const lines = source.split(/\r?\n/)
  let seenProcedure = false
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (/^(Public |Private |Friend )?(Sub|Function) [A-Za-z_]/.test(trimmed) && !/Declare/.test(trimmed)) seenProcedure = true
    if (seenProcedure
      && /^(Private |Public |Dim )[A-Za-z_][A-Za-z0-9_]* As (Long|LongPtr|String|Boolean|Date|Object|Variant)\b/.test(line)) {
      problems.push(`${file}:${index + 1}: module-level declaration after a procedure: ${trimmed.slice(0, 80)}`)
    }
  })
  return problems
}

async function main() {
  try {
    const { stdout } = await exec('tasklist.exe', ['/FI', 'IMAGENAME eq WINWORD.EXE', '/FO', 'CSV', '/NH'])
    if (/WINWORD\.EXE/i.test(stdout)) {
      console.error('Word 正在运行。请先完全退出 Word（包括后台进程）再重建模板。')
      process.exit(1)
    }
  } catch { /* tasklist unavailable: let the COM step report failures */ }

  const vbaDir = path.join(packageDir, 'assets', 'word', 'vba')
  const lintProblems = []
  for (const name of fs.readdirSync(vbaDir)) {
    if (name.endsWith('.bas')) lintProblems.push(...lintVba(fs.readFileSync(path.join(vbaDir, name), 'utf8'), name))
  }
  if (lintProblems.length > 0) {
    console.error('VBA lint 未通过（未重建）：')
    for (const problem of lintProblems) console.error('  ' + problem)
    process.exit(1)
  }

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dotm-'))
  const installer = createWordInstaller({ packageDir, home: buildDir, version: '0.0.0-rebuild' })
  try {
    const report = await installer.buildTemplate(path.join(buildDir, 'DshLibrary.dotm'))
    fs.copyFileSync(path.join(buildDir, 'DshLibrary.dotm'), target)
    console.log(`OK ${path.relative(packageDir, target)} (${fs.statSync(target).size} bytes)`)
    console.log(`modules: ${report.modules.join(', ')}`)
    console.log(`icons: ${report.images.join(', ')}`)
  } finally {
    safeRemoveTree(buildDir)
  }
}

main().catch(error => {
  console.error(error?.message ?? error)
  process.exit(1)
})
