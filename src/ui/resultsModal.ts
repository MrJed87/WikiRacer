/**
 * Race Results & Podium Modal Dialog.
 *
 * Implements accessible <dialog closedby="any"> with showModal() and backdrop styling.
 * Displays podium winners, per-model path breakdowns, and export replay JSON functionality.
 */
import { computeResults, noArrivalSummary } from '../race/results';
import { racerColor } from '../graph/palette';
import type { RaceEvent, RaceState, Racer } from '../race/types';

export interface ResultsModalOptions {
  container: HTMLElement;
  getRacer: (id: string) => Racer | undefined;
  onPlayAgain: () => void;
  onNewRace: () => void;
}

export class ResultsModal {
  private readonly dialog: HTMLDialogElement;
  private readonly getRacer: (id: string) => Racer | undefined;
  private readonly onPlayAgain: () => void;
  private readonly onNewRace: () => void;
  private currentEvents: readonly RaceEvent[] = [];
  private currentState: RaceState | null = null;

  constructor(opts: ResultsModalOptions) {
    this.getRacer = opts.getRacer;
    this.onPlayAgain = opts.onPlayAgain;
    this.onNewRace = opts.onNewRace;

    this.dialog = document.createElement('dialog');
    this.dialog.className = 'results-modal';
    this.dialog.setAttribute('closedby', 'any');
    this.dialog.setAttribute('aria-labelledby', 'results-title');

    // Fallback for browsers without closedby support
    if (typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
      this.dialog.addEventListener('click', (event) => {
        if (event.target !== this.dialog) return;
        const rect = this.dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (!isDialogContent) {
          this.close();
        }
      });
    }

    opts.container.appendChild(this.dialog);
  }

  show(state: RaceState, events: readonly RaceEvent[]): void {
    this.currentState = state;
    this.currentEvents = events;
    this.render();
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
  }

