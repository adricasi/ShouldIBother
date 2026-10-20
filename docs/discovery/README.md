# should-i-bother (idea folder)

Status: Validating · revisited score 52/80 (draft 56) · proposed verdict Go with a cut scope (see `idea-brief.md` §10)

| File | For | Read by |
|---|---|---|
| `idea-brief.md` | The one-pager in the ideate template | `/ideate` (Revisit mode), then `/spec` |
| `research-notes.md` | Sources and evidence | `/ideate`, `/spec` |
| `product-concept.md` | Full product rules: catalogue, points, settlement, savings, Gemma jobs, evaluation, build plan | `/spec` (requirements and design) |
| `design-handoff.md` | Screens, components, tokens, accessibility, missing states, mockup-vs-concept mismatches | `/spec`, `ui-designer`, `ux-review` |
| `images/` | Figma exports (1×) | copy to `docs/images/` |
| `design/` | `tokens.css`, `design-tokens.json` | copy to `docs/design/` |

## Steps with the AI toolkit
```bash
# 1. Challenge and confirm the brief (Revisit mode: research, devil's advocate, score, verdict)
cd ~/ideas && claude
/ideate   # "Revisit should-i-bother"

# 2. Scaffold the existing repo adricasi/ShouldIBother (created 20 Oct, inside the window)
#    with the brief (copies the .md files to docs/discovery/); make it public before submitting
git clone https://github.com/adricasi/ShouldIBother ~/code/ShouldIBother && cd ~/code/ShouldIBother
new-project --existing --lang ts --public --owner adricasi \
  --description "A local Gemma 4 bookmaker that bets on doing nothing" \
  --from-idea ~/ideas/should-i-bother

# 3. Add the design (new-project copies only the .md files)
cp -r ~/ideas/should-i-bother/images docs/images
cp -r ~/ideas/should-i-bother/design docs/design

# 4. Write the spec, then the project kit
claude
/spec          # deployment target: Local / on-device
/project-kit
```
On Windows, `~/ideas` here is `Documents\ideas` (move it to your home folder if your toolkit expects `~/ideas`).
