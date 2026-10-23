# AGENTS.md

Guidance for AI coding agents working on **Wikipedia Graph Race**.

## Project summary
A browser app. The user supplies an OpenRouter API key, picks 2–6 LLMs and sets a target Wikipedia article. All models start on the same obscure article and navigate **only by choosing hyperlinks on the current page**. A live force-directed graph draws each model's path in its own neon colour, so you can see who reaches the goal and who goes in circles.

The public [README.md](./README.md) is written for users and visitors; keep it that way. Implementation detail, the module map and the build log live in this file (see "Status / what's built" at the end).

## Stack
- Vite, TypeScript (`strict`), vanilla DOM and Canvas 2D (no UI framework)
- `d3-force` for layout (only the simulation, not d3 DOM rendering)
- Vitest for tests, ESLint and Prettier for style
- No backend. The app calls the OpenRouter and Wikipedia (MediaWiki) APIs directly from the browser.

## Commands
```
npm install
npm run dev        # Vite dev server
npm run build      # type-check and production build
npm run test       # Vitest (run before every commit)
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm run format     # Prettier
```
Update this section if scripts change.

## Architecture rules
- `src/race/*` and `src/wiki/*` and `src/llm/*` **must not touch the DOM**. They are pure TypeScript and testable in Node.
- The race engine communicates with the UI only through typed events in `RaceStore`. The UI and graph render from the store and never call agents directly.
- All network access goes through `WikipediaClient` and `OpenRouterClient`. Both accept an injectable `fetch`, so tests never hit the network.
- Every race run must be reproducible from its event log, which is what the replay feature relies on. Don't add hidden state outside the store.
- Fairness is a hard requirement. All models receive an identical start, target, prompt template, link cap, step limit and temperature. Do not special-case any model or provider.

## Wikipedia conventions
- Canonical title: resolve redirects, replace `_` with a space, strip `#fragment`, compare case-sensitively after resolution.
- Valid links: `a[href^="/wiki/"]` in the article body with no namespace prefix (no `:` in the title). Exclude navboxes, references, hatnotes, edit links and sidebars.
- Link order follows the page. Dedupe on canonical title. Respect the configurable cap.
- Use `origin=*` for CORS. Cache responses and share the cache between racers.

## LLM conventions
- Prefer the `choose_link` tool call. Fall back to strict JSON parsed from content. Always validate the choice against the offered link list. Never trust model output.
- Treat all model and Wikipedia text as untrusted. Render with `textContent`. Never use `innerHTML` with it.
- Handle 401 and 402 by stopping that agent with a clear message, and 429 and 5xx with bounded backoff. One failing model must never stop the others.
- Record `usage` (tokens and cost) from each response.

## Security and privacy
- **Never log, persist (beyond opt-in storage), URL-encode or export the API key.** Default is `sessionStorage`. Share links and replay exports must exclude it.
- Keep the CSP `connect-src` limited to `https://openrouter.ai` and `https://*.wikipedia.org`.
- The project is licensed AGPL-3.0-or-later (see `LICENSE`). Only add dependencies whose licences are compatible, and ask first (see Workflow).
- Do not commit `.env` files or keys. Tests use the mock provider and fixtures, with no real keys.

## Graph and UI conventions
- Dark background and a neon palette defined in `src/graph/palette.ts`. Colours must stay distinguishable. Add new ones there, and never hard-code colours elsewhere.
- Rendering is decoupled from the simulation: a `requestAnimationFrame` render loop and a throttled simulation tick. Keep it smooth at 500+ nodes and 6 racers.
- Keyboard access and visible focus states are required for all controls. Don't rely on colour alone, since the legend and labels also identify models. Respect `prefers-reduced-motion`.

## Testing expectations
- Add or update tests with every behaviour change. Prefer fixtures in `tests/fixtures/` over live API calls.
- Required coverage: link extraction, title canonicalisation, choice parsing, loop detection, and race outcomes (arrived, circling, max steps, error) using `MockProvider` and a fake wiki.
- Don't merge with failing tests, type errors or lint errors.

## Code style
- Small, typed, single-purpose modules. No `any`. Use discriminated unions for events and results.
- Name events in past tense (`StepTaken`, `Arrived`). Keep constants in `src/config.ts`.
- Preserve existing comments and docstrings that your change doesn't affect. Comment the *why*, not the *what*.

## Progress tracking (keep it current so work can resume after any interruption)
Work may be stopped at any moment, so the repo itself must always say where things stand.
- This file, section "Status / what's built": **what exists now**. Update it after every part or feature, so it reflects reality (not intentions).
- This file, section "Known issues and deferred work": **what is unfinished**. If you hit a bug you can't fix immediately, or defer something, record it there with repro steps instead of leaving it only in your head. Remove entries when they are resolved.
- The README stays user-facing and is not a progress log. Only change it when something a user sees or needs to know changes (features, setup, privacy, licence).
- When starting a session, read "Status / what's built" and "Known issues and deferred work", then run the checks below to confirm the repo is in the state this file claims.

