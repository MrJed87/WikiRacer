/**
 * Live Race Event Log Panel.
 *
 * Streams steps, model reasoning, navigation choices, loop notices,
 * and error events. Treats all text as untrusted and renders with textContent.
 */
import { racerColor } from '../graph/palette';
import type { RaceEvent, Racer } from '../race/types';

export interface LogPanelOptions {
  container: HTMLElement;
  getRacer: (id: string) => Racer | undefined;
}

export class LogPanel {
  readonly element: HTMLElement;
  private readonly getRacer: (id: string) => Racer | undefined;
  private readonly listEl: HTMLElement;
  private filterRacerId: string | null = null;
  private autoScroll = true;

  constructor(opts: LogPanelOptions) {
    this.getRacer = opts.getRacer;

    this.element = document.createElement('div');
    this.element.className = 'log-panel-container';

    // Filter controls
    const toolbar = document.createElement('div');
    toolbar.className = 'log-toolbar';
    toolbar.innerHTML = `
      <span class="log-title">Live Log</span>
      <select class="log-filter-select" aria-label="Filter log by model">
        <option value="all">All Models</option>
      </select>
    `;
    this.element.appendChild(toolbar);

    const select = toolbar.querySelector('select') as HTMLSelectElement;
    select.addEventListener('change', () => {
      this.filterRacerId = select.value === 'all' ? null : select.value;
      this.filterEntries();
    });

    this.listEl = document.createElement('div');
    this.listEl.className = 'log-entries-list';
    this.listEl.setAttribute('role', 'log');
    this.listEl.setAttribute('aria-live', 'polite');

    this.listEl.addEventListener('scroll', () => {
      const atBottom =
        this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 30;
      this.autoScroll = atBottom;
    });

    this.element.appendChild(this.listEl);
    opts.container.appendChild(this.element);
  }

  setRacers(racers: Racer[]): void {
    const select = this.element.querySelector('.log-filter-select') as HTMLSelectElement;
    const current = select.value;
    select.innerHTML = '<option value="all">All Models</option>';
    racers.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.label;
      select.appendChild(opt);
    });
    select.value = current;
  }

  addEvent(event: RaceEvent): void {
    const row = document.createElement('div');
    row.className = `log-entry log-type-${event.type.toLowerCase()}`;
    if ('racerId' in event && event.racerId) {
      row.setAttribute('data-racer', event.racerId);
      if (this.filterRacerId && this.filterRacerId !== event.racerId) {
        row.style.display = 'none';
      }
    }

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = `+${(event.t / 1000).toFixed(1)}s`;
    row.appendChild(timeSpan);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'log-content';

    if ('racerId' in event) {
      const racer = this.getRacer(event.racerId);
      const label = racer?.label ?? event.racerId;
      const color = racer ? racerColor(racer.colorIndex) : '#8a8aa8';

      const racerBadge = document.createElement('span');
      racerBadge.className = 'log-racer-badge';
      racerBadge.style.color = color;
      racerBadge.textContent = label;
      contentDiv.appendChild(racerBadge);
    }

    const descSpan = document.createElement('span');
    descSpan.className = 'log-desc';

    switch (event.type) {
      case 'RaceStarted':
        descSpan.textContent = `Race started: ${event.config.start} ➔ ${event.config.target}`;
        break;
      case 'StepTaken':
        descSpan.textContent = `clicked #${event.index} "${event.to}"`;
        if (event.reason) {
          const reasonDiv = document.createElement('div');
          reasonDiv.className = 'log-reason';
          reasonDiv.textContent = `“${event.reason}”`;
          contentDiv.appendChild(descSpan);
          contentDiv.appendChild(reasonDiv);
        } else {
          contentDiv.appendChild(descSpan);
        }
        break;
      case 'WentBack':
        descSpan.textContent = `went back to "${event.to}"`;
        if (event.reason) {
          const reasonDiv = document.createElement('div');
          reasonDiv.className = 'log-reason';
          reasonDiv.textContent = `“${event.reason}”`;
          contentDiv.appendChild(descSpan);
          contentDiv.appendChild(reasonDiv);
        } else {
          contentDiv.appendChild(descSpan);
        }
        break;
      case 'InvalidChoice':
        descSpan.textContent = event.wasted
          ? `wasted click: ${event.problem}`
          : `invalid reply: ${event.problem} (retrying)`;
        contentDiv.appendChild(descSpan);
        break;
      case 'Circling':
        descSpan.textContent = `is circling "${event.title}" (${event.visits} visits)`;
        contentDiv.appendChild(descSpan);
        break;
      case 'Arrived':
        descSpan.textContent = `🏆 ARRIVED at "${event.title}" in ${event.steps} clicks!`;
        contentDiv.appendChild(descSpan);
        break;
      case 'GaveUp':
        descSpan.textContent = `reached step limit (${event.steps} clicks)`;
        contentDiv.appendChild(descSpan);
        break;
      case 'BudgetExceeded':
        descSpan.textContent = `exceeded ${event.limit === 'usd' ? 'spending' : 'token'} cap`;
        contentDiv.appendChild(descSpan);
        break;
      case 'Stuck':
        descSpan.textContent = `dead end at "${event.title}"`;
        contentDiv.appendChild(descSpan);
        break;
      case 'AgentFailed':
        descSpan.textContent = `stopped with error: ${event.message}`;
        contentDiv.appendChild(descSpan);
        break;
      case 'RacePaused':
        descSpan.textContent = 'Race paused';
        contentDiv.appendChild(descSpan);
        break;
      case 'RaceResumed':
        descSpan.textContent = 'Race resumed';
        contentDiv.appendChild(descSpan);
        break;
      case 'RaceEnded':
        descSpan.textContent = `Race ended (${event.reason})`;
        contentDiv.appendChild(descSpan);
        break;
      default:
        descSpan.textContent = event.type;
        contentDiv.appendChild(descSpan);
        break;
    }

    row.appendChild(contentDiv);
    this.listEl.appendChild(row);

    if (this.autoScroll) {
      this.listEl.scrollTop = this.listEl.scrollHeight;
    }
  }

  private filterEntries(): void {
    const entries = this.listEl.querySelectorAll<HTMLElement>('.log-entry');
    entries.forEach((el) => {
      const racerId = el.getAttribute('data-racer');
      if (!this.filterRacerId || !racerId || racerId === this.filterRacerId) {
        el.style.display = 'flex';
      } else {
        el.style.display = 'none';
      }
    });
  }

  clear(): void {
    this.listEl.innerHTML = '';
  }

  destroy(): void {
    this.element.remove();
  }
}
