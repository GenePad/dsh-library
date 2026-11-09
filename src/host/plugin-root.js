// Runtime-resolved plugin source root: wherever this package actually lives
// (a `link:` checkout, a node_modules install, ...), so prompts can point the
// agent at the real source instead of a hardcoded path.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)) // <packageRoot>/src/host

export const PLUGIN_SOURCE_ROOT = path.resolve(here, '..', '..')
