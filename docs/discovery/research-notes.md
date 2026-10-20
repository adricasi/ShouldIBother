# Research notes: Should I Bother? — The Lazy Bookie

Collected for the `ideate` skill. Every factual claim has a source link and access date; estimates are labelled as estimates. All sources accessed 2026-10-20.

## Competitors and alternatives
- **Laundry Timer – Drying Times** — https://apps.apple.com/gb/app/laundry-timer/id6444082143 — iOS app that estimates outdoor drying time from temperature, sun, humidity, wind and cloud cover; 3-day drying forecast (7 with Pro), notification when dry, rain/wind warnings. Free, Pro £2.99. 4.7/5 from 43 ratings (UK store).
- **Rachio 3 smart sprinkler controller** — https://www.techhive.com/article/3264324/hubs-controllers/rachio-3-smart-sprinkler-controller-review-new-tricks-from-the-market-leader.html — "Weather Intelligence" skips irrigation after rain (adjustable threshold, default 0.125 in), on freeze risk and above a set wind speed. $249.99 (8-zone) / $299.99 (16-zone) at review time; needs an irrigation system. No subscription mentioned.
- **Greg: Plant Identifier & Care** — https://apps.apple.com/app/id1512912236 — plant ID and care; "Seasonal Updates" adapt care recommendations to local weather (subscription feature). $29.99/year after a 7-day trial; 4.6/5 from ~18K ratings. Doesn't explicitly say it skips watering for rain.
- **Habitica** — https://www.techradar.com/reviews/habitica — gamified task manager: completing tasks earns rewards, missing them costs health ("carrot and stick"). Free tier; premium $5/month or $48/year. Rewards doing, not skipping.
- **Do nothing / weather app / fixed routine** — the real default. No source needed; the product's job is to beat it with evidence (see the backtest plan in `product-concept.md`).

Gap found: no product found that rewards correct inaction or settles chore decisions against recorded weather and photos. (Searched app stores and the web for laundry drying, plant watering and gamified chores; not an exhaustive market study.)

## Market signals
- The challenge itself is the demand signal for this entry: DEV Hacktoberfest Open-Source AI Challenge, Week 3 "Slow and Steady" — build something with open-source AI that rewards laziness; prizes Overall and Best Use of Gemma; writing quality weighted most. https://dev.to/devteam/join-the-hacktoberfest-open-source-ai-challenge-slow-and-steady-2850-in-prizes-across-21-3iee · rules and categories: https://dev.to/challenges/hf26
- Adjacent paid products (Rachio hardware, Greg subscription, Laundry Timer Pro) show people pay to avoid unnecessary watering and to time laundry.

## Technology notes
- **Gemma 4** — https://datanorth.ai/news/google-releases-gemma-4-open-models — released 2 April 2026 under **Apache 2.0**. Sizes: E2B (2.3B effective), E4B (4.5B effective), 26B MoE (3.8B active), 31B dense. E2B/E4B: text, image and audio input, 128K context. 26B/31B: text, image, video, 256K context.
- **Gemma 4 sizes and audio** — https://lmstudio.ai/models/gemma-4 — audio on E2B and E4B (cited in the concept doc).
- **Ollama `gemma4`** — https://ollama.com/library/gemma4 — tags e2b (4.6–7.5 GB), e4b (6.6–9.5 GB), 12b, 26b, 31b, plus MLX variants; every tag lists **Text, Image** modalities; "tools" capability and native function calling. The page's model table says E2B/E4B support audio, but no tag lists it → **audio through Ollama is unverified; spike needed** (llama.cpp or a separate local speech step as fallback).
- **Open-Meteo** — https://open-meteo.com/en/terms — free for **non-commercial** use with no API key; limits < 10,000 calls/day, 5,000/hour, 600/minute (and 300,000/month) per IP; data licensed **CC BY 4.0** (attribution required, wording on their licence page). Commercial use (apps with subscriptions or ads, commercial products) needs a paid plan. Forecast and historical archive APIs: https://open-meteo.com/
- **Icons** — Lucide (ISC licence) is a close match to the Figma icon style (24 px, round stroke): https://lucide.dev/ (not fetched today; check the licence file when adding it).
- **Fonts** (Google Fonts, SIL Open Font License): Big Shoulders Display, IBM Plex Mono, Figtree — https://fonts.google.com/ (not fetched today).

## Savings figures (from the concept doc)
- Tumble dryer energy: about 5.3 kWh vented, 2.2 kWh heat pump per 9 kg load — https://www.haier-europe.com/en_GB/blogs/news/how-much-does-a-tumble-dryer-cost-to-run
- Washing machine water: 40–60 L per load for efficient models — https://www.harveywatersofteners.co.uk/blog/how-much-water-does-a-washing-machine-use/
- Washing a car: hose up to 500 L, car wash 75–300 L — https://ub.edu/ossma/en?p=37419
- Small split AC: 0.4–0.8 kWh per hour — https://www.costway.com/blog/mini-split-air-conditioners/split-air-conditioner-electricity-consumption.html
- Other catalogue figures (minutes per chore, litres per watering, heater kWh) are **typical estimates**; label them as such in the post.

## Regulatory / compliance notes
- Points only, no stakes and no money: not gambling. Avoid any real-money or prize mechanic.
- Personal data stays on the device (photos, voice, habits). Strip EXIF/location from photos; send only coarse coordinates to the weather API.
- Gemma 4 Apache 2.0 allows redistribution, but model weights still don't belong in the repo (size); document the pull command instead.
- Open-Meteo CC BY 4.0: show attribution in the app and README.