## Workflow for agents
1. Read "Status / what's built" and "Known issues and deferred work", then keep changes scoped to the task in hand.
2. Write or update tests first, where practical.
3. Run `npm run typecheck && npm run lint && npm run test` before finishing a step.
4. Update "Status / what's built" (and `README.md` only if user-visible behaviour or setup changed), and add any follow-up or deferred work to "Known issues and deferred work".
5. Ask the user before adding dependencies, a backend or paid services. (Dependencies already in `package.json` are pre-approved: Vite, TypeScript, d3-force, Vitest, ESLint, Prettier.)

## Known issues and deferred work
- Wikimedia asks for a contact in the `Api-User-Agent` header. `WIKI.contact` in `src/config.ts` points at this project's GitHub page; anyone hosting a public copy should change it to their own URL or email.
- The budget is checked before each model call, so a racer can overshoot its dollar or token cap by at most one call (cost is only known after the response).

## Status / what's built
Module map and build log, newest work last. Keep it current (see Progress tracking).

- **M0 Scaffold (done):** Vite + strict TypeScript, ESLint (flat config enforcing DOM-free `src/race`, `src/wiki`, `src/llm`), Prettier, Vitest, CI workflow, build-time CSP, dark app shell, `src/config.ts` constants.
- **M1 Wikipedia layer (done, verified against live Wikipedia):**
  - `src/wiki/title.ts`: title canonicalisation and `/wiki/` href parsing.
  - `src/wiki/extractLinks.ts`: dependency-free HTML scanner returning clean article body links (page order, deduped, capped, no navbox/refs/hatnotes/sidebars/namespace/red/external links), lead summary, and disambiguation flags.
  - `src/wiki/client.ts`: `WikipediaClient` (injectable `fetch`, shared LRU cache with in-flight request deduping, concurrency limiter, exponential backoff): `getPage`, `resolveTitle`, `search`, `randomTitles`, `averageDailyViews`, `incomingLinkCount`.
  - `src/wiki/startPicker.ts`: `pickObscureStart` (low pageviews, adequate connectivity) and `validateTarget`.
- **M2 LLM layer (done):**
  - `src/llm/types.ts`: `LlmProvider` interface, `ModelChoice` union, `Usage`, `LlmError`.
  - `src/llm/parseChoice.ts`: validates `choose_link` tool calls and JSON fallbacks against offered link lists.
  - `src/llm/prompt.ts`: fair, unified prompt template (`PROMPT_VERSION`) with trimmed history.
  - `src/llm/openrouter.ts`: `OpenRouterClient` (injectable `fetch`, retry backoff with `Retry-After`, tool-choice with automatic fallback, usage/cost tracking, `testApiKey`).
  - `src/llm/models.ts`: `fetchModels`, `searchModels`, pricing and tool capabilities.
- **M3 Race engine (done):**
  - `src/race/types.ts`: `RaceConfig`, `Racer`, `RaceEvent` discriminated union, `RaceState`/`RacerState`.
  - `src/race/store.ts`: append-only `RaceStore` with pure `reduce` and reproducible `replay`.
  - `src/race/agent.ts`: `runAgent` loop (correction retry, back moves, loop detection, budget and step limits, error containment).
  - `src/race/raceManager.ts`: concurrent agent orchestrator with pause/resume/stop and request cancellation.
  - `src/race/loopDetector.ts`, `src/race/results.ts`, `src/race/setup.ts`.
  - `src/mock/`: `FakeWiki`, `MockProvider`, and behavioural deciders.
- **M4 Graph visualisation (done):**
  - `src/graph/palette.ts`: dark background, deltaE-verified neon racer palette.
  - `src/graph/graphModel.ts`: pure reactive graph representation derived from events; `describeGraph` text description for accessibility.
  - `src/graph/camera.ts`: 2D viewport camera, cursor-centered zoom, auto-framing bounding boxes.
  - `src/graph/simulation.ts`: `d3-force` simulation wrapper with stable incremental updates and throttled ticks.
  - `src/graph/renderer.ts`: Canvas 2D neon renderer with additive glow blending, parallel edge offsets, repeated-edge thickening for circling, pulsating heads, interactive pan/zoom/drag, and follow camera.
  - `src/mock/demoWorld.ts`: 40+ interconnected articles graph for testing.
