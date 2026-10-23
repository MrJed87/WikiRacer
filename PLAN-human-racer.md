# Human racer: implementation plan

Status: proposal, nothing built yet. Written against the local code as of 23 Oct 2026 (newer than GitHub).
Scope: Phase 1 is list mode, start to finish. Phase 2 looks at how to add full-page mode.

## Decisions already made (from our chat)

- A human is one more racer. It plugs in at the same seam the models use, so validation, visit cap, loop detection, event log and replay all work unchanged.
- Two ranks, both relative to the models in the same race: by link count (tie-break by time) and by time. No backend, no global leaderboard.
- Time is plain elapsed time to the `Arrived` event. No latency summing or adjustments. The time rank will mostly show that the machines are faster, and the link rank is where a human can win. That split is the point.
- Lockstep rounds are off in any race with a human (mechanical need, not a fairness tweak).
- List mode is "Easy", full page is "Hard". They are ranked and labelled separately.

## What the code review found (these shape the plan)

1. **The seam exists.** `RaceManager` takes `Entrant { racer, provider }` per racer and `main.ts` currently passes one shared `OpenRouterClient`. A human is just a different `LlmProvider` whose `chooseLink()` waits for a click. `agent.ts` needs no special case, which keeps the AGENTS.md fairness rule intact.
2. **Spoiler leak.** The graph, scoreboard "Current Article" column, event log (model reasoning) and the `aria-live` graph description all update live. A human playing alongside would see exactly which links the models took. The play view has to hide these until the human finishes or gives up.
3. **The Wikipedia queue is strictly FIFO, one request at a time** (`createLimiter` in `src/util/async.ts`, shared by everyone). After each human click the next page load queues behind up to 5 models' requests, and that wait lands inside the human's time. Fix with a priority lane for the human.
4. **No way to give up.** The agent only ends on arrive, max steps, budget, stuck or error. A human needs a resign action that ends cleanly as `GaveUp`.
5. **`lockstep` is not in `RaceOverrides`** (`src/race/setup.ts`), so it can't currently be turned off per race. Trivial to add.
6. **Setup validation** (`setupPanel.ts`, `updateValidation`) demands an API key and 2 to 6 models. With a human it should be 1 to 5 models. The offline demo world is also a natural place to play with no key, and is the best development and test target (Wikipedia returns 429 to cloud sandboxes, per TODO.md).
7. **Things that would let a human distort a race:** the pause button and Space shortcut (pausing while thinking), the speed slider (changes `stepDelayMs` for the models), and "New race" (which calls `pause()`). All need to be disabled or changed in a human race.
8. **`results.ts` has one rank** (clicks, then time) plus `fastestId`. It needs both ranks exposed.
9. **`mergeCostHistory` would record the human** as a model with zero cost. Skip the human id.
10. **Browser Back leaves the app** (share links use the hash, not history entries), which would lose a race in progress. Add a `beforeunload` confirm during a human race.
11. **`getPage` discards the article HTML** after extracting links and the summary. This matters for Phase 2 only.

## Phase 1: list mode

Order matters: each step leaves the app working and tests green, as in ROADMAP.md. Sizes are S, M or L.

### Step 1: data model (S)
- `src/race/types.ts`: add optional `human?: { mode: 'list' | 'page' }` to `Racer`. Optional so every existing replay still loads. The racer id is the fixed string `human` (OpenRouter ids contain a `/`, so no collision).
- `GaveUp` event gains optional `resigned?: boolean`. `reduce` writes the note "Gave up after N clicks." instead of "Ran out of clicks".
- Tests: reducer handles both; existing example replays and `tests/fixtures/replay-london-monster.json` still pass `validateReplayData` and replay identically.

### Step 2: `HumanProvider` (M)
- New `src/race/humanProvider.ts` (DOM-free, so it respects the ESLint layering rule). It implements `LlmProvider.chooseLink(request)` by calling an injected `HumanInput` surface:
  ```ts
  interface HumanInput {
    present(req: ChooseLinkRequest): Promise<HumanAction>;
  }
  type HumanAction =
    | { kind: 'link'; index: number }   // 1-based, into req.current.links
    | { kind: 'back' }
    | { kind: 'resign' };
  ```
- It validates the index against `req.current.links` (never trust the UI either), then returns a `ChooseLinkResult` with `ZERO_USAGE` and `latencyMs` = time from presenting the page to the click. That means `StepTaken.latencyMs` becomes the human's reading and decision time, which is nice data for the scoreboard and replay.
- On `req.signal` abort it rejects with `LlmError('aborted')`, exactly as `MockProvider` does, so stopping a race cancels a pending human turn.
- Tests with a scripted `HumanInput` against `FakeWiki`: arrives, back, invalid index, abort, visit-cap blocked link, resign.

### Step 3: resign choice in the agent (S)
- `ModelChoice` (in `src/llm/types.ts`) gains `{ kind: 'resign' }`. `parseChoice` never produces it, so models can't use it.
- `agent.ts`: one branch, `emit GaveUp { steps, resigned: true }` then return. This is the only engine change, and it is generic, not human-specific.
- Tests: `raceEngine.test.ts` case for resign; confirm a model path is unchanged.