  close(): void {
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  private render(): void {
    if (!this.currentState) return;
    const state = this.currentState;
    const results = computeResults(state);

    const fastest = results.fastestId ? this.getRacer(results.fastestId) : null;
    const fewest = results.fewestClicksId ? this.getRacer(results.fewestClicksId) : null;

    this.dialog.innerHTML = `
      <div class="results-content">
        <header class="results-header">
          <div class="results-title-row">
            <h2 id="results-title">🏁 Race Completed!</h2>
            <button type="button" class="btn btn-ghost results-close" id="btn-close-results" title="Close results and look at the graph (🏁 Results reopens them)" aria-label="Close results">✕</button>
          </div>
          <div class="results-subtitles" id="results-subtitles"></div>
        </header>

        <div id="podium-slot"></div>

        <section class="results-paths-section">
          <h3>Racer Paths & Performance</h3>
          <div class="paths-list" id="paths-list"></div>
        </section>

        <footer class="results-footer">
          <div class="results-btn-group">
            <button type="button" class="btn" id="btn-view-graph" title="Close results and look at the finished graph">🗺 View Graph</button>
            <button type="button" class="btn" id="btn-export-replay">📥 Export Replay JSON</button>
            <button type="button" class="btn" id="btn-new-race">⚙️ New Race Setup</button>
            <button type="button" class="btn btn-primary" id="btn-play-again">🔄 Race Again</button>
          </div>
        </footer>
      </div>
    `;

    // Subtitles (safely render model labels with textContent)
    const subtitlesEl = this.dialog.querySelector('#results-subtitles') as HTMLElement;
    if (fastest) {
      const span = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = `🏆 Fastest: ${fastest.label}`;
      span.appendChild(strong);
      subtitlesEl.appendChild(span);
    }
    if (fewest) {
      const span = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = `🎯 Fewest Clicks: ${fewest.label} (${state.racers[fewest.id]?.steps ?? 0} clicks)`;
      span.appendChild(strong);
      subtitlesEl.appendChild(span);
    }

    // Podium
    const podiumSlot = this.dialog.querySelector('#podium-slot') as HTMLElement;
    const arrived = results.standings.filter((s) => s.status === 'arrived');
    if (arrived.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'podium-grid';
      const medals = ['🥇 1st Place', '🥈 2nd Place', '🥉 3rd Place'];

      arrived.slice(0, 3).forEach((s, idx) => {
        const racer = this.getRacer(s.racerId);
        const color = racer ? racerColor(racer.colorIndex) : '#fff';

        const card = document.createElement('div');
        card.className = `podium-card podium-rank-${idx + 1}`;

        const medalEl = document.createElement('div');
        medalEl.className = 'podium-medal';
        medalEl.textContent = medals[idx] ?? `#${idx + 1}`;

        const nameEl = document.createElement('div');
        nameEl.className = 'podium-racer-name';
        nameEl.style.color = color;
        nameEl.textContent = racer?.label ?? s.racerId;

        const statsEl = document.createElement('div');
        statsEl.className = 'podium-stats';
        const clicksSpan = document.createElement('span');
        clicksSpan.textContent = `${s.steps} clicks`;
        statsEl.appendChild(clicksSpan);
        if (s.finishedAtMs) {
          const timeSpan = document.createElement('span');
          timeSpan.textContent = `${(s.finishedAtMs / 1000).toFixed(1)}s`;
          statsEl.appendChild(timeSpan);
        }

        card.appendChild(medalEl);
        card.appendChild(nameEl);
        card.appendChild(statsEl);
        grid.appendChild(card);
      });
      podiumSlot.appendChild(grid);
    } else {
      const empty = document.createElement('div');
      empty.className = 'podium-empty';
      const p = document.createElement('p');
      p.textContent = noArrivalSummary(state);
      empty.appendChild(p);
      podiumSlot.appendChild(empty);
    }

    // Paths
    const pathsList = this.dialog.querySelector('#paths-list') as HTMLElement;
    state.order.forEach((id) => {
      const racerState = state.racers[id];
      const racer = this.getRacer(id);
      if (!racerState || !racer) return;

      const color = racerColor(racer.colorIndex);
      const isWinner = results.fastestId === id;

      const card = document.createElement('div');
      card.className = `path-breakdown-card ${isWinner ? 'is-winner' : ''}`;

      const cardHeader = document.createElement('div');
      cardHeader.className = 'path-card-header';

      const meta = document.createElement('div');
      meta.className = 'path-racer-meta';

      const dot = document.createElement('span');
      dot.className = 'racer-dot';
      dot.style.backgroundColor = color;
      dot.style.color = color;

      const strong = document.createElement('strong');
      strong.textContent = racer.label;

      const statusTag = document.createElement('span');
      statusTag.className = `path-status-tag status-${racerState.status}`;
      statusTag.textContent = racerState.status.toUpperCase();

      meta.appendChild(dot);
      meta.appendChild(strong);
      meta.appendChild(statusTag);

      const metrics = document.createElement('div');
      metrics.className = 'path-metrics';
      const clicksSpan = document.createElement('span');
      clicksSpan.textContent = `${racerState.steps} clicks`;
      const tokensSpan = document.createElement('span');
      tokensSpan.textContent = `${racerState.usage.totalTokens.toLocaleString()} tokens`;
      metrics.appendChild(clicksSpan);
      metrics.appendChild(tokensSpan);
      if (racerState.usage.costUsd > 0) {
        const costSpan = document.createElement('span');
        costSpan.textContent = `$${racerState.usage.costUsd.toFixed(4)}`;
        metrics.appendChild(costSpan);
      }

      cardHeader.appendChild(meta);
      cardHeader.appendChild(metrics);

      // Untrusted article trail rendered with textContent
      const trailList = document.createElement('div');
      trailList.className = 'path-trail-list';
      racerState.trail.forEach((t, idx) => {
        const item = document.createElement('span');
        item.className = `trail-item ${idx === racerState.trail.length - 1 ? 'is-last' : ''}`;
        item.textContent = t;
        trailList.appendChild(item);

        if (idx < racerState.trail.length - 1) {
          const sep = document.createElement('span');
          sep.className = 'trail-sep';
          sep.textContent = ' ➔ ';
          trailList.appendChild(sep);
        }
      });

      card.appendChild(cardHeader);
      card.appendChild(trailList);
      // Why this racer stopped (error text etc.), so a failure is never a silent "FAILED".
      if (racerState.status !== 'arrived' && racerState.note) {
        const note = document.createElement('p');
        note.className = 'path-note';
        note.textContent = racerState.note;
        card.appendChild(note);
      }
      pathsList.appendChild(card);
    });

    // Phones have no Escape key or visible backdrop to tap, so closing needs real buttons.
    for (const id of ['#btn-close-results', '#btn-view-graph']) {
      this.dialog.querySelector(id)?.addEventListener('click', () => this.close());
    }

    this.dialog.querySelector('#btn-play-again')?.addEventListener('click', () => {
      this.close();
      this.onPlayAgain();
    });

    this.dialog.querySelector('#btn-new-race')?.addEventListener('click', () => {
      this.close();
      this.onNewRace();
    });

    this.dialog.querySelector('#btn-export-replay')?.addEventListener('click', () => {
      this.exportReplay();
    });
  }

  private exportReplay(): void {
    if (!this.currentState || !this.currentEvents.length) return;

    // Build reproducible replay object (strictly excludes API key)
    const exportData = {
      app: 'Wikipedia Graph Race',
      version: 1,
      exportedAt: new Date().toISOString(),
      config: this.currentState.config,
      racers: this.currentState.order
        .map((id) => this.getRacer(id) ?? this.currentState?.racers[id]?.racer)
        .filter(Boolean),
      events: this.currentEvents,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wiki-race-${this.currentState.config?.start ?? 'start'}-to-${this.currentState.config?.target ?? 'target'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  destroy(): void {
    this.close();
    this.dialog.remove();
  }
}
