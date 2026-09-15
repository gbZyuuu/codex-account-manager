# Documentation images

The panel, account rows, bars, management controls and composer quota button are
rendered directly from `payload/index.js`. `tests/readme-preview.html` supplies
fictional accounts through a renderer-only IPC fixture; it cannot authenticate,
switch accounts, spend resets or call the account service. The surrounding Codex
menu and composer are reconstructed fixtures, not captures of a live user session.

| File | View |
| --- | --- |
| `panel.png` | Account panel, 5-hour and weekly windows |
| `panel-weekly.png` | Account panel, weekly window only |
| `composer.png` | Menu closed, both windows, quota button hovered |
| `composer-weekly.png` | Menu closed, weekly only, quota button hovered |
| `manage.png` | Manage saved subscriptions |

The screenshots use a fixed clock, the America/Sao_Paulo timezone, English UI,
and 2× pixel density. The header sums both demo accounts; the composer shows
only the active account. A weekly-only response is demonstrated with a Pro
account, but the renderer does not infer missing limits from the plan name.

To regenerate, open `tests/readme-preview.html` in a **dedicated** headless
Chrome with a fresh temporary user-data directory and
`--remote-debugging-port=9240`, then run from the repository root:

```powershell
node tests/render-readme.cjs 9240
```

The renderer asserts the presence/absence of 5 h in both views and the hover
highlight before saving the five PNGs. It closes the dedicated browser when
finished. Inspect all five images visually before publishing. Never point it
at a personal browser session.
