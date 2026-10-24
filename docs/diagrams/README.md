# Diagrams

Every architecture picture in the docs is written as [Mermaid](https://mermaid.js.org/) source in
this folder (`<name>.mmd`) and rendered to SVG in [`../images/architecture/`](../images/architecture/).
The SVGs are what README.md, [architecture.md](../architecture.md) and [gemma.md](../gemma.md)
embed, so they show on GitHub, in an editor preview and offline. Edit the `.mmd`, render again,
and commit both.

| Source | Image | Shows |
|---|---|---|
| `system-context.mmd` | `system-context.svg` | The household, the phone, the app, Gemma and Open-Meteo, in home mode and in hosted mode |
| `runtime-architecture.mmd` | `runtime-architecture.svg` | The home-mode process: guard, API, ledger, domain code, job runner, `ModelClient`, weather service, scheduler, data folder |
| `gemma-architecture.mmd` | `gemma-architecture.svg` | How Gemma is wired in: jobs, `JobRunner`, tool loop, model clients and the code that executes |
| `job-runner.mmd` | `job-runner.svg` | The `JobRunner` step by step: queue, tool loop, validation, one retry, failure codes |
| `photo-flow.mmd` | `photo-flow.svg` | The photo path: one deadline for the inspector and the bookmaker |
| `bet-lifecycle.mmd` | `bet-lifecycle.svg` | A bet from the typed chore to the receipt, with the offline and 24 h fallbacks |
| `scheduler.mmd` | `scheduler.svg` | The 60 s scheduler loop |
| `data-model.mmd` | `data-model.svg` | The main SQLite tables and their relations (from `src/server/migrations/`) |
| `hosted-deployment.mmd` | `hosted-deployment.svg` | Hosted mode: Droplet, Caddy, app container, volumes, backups, inference |
| `release-flow.mmd` | `release-flow.svg` | `release.sh` and `deploy.sh`: build, registry, deploy, rollback |
| `trust-boundaries.mmd` | `trust-boundaries.svg` | Untrusted input, guards, household-private data and what leaves the machine |
| `finetune-pipeline.mmd` | `finetune-pipeline.svg` | Snapshot, dataset, QLoRA, GGUF, evaluation |
| `timeline.mmd` | `timeline.svg` | How the project was built, from the idea to the hosted release ([how-it-was-built.md](../how-it-was-built.md)) |

`mermaid.config.json` holds the shared look (light theme, plain-SVG labels, white background).

## Regenerate

The renderer is `@mermaid-js/mermaid-cli`. It is **not** a project dependency: install it in a
scratch folder, and point it at any Chromium (the one Playwright installed is fine).

```bash
# once, in a scratch folder outside the repository
mkdir -p /tmp/mmd && cd /tmp/mmd && npm init -y >/dev/null
PUPPETEER_SKIP_DOWNLOAD=1 npm i @mermaid-js/mermaid-cli@11.4.2
echo '{"executablePath":"/path/to/chrome","args":["--no-sandbox"]}' > puppeteer.json

# every time, from the repository root
for f in docs/diagrams/*.mmd; do
  n=$(basename "$f" .mmd)
  /tmp/mmd/node_modules/.bin/mmdc -i "$f" -o "docs/images/architecture/$n.svg" \
    -c docs/diagrams/mermaid.config.json -p /tmp/mmd/puppeteer.json -b white
  sed -i -e '$a\' "docs/images/architecture/$n.svg"   # end the file with a newline (pre-commit)
done
```

`executablePath` is, for example, `~/.cache/ms-playwright/chromium-*/chrome-linux/chrome` after
`npx playwright install chromium`. The SVGs in this repository were made with mermaid-cli 11.4.2 and
Chromium 141. Do not use `<br>` inside a label: write `<br/>`. Subgraphs whose nodes should sit side
by side need `direction LR` and an invisible chain (`a ~~~ b ~~~ c`) because nodes with no edge between
them otherwise stack.
