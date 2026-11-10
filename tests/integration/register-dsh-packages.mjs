/**
 * Local ESM resolver for the integration harnesses.
 *
 * A DSH profile plugin resolves `@deepseek-ai/*` imports through the host
 * runtime, not through its own node_modules. This hook reproduces that mapping
 * outside dsh, so the harnesses exercise the same installation instances.
 *
 * Set DSH_PKG_ROOT to the `node_modules` directory of the dsh installation:
 *
 *   $root = npm root -g
 *   $env:DSH_PKG_ROOT = "$root\@deepseek-ai\dsh\node_modules"
 */
import fs from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const ROOT = String(process.env.DSH_PKG_ROOT ?? '').trim()
if (!ROOT) {
  throw new Error(
    'DSH_PKG_ROOT is not set. Point it at the node_modules directory of your dsh installation ' +
      '(the directory that contains @deepseek-ai/dsh-tools).',
  )
}

function packageEntry(specifier) {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = specifier.slice(name.length + 1)
  const dir = path.join(ROOT, name)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const exportsField = manifest.exports ?? {}
  const pick = (value) => (typeof value === 'string' ? value : value?.default)
  const target = subpath
    ? pick(exportsField[`./${subpath}`]) ?? `./${subpath}`
    : pick(exportsField['.']) ?? manifest.main
  if (!target) throw new Error(`no entry for ${specifier}`)
  return pathToFileURL(path.join(dir, target)).href
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return { url: packageEntry(specifier), shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
