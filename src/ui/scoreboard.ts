/**
 * Live Race Scoreboard.
 * Displays real-time ranking, step counts, current articles, statuses,
 * latency, and cost per racer.
 */
import { computeResults, type Standing } from '../race/results';
import { racerColor } from '../graph/palette';
import type { RaceState, Racer } from '../race/types';

export interface ScoreboardOptions {
  container: HTMLElement;
  getRacer: (id: string) => Racer | undefined;
  onFollowRacer?: (racerId: string | null) => void;
  onFocusRacer?: (racerId: string | null) => void;
}

export class Scoreboard {
  readonly element: HTMLElement;
  private readonly getRacer: (id: string) => Racer | undefined;
  private readonly onFollowRacer?: (racerId: string | null) => void;
  private readonly onFocusRacer?: (racerId: string | null) => void;

  private followedRacerId: string | null = null;
  private focusedRacerId: string | null = null;

  constructor(opts: ScoreboardOptions) {
    this.getRacer = opts.getRacer;
    this.onFollowRacer = opts.onFollowRacer;
    this.onFocusRacer = opts.onFocusRacer;

    this.element = document.createElement('div');
    this.element.className = 'scoreboard-container';
    opts.container.appendChild(this.element);
  }

  update(state: RaceState): void {
    const results = computeResults(state);
    this.element.innerHTML = '';

    const table = document.createElement('div');
    table.className = 'scoreboard-table';
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Live Race Standings');

    // Header
    const thead = document.createElement('div');
    thead.className = 'sb-row sb-header';
    thead.setAttribute('role', 'row');
    thead.innerHTML = `
      <span class="sb-col sb-rank" role="columnheader">#</span>
      <span class="sb-col sb-model" role="columnheader">Model</span>
      <span class="sb-col sb-article" role="columnheader">Current Article</span>
      <span class="sb-col sb-steps" role="columnheader">Clicks</span>
      <span class="sb-col sb-status" role="columnheader">Status</span>
      <span class="sb-col sb-actions" role="columnheader">Follow</span>
    `;
    table.appendChild(thead);

    results.standings.forEach((standing: Standing) => {
      const racerState = state.racers[standing.racerId];
      const racer = this.getRacer(standing.racerId) ?? racerState?.racer;
      if (!racerState || !racer) return;

      const isWinner = results.fastestId === standing.racerId;
      const isFewest = results.fewestClicksId === standing.racerId;
      const isFollowing = this.followedRacerId === standing.racerId;
      const isDimmed = this.focusedRacerId !== null && this.focusedRacerId !== standing.racerId;

      const row = document.createElement('div');
      row.className = `sb-row ${isWinner ? 'sb-row-winner' : ''} ${isDimmed ? 'sb-row-dimmed' : ''}`;
      row.setAttribute('role', 'row');

      const color = racerColor(racer.colorIndex);

      // Rank symbol
      let rankDisplay = '—';
      if (standing.rank === 1) rankDisplay = '🥇';
      else if (standing.rank === 2) rankDisplay = '🥈';
      else if (standing.rank === 3) rankDisplay = '🥉';
      else if (standing.rank !== null) rankDisplay = String(standing.rank);

      let statusBadgeClass = 'badge-racing';
      let statusText = 'Racing';

      if (standing.status === 'arrived') {
        statusBadgeClass = 'badge-arrived';
        statusText = isWinner ? 'Winner' : isFewest ? 'Fewest Clicks' : 'Arrived';
      } else if (racerState.circling) {
        statusBadgeClass = 'badge-circling';
        statusText = 'Circling';
      } else if (standing.status === 'gave-up') {
        statusBadgeClass = 'badge-other';
        statusText = 'Max Steps';
      } else if (standing.status === 'out-of-budget') {
        statusBadgeClass = 'badge-circling';
        statusText = 'Budget Cap';
      } else if (standing.status === 'stuck') {
        statusBadgeClass = 'badge-other';
        statusText = 'Dead End';
      } else if (standing.status === 'failed') {
        statusBadgeClass = 'badge-circling';
        statusText = 'Error';
      }

      const costText = standing.costUsd > 0 ? `$${standing.costUsd.toFixed(4)}` : '';
      const latencyText = racerState.lastLatencyMs
        ? `${Math.round(racerState.lastLatencyMs)}ms`
        : '';

      row.innerHTML = `
        <span class="sb-col sb-rank" role="cell">${rankDisplay}</span>
        <span class="sb-col sb-model" role="cell">
          <span class="sb-color-indicator"></span>
          <span class="sb-model-name"></span>
        </span>
        <span class="sb-col sb-article" role="cell"></span>
        <span class="sb-col sb-steps" role="cell">
          <strong>${standing.steps}</strong>
          ${costText ? `<span class="sb-sub">${costText}</span>` : ''}
        </span>
        <span class="sb-col sb-status" role="cell">
          <span class="racer-status-badge ${statusBadgeClass}">${statusText}</span>
          ${latencyText ? `<span class="sb-sub">${latencyText}</span>` : ''}
        </span>
        <span class="sb-col sb-actions" role="cell">
          <button type="button" class="btn-icon ${isFollowing ? 'is-active' : ''}" title="Follow Camera">
            👁
          </button>
        </span>
      `;

      // Colours go through CSSOM: the production CSP (style-src 'self') blocks inline style attributes.
      const indicator = row.querySelector('.sb-color-indicator') as HTMLElement;
      indicator.style.backgroundColor = color;
      indicator.style.color = color;

      const modelNameEl = row.querySelector('.sb-model-name') as HTMLElement;
      // Narrow column: drop the maker prefix ("Z.ai: GLM Flash Latest" -> "GLM Flash Latest").
      modelNameEl.textContent = shortModelLabel(racer.label);
      modelNameEl.title = racer.label;

      const articleEl = row.querySelector('.sb-article') as HTMLElement;
      articleEl.textContent = racerState.current;
      articleEl.title = racerState.current;

      const followBtn = row.querySelector('.btn-icon') as HTMLButtonElement;
      followBtn.setAttribute('aria-label', `Follow camera on ${racer.label}`);

      // Click row to toggle focus
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.btn-icon')) return;
        if (this.focusedRacerId === standing.racerId) {
          this.focusedRacerId = null;
        } else {
          this.focusedRacerId = standing.racerId;
        }
        this.onFocusRacer?.(this.focusedRacerId);
        this.update(state);
      });

      // Follow camera toggle
      followBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.followedRacerId === standing.racerId) {
          this.followedRacerId = null;
        } else {
          this.followedRacerId = standing.racerId;
        }
        this.onFollowRacer?.(this.followedRacerId);
        this.update(state);
      });

      table.appendChild(row);
    });

    this.element.appendChild(table);
  }

  setFollowedRacer(racerId: string | null): void {
    this.followedRacerId = racerId;
  }

  setFocusedRacer(racerId: string | null): void {
    this.focusedRacerId = racerId;
  }

  destroy(): void {
    this.element.remove();
  }
}

/** "Maker: Model name" -> "Model name"; labels without a prefix are returned unchanged. */
export function shortModelLabel(label: string): string {
  const i = label.indexOf(': ');
  const rest = i > 0 ? label.slice(i + 2).trim() : '';
  return rest || label;
}