- **M5 UI (done):**
  - `src/ui/storage.ts`: API key and settings persistence.
  - `src/ui/toasts.ts`: accessible non-intrusive toast notifications.
  - `src/ui/autocomplete.ts`: accessible Wikipedia search autocomplete combobox.
  - `src/ui/setupPanel.ts`: key input & test, model picker with search & pricing, target autocomplete, start picker, fairness settings.
  - `src/ui/scoreboard.ts`: live racer standings, clicks, current article, cost, latency, follow toggle.
  - `src/ui/logPanel.ts`: live event stream with model reasoning, auto-scroll, racer filter.
  - `src/ui/controls.ts`: race controls (pause/resume, stop, speed slider, node scale slider, fit view).
  - `src/ui/nodeScaleControl.ts`: the node scale slider (0.5x to 3x, double-click resets), shared by the controls bar and the replay bar.
  - `src/ui/resultsModal.ts`: accessible `<dialog>` with podium, fastest and fewest clicks awards, path breakdowns.
- **M6 Polish and Release (done):**
  - `src/race/replay.ts` & `src/ui/replayBar.ts`: reproducible JSON replay loader, timeline scrubber, play/pause, step-forward/step-backward, and speed controls.
  - `src/examples/`: five bundled recordings (`*.json`, exported by the app) and `index.ts`, which lists them for the setup dialog's "Example replays" picker and lazy-loads each through `validateReplayData`. They are real recordings: add new ones by exporting a race and dropping the file in, never by editing events by hand. Check a candidate for secrets and provider error text first.
  - `src/ui/shareLink.ts`: URL hash serialization and deserialization for sharing setups without API keys.
  - Accessibility: screen-reader alternative (`describeGraph` in aria-live region), keyboard navigation, `:focus-visible` states, `prefers-reduced-motion` compliance.
  - Tests: 256 passing across 28 test files, including a full end-to-end lifecycle smoke test.
- **Post-release (2026-10-22):**
  - Start and target accept plain titles or pasted en.wikipedia.org links; a custom start is validated before the race.
  - Once the key is verified, the model list comes from OpenRouter's `GET /models/user`, so only models the account can run (provider preferences, privacy settings, guardrails) are offered. Falls back to the public list with a note if refused.
  - Presets pick 4 models from different families (vendor plus model line, e.g. `google/gemma` vs `google/gemini`) from that list: Fast & Cheap = cheapest by estimated step cost, Free = free models, Flagships = curated IDs the account can run, topped up from other families.
  - Article thumbnails inside graph nodes (Wikipedia page images, batched 50 per request on a separate client), with a 🖼 Pictures toggle in the controls bar that is remembered per browser.
  - Node scale slider (0.5x to 3x, `NODE_SCALE` in `src/config.ts`) in both the controls bar and the replay bar, remembered per browser. It scales the node circles, their pictures, the racer head markers, label offsets, the hover/drag hit area, and the edge stroke width and arrowheads (`GraphRenderer.setNodeScale`). Edge length follows too: `GraphSimulation.setNodeScale` multiplies link length, collision radius, repulsion range (strength by the square, to keep the forces balanced) and spawn distances by the scale and rescales existing positions about the origin, and the renderer moves the camera centre by the same ratio, so the layout is a stretched copy of the 1x one.
  - Wikimedia politeness: every Wikipedia request in the app (setup, races, thumbnails) goes through one shared queue, one request at a time with a 100ms pause after each, per the [robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy). Requests carry an `Api-User-Agent` header (`WIKI.appName` and `WIKI.contact` in `src/config.ts`; set a contact before sharing the app).
  - Races run in lockstep rounds by default (`lockstep` in the race config): every racer takes click N before anyone takes click N+1, while model calls within a round still run in parallel.
  - Visit cap (`maxVisitsPerPage`, default 3): after that many visits a page is no longer offered to that racer and `back` can't return to it. The separate circling threshold only labels and warns.
  - Bare-number replies (" 12", "13.") are read as the link index.
  - The visit cap follows redirects (a link named "Catholicism" counts as Catholic Church).
  - Target defaults to a random well-known article from Wikipedia's Vital Articles (Level 3) list, with Re-roll and a Custom option, mirroring the start.
  - Cost history: real cost per model call is recorded after each live race (this browser only), shown in the model list, and used by Fast & Cheap once a model has 5+ calls.
  - 🏁 Results reopens the last race's finish screen and replay export.
  - "Min intelligence" filter (Artificial Analysis Intelligence Index from OpenRouter) for the model list and presets; 💾 Save group / 📌 My group for a saved selection.
  - Reasoning Effort (default Low) and Max Reply Tokens (default 4,000) race settings, the same for every model; replies cut off at the limit are labelled as such.
  - Phone layout (640px and below) for setup, race view and results; scoreboard shows short model names.
