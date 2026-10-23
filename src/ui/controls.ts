/**
 * Race Controls Bar Component.
 * Controls pause/resume, stop, step delay speed slider, node scale slider, fit view, and new race trigger.
 */
import type { RaceManager } from '../race/raceManager';
import type { RaceState } from '../race/types';
import { NodeScaleControl } from './nodeScaleControl';

export interface ControlsOptions {
  container: HTMLElement;
  onFitView: () => void;
  onNewRace: () => void;
  onSpeedChange: (delayMs: number) => void;
  /** Article thumbnails in graph nodes. */
  thumbnailsEnabled: boolean;
  onThumbnailsToggle: (enabled: boolean) => void;
  /** Reopens the finish screen for the last finished race. */
  onShowResults: () => void;
  /** Node size multiplier (circles and the pictures in them). */
  nodeScale: number;
  onNodeScaleChange: (scale: number) => void;
}

export class Controls {
  readonly element: HTMLElement;
  private readonly onFitView: () => void;
  private readonly onNewRace: () => void;
  private readonly onSpeedChange: (delayMs: number) => void;
  private readonly onThumbnailsToggle: (enabled: boolean) => void;
  private thumbnailsEnabled: boolean;
  private thumbsBtn!: HTMLButtonElement;
  private resultsBtn!: HTMLButtonElement;
  private readonly onShowResults: () => void;
  private readonly nodeScaleControl: NodeScaleControl;

  private pauseBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private fitBtn!: HTMLButtonElement;
  private newRaceBtn!: HTMLButtonElement;
  private speedSlider!: HTMLInputElement;
  private speedLabel!: HTMLElement;

  private currentManager: RaceManager | null = null;

  constructor(opts: ControlsOptions) {
    this.onFitView = opts.onFitView;
    this.onNewRace = opts.onNewRace;
    this.onSpeedChange = opts.onSpeedChange;
    this.onThumbnailsToggle = opts.onThumbnailsToggle;
    this.onShowResults = opts.onShowResults;
    this.thumbnailsEnabled = opts.thumbnailsEnabled;
    this.nodeScaleControl = new NodeScaleControl({
      id: 'ctrl-node-scale',
      value: opts.nodeScale,
      onChange: opts.onNodeScaleChange,
    });

    this.element = document.createElement('div');
    this.element.className = 'race-controls-bar';
    opts.container.appendChild(this.element);

    this.render();
  }

  setManager(manager: RaceManager | null): void {
    this.currentManager = manager;
    if (manager) {
      this.updateState(manager.store.state);
    }
  }

  updateState(state: RaceState): void {
    const isPaused = state.status === 'paused';
    const isRunning = state.status === 'running' || isPaused;

    this.pauseBtn.disabled = !isRunning;
    this.pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
    this.stopBtn.disabled = !isRunning;
  }

  /** Keep the slider in step when the scale is changed from somewhere else (the replay bar). */
  setNodeScale(scale: number): void {
    this.nodeScaleControl.setValue(scale);
  }

  /** Enabled once a race has finished, so its results can be reopened. */
  setResultsAvailable(available: boolean): void {
    this.resultsBtn.disabled = !available;
  }

  private syncThumbsButton(): void {
    this.thumbsBtn.setAttribute('aria-pressed', String(this.thumbnailsEnabled));
    this.thumbsBtn.classList.toggle('is-active', this.thumbnailsEnabled);
    this.thumbsBtn.textContent = this.thumbnailsEnabled ? '🖼 Pictures: On' : '🖼 Pictures: Off';
  }

  private render(): void {
    this.element.innerHTML = `
      <div class="controls-group">
        <button type="button" class="btn btn-primary" id="ctrl-pause">⏸ Pause</button>
        <button type="button" class="btn" id="ctrl-stop">⏹ Stop</button>
      </div>

      <div class="controls-divider"></div>

      <div class="speed-control-group">
        <label for="ctrl-speed-slider" class="speed-label">
          <span>Speed:</span>
          <span id="speed-val-label" class="speed-val">250ms</span>
        </label>
        <input type="range" id="ctrl-speed-slider" min="0" max="2000" step="50" value="250" class="range-slider" />
      </div>

      <div class="controls-divider"></div>

      <div id="ctrl-node-scale-slot"></div>

      <div class="controls-divider"></div>

      <div class="controls-group">
        <button type="button" class="btn" id="ctrl-results" title="Show the finish screen again (results and replay export)" disabled>🏁 Results</button>
        <button type="button" class="btn" id="ctrl-thumbs" title="Show article pictures in the graph nodes">🖼 Pictures</button>
        <button type="button" class="btn" id="ctrl-fit" title="Fit graph in view (F)">🔍 Fit View</button>
        <button type="button" class="btn" id="ctrl-new-race">⚙️ Setup</button>
      </div>
    `;

    this.element.querySelector('#ctrl-node-scale-slot')!.replaceWith(this.nodeScaleControl.element);

    this.pauseBtn = this.element.querySelector('#ctrl-pause')!;
    this.stopBtn = this.element.querySelector('#ctrl-stop')!;
    this.fitBtn = this.element.querySelector('#ctrl-fit')!;
    this.resultsBtn = this.element.querySelector('#ctrl-results')!;
    this.resultsBtn.addEventListener('click', () => this.onShowResults());
    this.thumbsBtn = this.element.querySelector('#ctrl-thumbs')!;
    this.syncThumbsButton();
    this.thumbsBtn.addEventListener('click', () => {
      this.thumbnailsEnabled = !this.thumbnailsEnabled;
      this.syncThumbsButton();
      this.onThumbnailsToggle(this.thumbnailsEnabled);
    });
    this.newRaceBtn = this.element.querySelector('#ctrl-new-race')!;
    this.speedSlider = this.element.querySelector('#ctrl-speed-slider')!;
    this.speedLabel = this.element.querySelector('#speed-val-label')!;

    this.pauseBtn.addEventListener('click', () => {
      if (!this.currentManager) return;
      if (this.currentManager.store.state.status === 'paused') {
        this.currentManager.resume();
      } else {
        this.currentManager.pause();
      }
    });

    this.stopBtn.addEventListener('click', () => {
      this.currentManager?.stop();
    });

    this.fitBtn.addEventListener('click', () => {
      this.onFitView();
    });

    this.newRaceBtn.addEventListener('click', () => {
      this.onNewRace();
    });

    this.speedSlider.addEventListener('input', () => {
      const ms = parseInt(this.speedSlider.value, 10);
      this.speedLabel.textContent = ms === 0 ? 'Instant' : `${ms}ms`;
      this.onSpeedChange(ms);
    });
  }

  destroy(): void {
    this.element.remove();
  }
}
