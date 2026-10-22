# Third-party assets bundled in the web app

These ship inside `dist/web` (bundled by Vite at build time). Everything else is a normal npm
dependency listed in `package-lock.json`.

| Asset | Package | Licence |
|---|---|---|
| Icons (Lucide) | `lucide-react` | ISC |
| Big Shoulders Display (800, 900) | `@fontsource/big-shoulders-display` | SIL Open Font License 1.1 |
| IBM Plex Mono (500, 600) | `@fontsource/ibm-plex-mono` | SIL Open Font License 1.1 |
| Figtree (400, 600, 700) | `@fontsource/figtree` | SIL Open Font License 1.1 |

The fonts are served from the app itself (no font CDN). The licence texts are in each package's
`LICENSE` file under `node_modules/@fontsource/*/` and `node_modules/lucide-react/`.
