/**
 * Node scale slider: resizes the graph's circles (and the pictures inside them).
 * Shared by the live controls bar and the replay bar so both look and behave the same.
 */
import { clampNodeScale, formatNodeScale, NODE_SCALE } from '../config';

export interface NodeScaleControlOptions {
  /** Unique id for the slider so its label points at the right input. */
  id: string;
  value: number;
  onChange: (scale: number) => void;
}

export class NodeScaleControl {
  readonly element: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly valueLabel: HTMLElement;

  constructor(opts: NodeScaleControlOptions) {
    // Reuses the speed slider's classes so the two controls line up and wrap together.
    this.element = document.createElement('div');
    this.element.className = 'speed-control-group node-scale-group';
    this.element.innerHTML = `
      <label for="${opts.id}" class="speed-label">
        <span>Node scale:</span>
        <span class="speed-val node-scale-val"></span>
      </label>
      <input type="range" id="${opts.id}" class="range-slider"
        min="${NODE_SCALE.min}" max="${NODE_SCALE.max}" step="${NODE_SCALE.step}"
        title="Size of the graph nodes and their pictures (double-click to reset)" />
    `;
    this.slider = this.element.querySelector('input')!;
    this.valueLabel = this.element.querySelector('.node-scale-val')!;
    this.setValue(opts.value);

    this.slider.addEventListener('input', () => {
      const scale = clampNodeScale(Number.parseFloat(this.slider.value));
      this.setValue(scale);
      opts.onChange(scale);
    });
    this.slider.addEventListener('dblclick', () => {
      this.setValue(NODE_SCALE.default);
      opts.onChange(NODE_SCALE.default);
    });
  }

  /** Update the slider and label without notifying (for syncing with the other control). */
  setValue(scale: number): void {
    const clamped = clampNodeScale(scale);
    this.slider.value = String(clamped);
    this.slider.setAttribute('aria-valuetext', formatNodeScale(clamped));
    this.valueLabel.textContent = formatNodeScale(clamped);
  }
}
