# Labs Wallet — assets

Drop these files in before running `npm run build`. The packager will fail without them.

| File          | Used by         | Format                        |
|---------------|-----------------|-------------------------------|
| `icon.ico`    | Windows / NSIS  | 256×256 multi-res .ico        |
| `icon.icns`   | macOS / dmg     | .icns bundle                  |
| `icon.png`    | Linux / AppImage + Electron BrowserWindow | 512×512 PNG (square) |
| `logo.svg`    | About dialog / website download page | scalable mark |

Suggested workflow:
1. Design a 1024×1024 PNG of the Labs mark.
2. Convert with `electron-icon-builder` or `png2icons` to produce `.ico` and `.icns`.
3. Drop all four files in this folder.

Until icons exist, `npm start` (dev mode) still works — Electron just shows the default icon.
