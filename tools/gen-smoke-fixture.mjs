// Regenerates scripts/fixtures-smoke.pdf: a minimal two-page PDF whose first
// page carries one internal GoTo link (→ page 2) and one external URI link, so
// client-smoke can exercise the viewer's hyperlink layer deterministically.
// Run: node tools/gen-smoke-fixture.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bodies = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [7 0 R 8 0 R] >>',
  stream('BT /F1 18 Tf 72 720 Td (dsh-zot-library smoke page) Tj ET\nBT /F1 14 Tf 72 690 Td (Go to page two) Tj ET'),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 9 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  '<< /Type /Annot /Subtype /Link /Rect [70 684 210 702] /Border [0 0 0] /Dest [6 0 R /XYZ null null null] >>',
  '<< /Type /Annot /Subtype /Link /Rect [70 714 320 736] /Border [0 0 0] /A << /S /URI /URI (https://example.org/dsh-zot-library-smoke) >> >>',
  stream('BT /F1 18 Tf 72 720 Td (smoke page two) Tj ET'),
]

function stream(text) {
  return `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
}

const chunks = ['%PDF-1.4\n']
const offsets = []
for (let i = 0; i < bodies.length; i += 1) {
  offsets.push(chunks.join('').length)
  chunks.push(`${i + 1} 0 obj\n${bodies[i]}\nendobj\n`)
}
const xrefOffset = chunks.join('').length
let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
xref += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
chunks.push(xref)

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fixtures-smoke.pdf')
fs.writeFileSync(target, chunks.join(''), 'latin1')
console.log(`fixtures-smoke.pdf written (${chunks.join('').length} bytes)`)