## Raw links
- https://dev.to/devteam/join-the-hacktoberfest-open-source-ai-challenge-slow-and-steady-2850-in-prizes-across-21-3iee
- https://dev.to/challenges/hf26
- https://www.figma.com/design/hDYVCSZCGhxGRsU4Nbz02z

## Revisit pass (2026-10-20, `/ideate` Revisit)
**Evidence quality:** collected by the `market-researcher` subagent from web-search result summaries only; fetching the pages failed from the session (DNS errors). Treat each item as second-hand until opened in a browser. All accessed 2026-10-20.

### Challenge rules
- Week 3 "Slow and Steady" runs 19–25 Oct; submissions due 25 Oct 2026, 11:59 PM PDT; winners the week of 26 Oct. — https://dev.to/challenges/hacktoberfest-week3-2026-10-19
- Judging: relevance to the theme, creativity, technical execution, optional partner tech; writing quality "weighted most heavily". No numeric weights found. — https://dev.to/devteam/join-the-hacktoberfest-open-source-ai-challenge-slow-and-steady-2850-in-prizes-across-21-3iee
- The submission is a DEV post with tags `devchallenge` and `hf26challenge`; entries use "What I Built / How I Built It / Why Does Open Innovation Matter?" headings. Official template headings not retrieved. — https://dev.to/harshalranjhani/hacktoberfest-open-source-ai-challenge-week-3-slow-and-steady-submission-2hj6
- Prizes: Overall $250; six featured categories at $200 incl. Best Use of Gemma ("run it locally, fine-tune it, or serve it…"); a project can enter every category it genuinely uses but win once. No rule on Gemma version or runtime found. — https://dev.to/challenges/hf26
- Week 1 rules (not Week 3): "The project and its repository must be created and completed within the Entry Period." — https://dev.to/page/hacktoberfest-week1-2026-10-05-contest-rules. Week 3 rules text not retrieved; no official licence requirement found.
- Similar Week 3 entries: many "sloth" tools (CommitSloth, SlothPlan, Sloth Fridge, LazyFlow AI…); none on weather, laundry or watering found (not exhaustive). — https://dev.to/t/hf26challenge, https://dev.to/abhishek_gupta_982095928c/sloth-fridge-a-local-vision-model-that-plans-dinner-from-one-photo-2pm9

### Backtest data without lookahead
- Open-Meteo **Historical Forecast API** archives past forecasts by stitching the first hours of each model run; GFS since 2021-03-23, ICON family since 2022-11-24, some regional models since 2024; ensembles not archived. — https://open-meteo.com/en/docs/historical-forecast-api, https://openmeteo.substack.com/p/introducing-the-historical-forecast
- **Previous Runs API**: hourly values as forecast 1–7 days earlier (`*_previous_day1` …), from Jan 2024; temperature, humidity, precipitation, cloud cover, 10 m wind, weather code. — https://open-meteo.com/en/docs/previous-runs-api
- Not confirmed: hourly sunshine duration in the archived models; which models cover Barcelona. Inference: the stitched series is short-lead, so it slightly flatters a "decide this morning" bet.

### Gemma 4 audio and speed
- Ollama lists `gemma4:e4b` as Text, Image, Audio (conflicts with the earlier note). — https://ollama.com/library/gemma4:e4b
- Ollama issues: audio routed through the vision renderer (#11798), intermittent GGML crashes on audio with e4b (#15333). v0.33.3 notes say audio works on the MLX engine (Apple Silicon). — https://github.com/ollama/ollama/issues/11798, https://github.com/ollama/ollama/issues/15333, https://github.com/ollama/ollama/releases/tag/v0.33.3
- llama.cpp added a Gemma 4 audio encoder to mtmd; docs call audio "highly experimental"; llama-server `input_audio` HTTP 500 reported. — https://github.com/ggml-org/llama.cpp/issues/21325, https://github.com/ggml-org/llama.cpp/issues/21868
- Chrome Web Speech uses server-side recognition by default (audio goes to Google); `processLocally` needs a language pack. — https://developer.mozilla.org/docs/Web/API/SpeechRecognition/processLocally
- E4B on an 8 GB RTX 3050: ~60 tok/s generation, ~2,230 tok/s prompt processing (one blog). — https://dev.to/gde/gemma-4-on-a-used-8-gb-rtx-3050-116-tokenss-for-one-user-618-for-64. No image-prefill timings found. Image token budgets 70/140/280/560/1120. — https://ai.google.dev/gemma/docs/capabilities/vision

### Phone browser over the LAN
- Secure context required for getUserMedia, Notifications and Service Workers; a LAN IP over HTTP is not secure. — https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts/features_restricted_to_secure_contexts
- HTML Media Capture (`<input type=file capture>`) mentions no secure-context requirement. — https://www.w3.org/TR/2018/REC-html-media-capture-20180201. Inference, to test on your phone: photo capture works over plain HTTP.
- Tailscale Serve: tailnet-private `https://*.ts.net` URL. — https://docs.openwebui.com/ecosystem/computer/phone-and-remote/tailscale. Cloudflare quick tunnels are public, testing-only, and route traffic through Cloudflare. — https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/

### Alternatives missed earlier
- Home Assistant Smart Irrigation (open source; sprinklers). — https://github.com/altmenorg/HAsmartirrigation
- Plant and Log: Water Guide (iOS): skips outdoor plants on likely-rain days, streaks. — https://apps.apple.com/us/app/-/id6772556646
- Met Office research: hanging out washing is the top reason people check the forecast; wind matters more than temperature for drying. — https://wmo.int/node/32960
