import fs from 'node:fs'
import path from 'node:path'

const SKIP = new Set(['node_modules', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', 'target', '.next', '.cache', '.gradle', '.idea', 'Pods', '$RECYCLE.BIN', 'System Volume Information'])

/** Finds git working trees under `root`. Does not descend into a repo once found (skips submodules/nested clones). */
export async function findRepos(root: string, maxDepth = 6): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.name === '.git')) {
      found.push(dir)
      return
    }
    if (depth >= maxDepth) return
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name) && !e.name.startsWith('.'))
        .map((e) => walk(path.join(dir, e.name), depth + 1))
    )
  }
  await walk(root, 0)
  return found.sort((a, b) => a.localeCompare(b))
}
