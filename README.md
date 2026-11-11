<h1 align="center">Browser Bridge</h1>

<p align="center">
  <b>Your own Chrome, driven by a terminal agent.</b><br>
  Real profile, real logins, a tab group you can watch and undo.
</p>

<p align="center">
  <a href="https://discord.gg/bUadyRwkJS"><img alt="Discord" src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white"></a>
  <a href="https://ko-fi.com/ghosty99"><img alt="Ko-fi" src="https://img.shields.io/badge/Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white"></a>
  <a href="https://etherscan.io/address/0xbBef115aD853236a350EaF04777a2AdB2e7c0317"><img alt="ETH" src="https://img.shields.io/badge/ETH-627EEA?style=for-the-badge&logo=ethereum&logoColor=white"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-3ddc97?style=for-the-badge"></a>
</p>

<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="Browser Bridge: a purple bridge between a terminal and a browser window">
</p>

A Chrome extension plus a local daemon that lets a terminal AI agent (Claude Code, opencode, or anything that can run a shell command) drive your real browser: open a tab group, read pages, click, type, scroll, screenshot.

It is the same idea as Claude in Chrome, but the agent talks to Chrome over `chromectl` instead of a chat sidebar, so any CLI agent can use it.

**Repository:** [github.com/ghostyshell/browser-bridge](https://github.com/ghostyshell/browser-bridge)

```
  agent (you / Claude Code / opencode)
      │  chromectl snapshot | click | type ...
      ▼
  daemon  127.0.0.1:8737          ~/.config/browser-bridge/
      │  websocket (ping every 20s keeps the MV3 worker alive)
      ▼
  Chrome extension  ──►  your profile, your logins, your session
      │
      ▼
  tab group "Agent"   ──►  only tabs the agent created or adopted
```

## Why an extension instead of DevTools Protocol

Chrome 136+ refuses `--remote-debugging-port` on your default profile, so CDP cannot reach the browser you actually use. An extension runs inside that profile with your sessions, and a tiny native-free websocket relay gives the agent access. Nothing is exposed to the network: the daemon binds `127.0.0.1` only.

## What it can do

| Action | Command |
| --- | --- |
| Open a page in the agent tab group | `chromectl open <url>` |
| Take over a tab you already have open | `chromectl adopt --tab <id>` |
| Snapshot the page as numbered, actionable elements | `chromectl snapshot` |
| Read visible text / links | `chromectl text`, `chromectl links` |
| Query a selector structurally | `chromectl query "span.titleline > a"` |
| Click | `chromectl click 12` |
| Type, optionally submit | `chromectl type 3 "hello" --submit` |
| Keys | `chromectl key Enter`, `chromectl key Meta+a` |
| Scroll | `chromectl scroll down`, `chromectl scroll --ref 12` |
| Wait for something | `chromectl wait css=#results --timeout 8000` |
| Screenshot | `chromectl screenshot` |
| Run JS in the page | `chromectl eval "document.title"` |

Full reference: `chromectl help`.

## Install

```bash
cd ~/Code/browser-bridge
./install.sh
```

That installs the daemon dependencies, links `chromectl` into `~/.local/bin`, links the skill into `~/.claude/skills` and `~/.config/opencode/skills`, and starts the daemon.

Then load the extension once:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select `~/Code/browser-bridge/extension`
4. Pin "Browser Bridge" to the toolbar

The badge turns into a purple dot when the agent is connected.

## Permission model

The agent can only touch tabs in its own **Agent** tab group, and only on origins you approved. Approval happens in the extension popup, which the agent cannot click:

1. The agent asks for a site (for example `chromectl open github.com`)
2. The command fails with `origin_not_allowed` and the popup gets a request card
3. You press **Allow this site** (or **Block**)
4. The agent retries

`Allow every site` skips the prompt. Use it only when you are watching.

The gate is enforced in the extension, not the CLI, so an agent cannot grant itself access by running another shell command.

## The snapshot

`chromectl snapshot` turns the page into lines an LLM can reason about:

```
Bridge fixture
http://127.0.0.1:8899/fixture.html
viewport 1200x728 @ 0% (scrollY 0/728)  ·  9 elements  ·  1 forms, 0 iframes

[0] heading1 "Bridge fixture"
[1] link "Go to page two" href=http://127.0.0.1:8899/page2.html
[2] textbox "Your name"
[3] combobox "Plan" value="Free"
[4] checkbox "I agree to the terms" unchecked
[5] button "Say hello"
[6] button "Reveal (slow)"
[7] textbox "Edit me" value="Edit me"
[8] button "Clicked 0"
```

Refs are written onto the DOM as `data-bb-ref` when you snapshot. They are valid until the next snapshot or a navigation, which is why the agent should snapshot again after anything that changes the page.

## Commands worth knowing

```bash
chromectl status                  # daemon, extension, agent tabs, approvals
chromectl tabs                    # agent tabs (--all for every tab)
chromectl policy                  # what is approved
chromectl request https://x.com   # ask for a site without running an action
chromectl reset                   # close every agent tab
chromectl daemon logs 60          # last 60 daemon log lines
chromectl daemon stop             # hard stop
```

Flags: `--tab N` to target a specific agent tab, `--json` for raw output.

## Limits (by design)

- Screenshots are the visible viewport, not full page.
- Cross-origin iframes are not traversed; same-page shadow DOM is not traversed.
- Synthetic keys cannot trigger native browser shortcuts. `Meta/Ctrl+A`, `Tab`, `Enter` and `Escape` are handled explicitly.
- `chromectl eval` needs `eval` to be allowed by the site. Sites with a strict Content-Security-Policy (most production apps) block it, and you get `eval_blocked`; use `snapshot`, `query`, `text` or `find` there.
- `alert()` / `confirm()` block the page and will time out the command. Close the dialog in the browser.
- File upload pickers, native downloads and permission prompts need a human.
- Chrome pages (`chrome://`, the Web Store, PDF viewer) cannot be scripted.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `extension_not_connected` | Chrome closed, or the extension is disabled. Check the popup badge. |
| Badge is empty | Daemon not running: `chromectl daemon start`. |
| `origin_not_allowed` | Approve the site in the popup. |
| `not_agent_tab` | The tab is outside the group. Use `chromectl adopt --tab N` if that is intended. |
| `restricted_page` | Chrome will not script that URL. Use a normal http(s) page. |
| Commands hang | `chromectl daemon logs` and check the extension is enabled. |

Logs: `~/.config/browser-bridge/daemon.log`. Screenshots land in `~/.config/browser-bridge/shots/`.

## Tests

`scripts/dev-chrome.sh` launches a throwaway Chrome profile with the extension installed over CDP, so you can exercise the whole path without touching your real browser:

```bash
scripts/dev-chrome.sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8899/fixture.html  # needs a server
chromectl open http://127.0.0.1:8899/fixture.html
```

The extension is installed via `Extensions.loadUnpacked` because Chrome 137+ ignores `--load-extension`.

## Support

MIT, no paid tier, no telemetry, no account.

- **Discord:** https://discord.gg/bUadyRwkJS
- **Ko-fi:** https://ko-fi.com/ghosty99
- **Ethereum:** `0xbBef115aD853236a350EaF04777a2AdB2e7c0317` ([Etherscan](https://etherscan.io/address/0xbBef115aD853236a350EaF04777a2AdB2e7c0317))

## Attribution

Written by [ghost](https://github.com/ghostyshell). The extension, daemon and CLI are original work; the RPC shape and snapshot format were informed by Claude in Chrome's interaction model. Icons are generated by `scripts/make-icons.py`.

If you build on it, keep the MIT notice and link back here.

## Uninstall

```bash
chromectl daemon stop
rm ~/.local/bin/chromectl
rm ~/.claude/skills/browser-control ~/.config/opencode/skills/browser-control
rm -rf ~/.config/browser-bridge
```

Then remove the extension from `chrome://extensions`.
