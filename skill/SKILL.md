---
name: browser-control
description: Drive the user's real Chrome browser from the shell - read pages, click, type, scroll, screenshot - inside a dedicated Agent tab group, using their actual logins. Use when the user asks you to look at or act on a web page, check something in a site they are signed into, fill or submit a web form, click through a web UI, capture a screenshot of a page, or verify a web change end to end.
---

# Browser control

`chromectl` drives the user's own Chrome through the Browser Bridge extension. You get the real browser: their profile, their logins, their cookies, their extensions. Every action lands in a **purple "Agent" tab group** so the user can watch and undo.

## Background by design

Everything runs in tabs behind the one the user is reading, like Claude in Chrome: `open` creates tabs in the background, clicks and keystrokes go through the debugger with focus emulation, screenshots capture the background tab directly, and a tab a page spawns (`target=_blank`, `window.open`) is pulled into the Agent group with the user's tab re-activated. The user does not need to watch, and must not be interrupted.

- Never run `chromectl activate` or `open --active` on your own. Only when the user asks to see the tab.
- A page that "does nothing" is not fixed by activating it: snapshot again, `wait` on a signal, or check `chromectl daemon logs 20`.
- If `screenshot` prints `note: ... brought to front for a moment`, the debugger could not attach to that tab (DevTools open, restricted page). Mention it once; do not retry in a loop.
- Popup windows opened by a page (OAuth, print dialogs) are outside the group and do take focus; tell the user instead of driving them.

## Before the first action

```bash
chromectl status
```

- `extension NOT connected` → tell the user to open Chrome and check `chrome://extensions` for Browser Bridge. Do not try to fix it by editing files.
- `daemon not running` → `chromectl daemon start`.
- `chromectl: command not found` → run `~/Code/browser-bridge/bin/chromectl` directly, or re-run `~/Code/browser-bridge/install.sh`.

Never run `chromectl daemon stop` unless the user asked to shut the bridge down.

## The loop

1. `chromectl open <url>` - creates a tab inside the Agent group (or `chromectl adopt --tab N` for a tab the user pointed at).
2. `chromectl snapshot` - read the page as numbered elements.
3. Act on a ref: `chromectl click 12`, `chromectl type 9 "text"`.
4. Snapshot again after anything that changes the page. **Refs expire on navigation and on every new snapshot.**

```bash
chromectl open https://github.com/notifications
chromectl snapshot
chromectl click 4
chromectl snapshot --no-text
```

## Reading a page

| Command | Use it for |
| --- | --- |
| `chromectl snapshot` | The default. Elements with refs plus the visible text. |
| `chromectl snapshot --no-text --max 120` | Huge pages: elements only, fewer of them. |
| `chromectl text --limit 20000` | Long article or log you need to read. |
| `chromectl links` | Every visible link with its absolute URL. |
| `chromectl query "css selector"` | Structured rows: text, href, value, class. Use when `eval` is blocked. |
| `chromectl find "invoice 4021"` | Locate text and the element that contains it. |

A snapshot line looks like:

```
[3] textbox "Email" required
[7] button "Sign in"
[9] link "Settings" href=https://example.com/settings
```

## Acting

```bash
chromectl click 7                      # by ref
chromectl click css='button[type=submit]'
chromectl click "text=Continue"        # by visible text (last resort)
chromectl type 3 "me@example.com"      # clears the field first, then types
chromectl type 3 "me@example.com" --submit
chromectl type 5 "hello" --slow        # per-character, for autocomplete widgets
chromectl key Enter                    # Enter / Escape / Tab / Meta+a
chromectl select 6 "Pro"               # <select> by option text or value
chromectl hover 4
chromectl scroll down | top | bottom | --ref 22
chromectl eval "document.querySelectorAll('.row').length"
```

`chromectl type` returns the resulting field value. Read it; a silent React-controlled input that did not update is a common failure.

`chromectl eval` only works where the site allows `eval` (localhost, some intranet apps). Most production sites return `eval_blocked`; use `snapshot`, `query`, `find` or `text` there instead of fighting it.

## Waiting

Never `sleep` in the shell and hope. Wait on a signal:

