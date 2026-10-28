import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { keysDir } from './store'
import { sshArgs, sshTool } from './git'

function exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) })
    })
  })
}

/** Locks a private key down to the current user — OpenSSH refuses keys others can read. */
async function restrictPermissions(file: string): Promise<void> {
  if (process.platform === 'win32') {
    await exec('icacls', [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`])
  } else fs.chmodSync(file, 0o600)
}

export interface KeyInfo {
  keyPath: string
  publicKey: string
  fingerprint: string
}

async function describe(keyPath: string): Promise<KeyInfo> {
  const publicKey = fs.readFileSync(keyPath + '.pub', 'utf8').trim()
  const fp = await exec(sshTool('ssh-keygen'), ['-lf', keyPath + '.pub'])
  return { keyPath, publicKey, fingerprint: fp.stdout.trim().split(' ')[1] ?? '' }
}

export async function generateKey(accountId: string, comment: string): Promise<KeyInfo> {
  const dir = path.join(keysDir(), accountId)
  fs.mkdirSync(dir, { recursive: true })
  const keyPath = path.join(dir, 'id_ed25519')
  for (const f of [keyPath, keyPath + '.pub']) fs.rmSync(f, { force: true })
  const r = await exec(sshTool('ssh-keygen'), ['-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath, '-q'])
  if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`)
  await restrictPermissions(keyPath)
  return describe(keyPath)
}

/** Copies an existing private key into the app's own key store. */
export async function importKey(accountId: string, sourcePath: string): Promise<KeyInfo> {
  // People often pick the .pub file; the private key sits next to it without the extension.
  if (sourcePath.toLowerCase().endsWith('.pub')) {
    const priv = sourcePath.slice(0, -4)
    if (!fs.existsSync(priv)) throw new Error(`${path.basename(sourcePath)} is a public key. Choose the private key file (same name without .pub).`)
    sourcePath = priv
  }
  const dir = path.join(keysDir(), accountId)
  fs.mkdirSync(dir, { recursive: true })
  const keyPath = path.join(dir, 'id_imported')
  fs.copyFileSync(sourcePath, keyPath)
  await restrictPermissions(keyPath)
  // Derive the public key from the private key so a missing/mismatched .pub can't bite us.
  const pub = await exec(sshTool('ssh-keygen'), ['-y', '-f', keyPath])
  if (pub.code !== 0) throw new Error(`Not a usable private key (passphrase-protected keys are not supported yet): ${pub.stderr}`)
  fs.writeFileSync(keyPath + '.pub', pub.stdout.trim() + '\n')
  return describe(keyPath)
}

export function deleteKeys(accountId: string): void {
  fs.rmSync(path.join(keysDir(), accountId), { recursive: true, force: true })
}

/** Runs `ssh -T git@github.com`; GitHub answers "Hi <login>!" when the key is accepted. */
export async function testGitHub(keyPath: string): Promise<{ ok: boolean; login: string | null; message: string }> {
  const r = await exec(sshTool('ssh'), [...sshArgs(keyPath), '-o', 'BatchMode=yes', '-T', 'git@github.com'])
  const message = (r.stderr + r.stdout).trim()
  const m = message.match(/Hi ([^!]+)!/)
  return { ok: !!m, login: m ? m[1] : null, message }
}