### Step 4: race setup for human races (S)
- `RaceOverrides` gains `lockstep`. Human races set `lockstep: false`.
- `stopOnFirstArrival` stays user-controlled, but default off for human races. When the human arrives the race carries on until the models finish (they usually already have).
- `maxSteps`, `linkCap`, `maxVisitsPerPage` and the rest are the same for the human as for everyone (hard fairness rule). Budget is irrelevant to the human (zero cost).

### Step 5: priority lane on the Wikipedia queue (S to M, optional but recommended)
- `createLimiter` gets a second, higher-priority queue. `WikipediaClient` exposes a view of itself (shared cache, shared limiter) that enqueues on the priority lane.
- `Entrant` gets an optional `wiki?: WikiSource`. `RaceManager` passes `e.wiki ?? this.opts.wiki` to that racer's agent. The human's entrant uses the priority view.
- Why: otherwise human time includes queueing behind models. This keeps the time rank about the human, not about the queue. If you'd rather not touch the limiter yet, skip this step and note it as a known limitation, since it adds at most a second or so per click.
- Tests: with the limiter fed 5 queued normal tasks, a priority task runs next; the 100 ms gap is preserved.

### Step 6: two ranks in `results.ts` (S)
- `Standing` gets `rankByClicks` and `rankByTime` (arrived racers only). Keep `rank` as an alias for clicks so existing UI keeps working.
- Add `humanSummary(state)`: for the human, "2nd of 5 by clicks, 4th of 5 by time", or "gave up after N clicks", or "ran out of clicks".
- Tests: ties (same clicks, different times), human not arrived, human only arrival.

### Step 7: play view, list mode (L)
New `src/ui/playPanel.ts` (implements `HumanInput`). Layout: a full-screen overlay while the human is racing.
- **Header:** target title and lead summary (same text the models get), click counter, race timer, models' progress strip (name, clicks, status only; no article names, no paths).
- **Current article:** title and lead summary, then the numbered link list, exactly what the prompt shows models (same cap, same order, same "first 150 of N" note). Click a link or type its number and press Enter.
- **Back button** (enabled from `req.canGoBack`) and **Give up** button. Back counts as a click, as for models.
- **Engine hints shown as text:** `req.hint` carries the visit-cap notice ("Pages you have already visited 3 times are no longer offered: …") and loop warnings, so the human sees what the models are told.
- **Optional type-to-filter box** over the list. This is the equivalent of Ctrl+F, which a human has anyway. Recommended on; see open decisions.
- **No spoilers:** the rest of the app (`#graph-container`, sidebar, tooltip) gets the `inert` attribute and the `a11y-graph-summary` region is cleared while the overlay is open. On finish or give up the overlay closes, the graph is revealed and the results modal opens.
- All text via `textContent`. Keyboard accessible, visible focus, `prefers-reduced-motion` respected, phone layout (640 px and below).
- Tests (jsdom is not in the project, so this follows the existing `ui.test.ts` approach): keep logic in small pure helpers (filter, index parsing) and test those; check the panel file with typecheck and lint.

