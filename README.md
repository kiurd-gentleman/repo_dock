<p align="center">
  <img src="build/icon.svg" width="96" alt="RepoDock logo" />
</p>

<h1 align="center">RepoDock</h1>

<p align="center">
  A desktop app for managing all your git repositories, across multiple GitHub accounts, from one place.<br/>
  Each account uses its own SSH key or token, so pushes always go out as the right person.
</p>

---

## ✨ Features

- **Add repos your way.** Add a single repo, or import a folder and RepoDock finds every git repo inside it.
- **Groups.** Organize repos into colored groups (drag and drop). You can move or update many repos at once.
- **Overview dashboard.** See every repo's branch, uncommitted changes, ahead/behind counts and owning account at a glance.
- **Changes.** Stage, unstage, discard, view diffs, commit (or amend), and use Commit & Push.
- **History.** Commit graph with branches and tags, author avatars, "not pushed" markers and per-file diffs.
- **Branches & stash.** Create, switch, merge and delete branches (local and remote). Save, pop, apply and drop stashes.
- **GitHub.** Pull requests, issues, comments, GitHub Actions runs and logs (re-run, cancel, dispatch), and repo settings. You can also create, publish, clone and delete repos.
- **Multiple accounts.** Each account has its own SSH key or token. RepoDock detects which account a repo belongs to from its remote, and you can override it per repo.
- **Your setup stays untouched.** RepoDock never edits `~/.ssh`, your global git config or a repo's config. Credentials are passed to each git command only while it runs.

---

## 📦 Installation

RepoDock runs on **Windows**, **macOS** and **Linux**. The only requirement is **Git**:

| System | Install Git |
|--------|-------------|
| Windows | [Git for Windows](https://git-scm.com/download/win). RepoDock also uses its bundled `ssh` and `ssh-keygen`. |
| macOS | Run `xcode-select --install`, or `brew install git` |
| Linux | `sudo apt install git openssh-client` (or your distro's equivalent) |

### Option 1: Download (recommended)

Get the latest version from the **[Releases page](https://github.com/kiurd-gentleman/repo_dock/releases/latest)**:

| System | Download | How to install |
|--------|----------|----------------|
| **Windows** 10/11 | `RepoDock-Setup-x.y.z.exe` | Run it and follow the installer. |
| **macOS** Apple Silicon (M1–M4) | `RepoDock-x.y.z-mac-arm64.dmg` | Open it and drag RepoDock to **Applications**. |
| **macOS** Intel | `RepoDock-x.y.z-mac-x64.dmg` | Same as above. |
| **Linux** (any distro) | `RepoDock-x.y.z-linux-x86_64.AppImage` | `chmod +x RepoDock-*.AppImage`, then run it. |
| **Linux** Debian/Ubuntu | `RepoDock-x.y.z-linux-amd64.deb` | `sudo apt install ./RepoDock-*.deb` |

<details>
<summary>⚠️ First launch: "unknown publisher" / "app is damaged" / "can't be opened"</summary>

The installers are not code-signed yet, so each system warns once:

- **Windows:** SmartScreen says *"Windows protected your PC"*. Click **More info → Run anyway**.
- **macOS:** if you see *"RepoDock is damaged"* or *"cannot be opened"*, run this once in Terminal, then open the app again:
  ```bash
  xattr -cr /Applications/RepoDock.app
  ```
- **Linux (AppImage):** if it doesn't start, install FUSE: `sudo apt install libfuse2`.
</details>

### Option 2: Build it yourself

Install **Git** (see above) and **Node.js** 20.19+ or 22.12+ ([nodejs.org](https://nodejs.org)), then:

```bash
git clone https://github.com/kiurd-gentleman/repo_dock.git
cd repo_dock
npm install
npm run dev
```

> **Windows PowerShell** says *"running scripts is disabled"*? Use `npm.cmd` instead of `npm`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

<details>
<summary>⚠️ Seeing <code>Electron failed to install correctly</code>?</summary>

Some npm setups skip Electron's download step. Run it manually:

```bash
node node_modules/electron/install.js
```
</details>

To build an installer for the system you're on:

```bash
npm run dist          # current system
npm run dist:win      # Windows .exe
npm run dist:mac      # macOS .dmg (must run on a Mac)
npm run dist:linux    # Linux AppImage + .deb
```

Installers are written to `dist/`.

### Publishing a release (maintainers)

Push a version tag. GitHub Actions builds Windows, macOS and Linux installers and publishes them as a GitHub Release:

```bash
npm version patch          # bumps package.json and creates the tag, e.g. v0.1.1
git push --follow-tags
```

---

## 🚀 Getting started

### 1. Add a GitHub account

Open **Accounts → Add account** and choose how the account signs in:

| Method | What you need | Best for |
|--------|---------------|----------|
| **SSH (automatic)** | A token | RepoDock generates a key and uploads it to GitHub for you. Easiest. |
| **SSH (manual)** | Nothing | RepoDock generates a key, and you paste the public key into GitHub → Settings → SSH keys. |
| **Token (HTTPS)** | A token | Using HTTPS only, without SSH keys. |

You can also **import an existing private key** instead of generating one. Choosing the `.pub` file works too; RepoDock uses the private key next to it.

**Creating a token.** Use the link in the form, or go to GitHub → Settings → Developer settings → **Personal access tokens (classic)**, and select these scopes:

`repo` · `workflow` · `admin:public_key` · `read:org` · `delete_repo` (optional)

> Create the token while signed in to GitHub as **that** account. A token from one account cannot manage another account's keys or repos.

After adding the account, click **Test SSH** on its card. It should say *"SSH works: GitHub says you are &lt;login&gt;"*.

### 2. Add your repositories

- **+ Add repo** adds one folder that is already a git repo.
- **Import folder** scans a folder (and its subfolders) and adds every repo it finds. Folders that are already added are skipped.
- **GitHub repos** browses an account's repos on GitHub and clones them straight into a group.

### 3. Work

Click a repo to open its tabs: **Changes**, **History**, **Branches & stash**, **Pull requests**, **Issues**, **Actions** and **Settings**. The account shown in the repo header is the one used for fetch, pull and push. Change it there if needed.

### 4. Let your AI tools use RepoDock (MCP server)

RepoDock has a built-in **MCP server**. Open **AI agents** in the sidebar:

1. **Add the MCP server to your AI tools.** Click **Connect** next to Claude Code, Claude Desktop, Cursor, VS Code (Copilot), Windsurf, Codex CLI or Gemini CLI, then restart that tool. For other tools, copy the config shown under **Other MCP tool**.
2. **Choose what needs your approval.** The choices are before push and pull requests (default), before any change, or never. Force-push always asks. Approval requests pop up in RepoDock with the branch, commits and account. Press Enter to allow or Esc to deny.

Then just ask your AI: *"commit and push my changes"*, *"open a pull request"* or *"is CI passing?"* Every call uses the right GitHub account, and the AI never sees your keys or tokens. Everything is listed under **Activity**.

<details>
<summary>Advanced: AI tools that run <code>git</code> themselves</summary>

Turn this on for a repo, and any plain `git push` or `git pull` (from a terminal, an IDE or an AI tool without MCP) authenticates as that repo's account too. RepoDock adds one `include` line to the repo's `.git/config` and removes it when you turn the option off.
</details>

---

## 🔒 Security

- **Tokens** are encrypted with the OS keychain (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux) and are never saved as plain text.
- **SSH private keys** are stored in the app's data folder and are readable only by your user account.
- RepoDock **never modifies** `~/.ssh` or `~/.gitconfig`, and changes a repo's `.git/config` only if you turn on the optional plain-git link. Otherwise authentication is passed to each git command through environment variables only.
- Tokens embedded in remote URLs (`https://ghp_…@github.com/…`) are hidden in the UI and in error messages.

App data location (settings, keys, known_hosts):
- Windows: `%APPDATA%\repodock\`
- macOS: `~/Library/Application Support/repodock/`
- Linux: `~/.config/repodock/`

---

## 🛠 Troubleshooting

| Problem | Fix |
|---------|-----|
| `The token was rejected (wrong, expired or revoked)` | Create a new token and paste it again in **Accounts**. |
| `This SSH key is already registered on a different GitHub account` | GitHub allows a key on only one account. Generate a new key for this account. |
| `Permission denied (publickey)` | The key isn't on GitHub, or it belongs to another user. Run **Test SSH** on the account. |
| `could not read Password for 'https://…'` | The repo is linked to the wrong account, or to none. Pick the right account in the repo header. |
| `not a git repository` | The folder has no `.git`. Use **Import folder** to scan inside it instead. |
| The window looks out of date after an update | Press **Ctrl + R** (**⌘ + R** on macOS) to reload. |

---

## 🧑‍💻 Development

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode with hot reload. The backend restarts on change. |
| `npm run build` | Build the app into `out/` |
| `npm start` | Run the built app |
| `npm run typecheck` | Type-check all TypeScript |
| `npm run dist` | Build installers for the current system into `dist/` (`dist:win`, `dist:mac`, `dist:linux` for a specific one) |
| `npm run icons` | Regenerate the app icons from `build/icon.svg` |

**Stack:** Electron · React · TypeScript · electron-vite · electron-builder

```
src/
├─ main/       Electron main process: git, ssh, GitHub API, storage
├─ preload/    Safe bridge between the main process and the UI
├─ renderer/   React UI
└─ shared/     Types shared by both sides
```
