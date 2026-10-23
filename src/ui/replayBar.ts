/**
 * Replay Bar UI Component.
 *
 * Provides timeline scrubbing, step-by-step playback, play/pause,
 * speed adjustments, and exit replay controls.
 */
import type { ReplayController } from '../race/replay';
import { NodeScaleControl } from './nodeScaleControl';

export interface ReplayBarOptions {
  container: HTMLElement;
  controller: ReplayController;
  onExit: () => void;
  /** Node size multiplier (circles and the pictures in them). */
  nodeScale: number;
  onNodeScaleChange: (scale: number) => void;
}

export class ReplayBar {
  readonly element: HTMLElement;
  private readonly controller: ReplayController;
  private readonly onExit: () => void;
  private readonly nodeScaleControl: NodeScaleControl;

  private playPauseBtn!: HTMLButtonElement;
  private stepBackBtn!: HTMLButtonElement;
  private stepForwardBtn!: HTMLButtonElement;
  private slider!: HTMLInputElement;
  private counterLabel!: HTMLElement;
  private timeLabel!: HTMLElement;
  private speedSelect!: HTMLSelectElement;
  private exitBtn!: HTMLButtonElement;

  private unsubscribe?: () => void;

  constructor(opts: ReplayBarOptions) {
    this.controller = opts.controller;
    this.onExit = opts.onExit;
    this.nodeScaleControl = new NodeScaleControl({
      id: 'rpl-node-scale',
      value: opts.nodeScale,
      onChange: opts.onNodeScaleChange,
    });

    this.element = document.createElement('div');
    this.element.className = 'replay-bar';
    opts.container.appendChild(this.element);

    this.render();
    this.bind();
  }

  private render(): void {
    const total = this.controller.totalEvents;

    this.element.innerHTML = `
      <div class="replay-group">
        <button type="button" class="btn" id="rpl-step-back" title="Previous event (Left Arrow)">⏮</button>
        <button type="button" class="btn btn-primary" id="rpl-play-pause" title="Play/Pause (Space)">▶ Play</button>
        <button type="button" class="btn" id="rpl-step-forward" title="Next event (Right Arrow)">⏭</button>
      </div>

      <div class="replay-divider"></div>

      <div class="replay-slider-group">
        <input type="range" id="rpl-slider" class="range-slider replay-timeline-slider" min="0" max="${total}" value="0" />
        <div class="replay-meta-text">
          <span id="rpl-counter" class="replay-counter-tag">Event 0 / ${total}</span>
          <span id="rpl-time" class="replay-time-tag">+0.0s</span>
        </div>
      </div>

      <div class="replay-divider"></div>

      <div id="rpl-node-scale-slot"></div>

      <div class="replay-divider"></div>

      <div class="replay-group">
        <select id="rpl-speed" class="text-input replay-speed-select" aria-label="Replay speed">
          <option value="800">0.5x</option>
          <option value="400" selected>1x</option>
          <option value="200">2x</option>
          <option value="100">4x</option>
        </select>
        <button type="button" class="btn" id="rpl-exit">✕ Exit Replay</button>
      </div>
    `;

    this.element.querySelector('#rpl-node-scale-slot')!.replaceWith(this.nodeScaleControl.element);

    this.playPauseBtn = this.element.querySelector('#rpl-play-pause')!;
    this.stepBackBtn = this.element.querySelector('#rpl-step-back')!;
    this.stepForwardBtn = this.element.querySelector('#rpl-step-forward')!;
    this.slider = this.element.querySelector('#rpl-slider')!;
    this.counterLabel = this.element.querySelector('#rpl-counter')!;
    this.timeLabel = this.element.querySelector('#rpl-time')!;
    this.speedSelect = this.element.querySelector('#rpl-speed')!;
    this.exitBtn = this.element.querySelector('#rpl-exit')!;
  }

  /** Keep the slider in step when the scale is changed from somewhere else. */
  setNodeScale(scale: number): void {
    this.nodeScaleControl.setValue(scale);
  }

  private bind(): void {
    this.playPauseBtn.addEventListener('click', () => {
      this.controller.toggle();
    });

    this.stepBackBtn.addEventListener('click', () => {
      this.controller.pause();
      this.controller.stepBackward();
    });

    this.stepForwardBtn.addEventListener('click', () => {
      this.controller.pause();
      this.controller.stepForward();
    });

    this.slider.addEventListener('input', () => {
      this.controller.pause();
      this.controller.seek(parseInt(this.slider.value, 10));
    });

    this.speedSelect.addEventListener('change', () => {
      const delay = parseInt(this.speedSelect.value, 10);
      this.controller.setDelayMs(delay);
    });

    this.exitBtn.addEventListener('click', () => {
      this.onExit();
    });

    this.unsubscribe = this.controller.subscribe(({ index, total, event, isPlaying }) => {
      this.playPauseBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
      this.slider.value = String(index);
      this.counterLabel.textContent = `Event ${index} / ${total}`;

      if (event) {
        this.timeLabel.textContent = `+${(event.t / 1000).toFixed(1)}s`;
      } else {
        this.timeLabel.textContent = '+0.0s';
      }
    });
  }

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.element.remove();
  }
}