### Step 8: setup panel, share link, wiring (M)
- `setupPanel.ts`: an "Include a human racer" toggle with a name field (default "You") and a mode picker (List = Easy; Full page shown disabled with "Coming soon" until Phase 2). Validation becomes 1 to 5 models when it's on. Preference remembered via `storage.ts`.
- `SetupRaceParams` gains `human?: { name: string; mode: 'list' | 'page' }`. `main.ts` `launchLiveRace` adds the human entrant (colour index after the models) with `HumanProvider` and the play panel.
- Before `manager.start()`, a short 3-2-1 countdown with the target already visible, so the clock doesn't start while the human is still reading the setup screen.
- Disable during a human race: pause button, Space shortcut, speed slider, and make "New race" a confirm-then-stop. Add `beforeunload` confirm.
- `shareLink.ts`: add `human=list` (later `human=page`) so "beat my score on this one" opens setup with the human toggle on, same start and target. Optional: a `beat=clicks:ms` param shown as a friendly target (trivially editable, so it's a challenge banner, not a verified score).
- Skip the human in `mergeCostHistory` (finding 9 above).
- Tests: share link round trip including the clamping of unknown values; setup validation counts; smoke test extended with a scripted human racing against mock bots.

### Step 9: play the offline demo with no key (S)
- Offer "Play vs the demo bots" using `createDemoWiki` and the mock racers. No API key, no spend, works offline, and it is the safest way to develop and test the play view. Also a good first-visit experience on the Vercel site.

### Step 10: results and personal bests (M)
- `resultsModal.ts`: highlight the human row ("you"), show both ranks, label mode (Easy / Hard) and the `humanSummary` line. Scoreboard shows "(you)" and a "Gave up" badge.
- Local personal bests in `localStorage` (try/catch around every access, as for the other storage keys), keyed by start, target and mode: best clicks and best time. Shown in the results modal as "Your best on this pair: 6 clicks, 48 s".
- Replay: nothing special needed; the human appears as a normal racer with the `human` flag, with decision time in the log.

### Step 11: docs and bookkeeping (S)
- AGENTS.md: update the fairness rule ("a human is a provider under identical rules; the only race-wide change is lockstep off"), module map, Status, and Known issues.
- ROADMAP.md and TODO.md: add the human racer items, and tick the "Link-hover hints mode" backlog item as a separate future mode, not part of this.
- README: a short "Race as a human" section only once it ships.

### Phase 1 definition of done
- A human can race 1 to 5 models in list mode, live or in the offline demo, give up, finish, see two ranks, and reopen the race as a normal replay.
- `npm run typecheck && npm run lint && npm run test && npm run build` all pass. No new dependencies. CSP unchanged.
- Old replays and the five bundled examples still load unchanged.

## Phase 2: full-page mode (Hard)

### What it needs, regardless of approach
- The article HTML itself. Today `WikipediaClient.getPage` keeps only links and summary. Add `getArticleHtml(title)` with a small separate cache (around 20 entries; full pages can be hundreds of KB, so don't reuse the 500-entry page cache). Same queue, same `Api-User-Agent`. Replays and the event log are unaffected because the HTML never enters them.
- **Link parity.** The clickable set must equal the list-mode set: the same extractor rules, the same cap, minus visit-capped pages. A link to anything outside that set renders as plain text. Parity test: for the fixtures, the set of clickable titles equals `extractPage(html).links` when under the cap.
- Same back button, click counting and resign as list mode, and no browser Back (the `beforeunload` guard from Phase 1 covers it).

### The rendering options

| Option | What it is | For | Against |
|---|---|---|---|
| A. In-house allow-list renderer (recommended) | Extend the existing dependency-free scanner into `src/wiki/renderArticle.ts` (DOM-free) that turns HTML into a typed node tree of allow-listed tags and attributes. A UI layer builds DOM from it with `createElement` and `textContent`. | No dependency, CSP unchanged, matches the project's "never innerHTML with untrusted text" rule, link parity by construction (same `titleFromHref` and excluded-class set), testable in Node. | You own table and infobox rendering. Medium to large. |
| B. Sanitiser library (for example DOMPurify) into a container | Parse with a library, strip, inject. | Faster route to full fidelity. | AGENTS.md says ask before adding dependencies, and licence compatibility with AGPL would need checking. A misconfigured sanitiser is an XSS hole in an origin that holds the user's API key in `sessionStorage`, so the stakes are higher than usual. Inline `style` attributes and protocol-relative image URLs still need handling because the CSP has `style-src 'self'`. |
| C. iframe of live Wikipedia | Embed the real site. | Looks perfect. | Cross-origin, so the app can't intercept clicks, count them, restrict the link set or provide a Back button. That defeats ranking regardless of what Wikipedia's frame headers say, so I didn't test them. Also needs a `frame-src` CSP change. Rejected. |

### Recommended path: A, in two stages
- **2a, reader view (M):** headings, paragraphs, lists, blockquotes and links, with infobox and tables simplified or collapsed and images omitted. Mode picker enabled, "Hard" label, results and personal bests keyed by mode. This is already a playable hard mode, since the difficulty is scrolling and finding links in prose.
- **Decision gate:** play about five races on varied articles (a very long one, a list article, a table-heavy one). If it's fun and clearly harder than list mode, continue. If it's just tedious, stop.
- **2b, fidelity (M to L):** images (thumbnail hosts are already in the CSP `img-src`; rewrite protocol-relative URLs to https; sizing via CSS classes, never inline styles), proper tables and infoboxes, collapsible sections. Render in chunks or use `content-visibility: auto` for very large pages.

### Phase 2 details worth settling early
- Ctrl+F works natively on the rendered DOM, so no custom find box is needed in this mode, and the type-to-filter box from list mode is not shown.
- Scroll reset and focus management on each new page.
- The "See also" section counts as article body (the extractor already keeps it), so those links are clickable.
- The separate "link-hover hints" idea (hover a link to see the target's summary) from the backlog would be a third mode later. It doesn't belong in this phase.

## Open decisions for you (my defaults in brackets)

1. Include the type-to-filter box in list mode? [Yes. Ctrl+F exists anyway, and it keeps the humans' list-mode disadvantage honest rather than artificial.]
2. When the human finishes or gives up, end the race for the models too? [No. Let it run to all-done; models usually finish first anyway.]
3. 3-2-1 countdown before the clock starts? [Yes.]
4. Hide model progress entirely, or show click counts and status only? [Click counts and status only. It adds race pressure without leaking routes.]
5. One human per race only? [Yes.]
6. Do the priority lane (Step 5) now or leave it as a known limitation? [Do it; it is small and protects the time rank.]

## Suggested build order

Steps 1 to 4 and 6 first (all engine and results work, fully testable in Node with no UI), then Step 9 (demo play) together with Step 7 so the play view can be built and tested with no key, then Steps 8, 10, 5 and 11. Phase 2 starts only after Phase 1 has been played for a while.
