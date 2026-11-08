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

async function main() {
  try {
    const { stdout } = await exec('tasklist.exe', ['/FI', 'IMAGENAME eq WINWORD.EXE', '/FO', 'CSV', '/NH'])
    if (/WINWORD\.EXE/i.test(stdout)) {
      console.error('Word 正在运行。请先完全退出 Word（包括后台进程）再重建模板。')
      process.exit(1)
    }
  } catch { /* tasklist unavailable: let the COM step report failures */ }

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