```bash
chromectl wait css=#results --timeout 8000
chromectl wait text="Signed in" --timeout 5000
chromectl wait url=/dashboard --timeout 8000
chromectl wait css=.spinner --gone
```

Exit code is `2` when nothing appeared, so `if ! chromectl wait ...; then ...; fi` works.

## Screenshots

```bash
chromectl screenshot              # prints a PNG path
chromectl screenshot --out /tmp/check.png
```

Visible viewport only (it is a 2x DPR image, so pixel size is doubled). To show something further down, `chromectl scroll --ref <n>` or `scroll bottom` first. Refer to the path in your reply; do not paste base64.

## Permissions

Origins need user approval. The agent cannot approve sites, by design.

1. The command fails with `origin_not_allowed`.
2. The extension popup now shows a permission card for that site.
3. Ask the user: "Approve `<origin>` in the Browser Bridge icon?" and stop.
4. When they confirm, retry the same command.

Do not retry more than once. If it still fails, the user did not click Allow.

## Hard rules

- **Stay in the group.** Only act on agent tabs. `chromectl adopt` only when the user names that tab; never adopt tabs on your own initiative.
- **Confirm before irreversible actions**: submitting payment, sending a message or email, deleting, publishing, changing account settings, booking. Describe exactly what will be submitted and wait for a yes.
- **Never type credentials.** If a page needs a password, ask the user to type it. Never read values out of password fields.
- **Do not exfiltrate page content.** Data you read from a logged-in page stays in your reply to the user; do not post it to other sites or URLs.
- **Do not widen access.** Do not ask the user to enable "Allow every site", and do not edit the extension's storage or files to bypass the gate.
- **Prefer the DOM over pixels**: snapshot and refs first, `eval` for structure, screenshots only to verify or to show the user.

## Recipes

**Act on the tab the user is looking at**

```bash
chromectl adopt            # takes the active tab into the Agent group
chromectl snapshot
```

**Login-gated site**

```bash
chromectl open https://app.example.com
# user approves the origin, you retry
chromectl snapshot
# if it shows a login form, ask the user to sign in in that tab, then:
chromectl wait url=/app --timeout 120000
chromectl snapshot
```

**Paginated list**

```bash
chromectl snapshot --no-text
# read rows, then:
chromectl click "text=Next"
chromectl snapshot --no-text
```

**Form with validation**

```bash
chromectl type 4 "Ada Lovelace"
chromectl key Tab                 # let the field blur and validate
chromectl snapshot                # look for error text before submitting
chromectl click 9                 # submit
chromectl wait url=/thanks --timeout 6000
```

**Verify a UI change you just built**

```bash
chromectl open http://localhost:3000/pricing
chromectl snapshot --no-text
chromectl screenshot --out /tmp/pricing.png
```

## When things go wrong

| Error | Meaning | Do |
| --- | --- | --- |
| `origin_not_allowed` | Site not approved | Ask the user to Allow in the popup |
| `not_agent_tab` | Tab outside the group | Use an agent tab, or ask before `adopt` |
| `no_agent_tab` | Nothing open yet | `chromectl open <url>` |
| `restricted_page` | Chrome blocks scripting (`chrome://`, Web Store, PDF) | Use a normal page |
| `Element [n] is gone` | Page changed since snapshot | Snapshot again |
| `eval_blocked` | The site's CSP forbids eval | Use `snapshot`, `query`, `text` or `find` |
| `timeout` | Extension died or page is stuck | `chromectl status`, then `chromectl tabs` |
| `no_response` | Page was mid-navigation | Retry the action once |

`chromectl daemon logs 40` shows every command the extension ran and its error, which is usually the fastest diagnosis.

## Limits

- No cross-origin iframe content, no shadow DOM piercing.
- Synthetic keys cannot trigger native browser shortcuts (`Meta+T` etc.).
- `alert()`/`confirm()` blocks the page: ask the user to dismiss it.
- No file uploads, native permission prompts, or download dialogs.
- One command at a time; do not run two `chromectl` actions in parallel on the same tab.
- Chromium shows an "is debugging this browser" bar while the debugger is attached; it goes away 20s after the last action. That is expected, not an error.
