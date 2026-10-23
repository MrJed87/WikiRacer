# Wikipedia Graph Race

Pick 2 to 6 language models and watch them race through Wikipedia. Every model starts on the same obscure article and has to reach the same target article, moving **only by choosing links on the page it is currently reading**. A live force-directed graph draws each model's route in its own neon colour, so you can see who takes the shortcut, who wanders, and who goes around in circles.

It runs entirely in your browser. There is no backend: the app talks to [OpenRouter](https://openrouter.ai) for the models and to the Wikipedia API for the articles.

## Features

- **Fair by design.** Every model gets the identical start, target, prompt, link cap, step limit and temperature. Races run in lockstep rounds by default, so everyone takes click N before anyone takes click N+1.
- **Live graph.** A Canvas 2D neon renderer with pan, zoom, drag, a follow camera, article thumbnails inside the nodes, and thicker edges for repeated visits.
- **Scoreboard, log and results.** Live standings (clicks, current article, cost, latency), a stream of each model's reasoning, and a finish screen with a podium and fastest/fewest-clicks awards.
- **Replays.** Every race is an append-only event log, so any run can be exported as JSON, imported later and scrubbed through step by step.
- **Example replays.** Five real races between actual models ship with the app. Pick one from "Example replays" in the setup dialog to watch it without an API key.
- **Share a setup.** Copy a link that carries the chosen models, start, target and rules in the URL hash. Your API key is never included.
- **Smart model picking.** Only models your OpenRouter account can actually run are offered, with search, pricing, a minimum-intelligence filter, saved groups and one-click presets (Fast & Cheap, Free, Flagships).
- **Cost and loop controls.** Per-model budgets for steps, tokens and dollars, a per-page visit cap, loop detection, and a record of real cost per model call.
- **Offline demo.** Four simulated players (shortest path, wanderer, looper, flaky) race on a built-in mini Wikipedia, so you can try everything without an API key or any spend.
- **Accessible.** Keyboard controls, visible focus states, a screen-reader description of the graph, and support for `prefers-reduced-motion`. The layout works on phones.

## Getting started

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run dev
```

Then open the address Vite prints. To produce a static build you can host anywhere (GitHub Pages, Vercel, Netlify and so on):

```bash
npm run build
npm run preview   # optional: serve the production build locally
```

The build output in `dist/` is a plain static site and works from any path.

> **Windows note:** if your global `~/.npmrc` sets `os=linux`, install with `$env:npm_config_os='win32'; npm install`, otherwise Vite's native binding is skipped.

## How to play

1. **Try the offline demo.** Click "Try Offline Demo" to watch four simulated models race straight away. Or choose a recorded race from "Example replays", which are real runs of real models. (Some name a model as "Latest", which was whatever OpenRouter pointed that alias at on the day.)
2. **Run a live race.** Paste your OpenRouter API key and test it, choose 2 to 6 models, set a target article (with live Wikipedia autocomplete, or paste an en.wikipedia.org link), roll a random obscure start article (under 100 daily pageviews), and press "Start Race".
3. **Control it.**
   - `Space`: pause or resume
   - `F`: fit the graph in view
   - `ArrowLeft` / `ArrowRight`: step backward or forward during a replay
   - Click a model in the scoreboard to follow its path with the camera.
4. **Keep it.** Export the finished race as a replay JSON, load one with "Replay JSON" in the setup dialog, or use "Share Setup" to copy a link to the same configuration.

> **Live races spend your OpenRouter credit.** Reasoning-heavy models can be expensive over many clicks. Start with a preset such as Fast & Cheap or Free, and use the step, token and dollar limits in the race rules.

## Privacy and security

- **Your API key stays in your browser.** It is held in memory or `sessionStorage`, with an optional opt-in to `localStorage`. It is only ever sent to `https://openrouter.ai`, and it is never logged, never written into replay exports, and never put in share links.
- **Locked-down network access.** The production build ships a Content Security Policy that limits `connect-src` to `https://openrouter.ai` and `https://*.wikipedia.org`, and `img-src` to the app plus Wikimedia's image hosts for article thumbnails.
- **Untrusted text is treated as untrusted.** Wikipedia summaries and model reasoning are rendered with `textContent`, never as HTML.
- **Polite to Wikipedia.** All Wikipedia requests share one queue, one at a time with a 100 ms pause, following the [Wikimedia robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy). Requests carry an `Api-User-Agent` header. If you host your own copy for others, change `WIKI.contact` in `src/config.ts` (it points at this project's GitHub page) to your own URL or email address, as Wikimedia asks.

## Development

```bash
npm run dev         # Vite dev server
npm run test        # Vitest suite
npm run lint        # ESLint (also enforces that the race, wiki and llm layers never touch the DOM)
npm run typecheck   # TypeScript strict mode
npm run build       # type-check, then production build with the CSP injected
npm run format      # Prettier
```

The code is vanilla TypeScript with no UI framework. [`d3-force`](https://github.com/d3/d3-force) provides the layout simulation; everything else is written in-house. The race engine (`src/race`), Wikipedia layer (`src/wiki`) and model layer (`src/llm`) are pure TypeScript that runs in Node, so the whole race can be tested without a browser, a network or a real model. Tests use a fake Wikipedia and a mock provider, so they never hit the network and never need a key.

## Built with AI

This project was largely developed with AI coding assistants working from the author's direction. That covers much of the code, the tests and the documentation. It has a sizeable automated test suite and strict type and lint checks, but it is a hobby project, so read the code before you trust it with anything you care about, and keep an eye on your OpenRouter spend.

## Data and attribution

Article text comes from Wikipedia and is available under the [Creative Commons Attribution-ShareAlike licence](https://creativecommons.org/licenses/by-sa/4.0/). Thumbnails come from Wikimedia Commons and carry their own licences. Models are accessed through OpenRouter. This project is not affiliated with Wikipedia, the Wikimedia Foundation or OpenRouter.

## Licence

Copyright (C) 2026 MrJed87

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. The full text is in [LICENSE](./LICENSE).
