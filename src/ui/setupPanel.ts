/**
 * Race Configuration and Setup Panel.
 *
 * Implements API key validation, searchable model selection (2–6 racers),
 * obscure start generation, target autocomplete & verification, and fairness presets.
 */
import { RACE_DEFAULTS, RACE_LIMITS, clampSetting } from '../config';
import { observedCostPerCall, type CostHistory } from '../race/costHistory';
import { REASONING_EFFORTS, type ReasoningEffort } from '../llm/types';
import { testApiKey } from '../llm/openrouter';
import {
  choosePreset,
  enrichFromCatalogue,
  fetchModels,
  filterByIntelligence,
  type PresetName,
  searchModels,
  sortModels,
  type ModelSort,
  type ModelInfo,
} from '../llm/models';
import { WikipediaClient } from '../wiki/client';
import { pickRandomTarget } from '../wiki/targetPicker';
import {
  pickObscureStart,
  validateStart,
  validateTarget,
  type StartPick,
} from '../wiki/startPicker';
import { Autocomplete } from './autocomplete';
import {
  getCostHistory,
  getCustomGroup,
  storeCustomGroup,
  getStoredApiKey,
  isApiKeyRemembered,
  storeApiKey,
  getStoredSettings,
  storeSettings,
} from './storage';
import { toast } from './toasts';
import { racerColor } from '../graph/palette';
import { copyShareLink, decodeShareConfig } from './shareLink';
import { validateReplayData, type ReplayData } from '../race/replay';
import type { RaceConfig, Racer } from '../race/types';

export interface SetupRaceParams {
  apiKey: string;
  entrants: Array<{ id: string; label: string; colorIndex: number }>;
  start: string;
  target: string;
  config: Partial<RaceConfig>;
}

export interface SetupPanelCallbacks {
  onStartRace: (params: SetupRaceParams) => void;
  onLaunchDemo: () => void;
  onLoadReplay?: (data: ReplayData) => void;
}

/**
 * Offline fallback when the OpenRouter catalogue can't be fetched.
 * IDs checked against the live OpenRouter catalogue on 2026-10-22; refresh them when models retire.
 */
const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Anthropic: Claude Sonnet 5.5',
    supportsTools: true,
    promptPerMTok: 2,
    completionPerMTok: 10,
    contextLength: 1000000,
    free: false,
  },
  {
    id: 'openai/gpt-6.1-sol',
    name: 'OpenAI: GPT-6.1 Sol',
    supportsTools: true,
    promptPerMTok: 2,
    completionPerMTok: 10,
    contextLength: 1050000,
    free: false,
  },
  {
    id: 'google/gemini-4-argon',
    name: 'Google: Gemini 4 Argon',
    supportsTools: true,
    promptPerMTok: 2,
    completionPerMTok: 10,
    contextLength: 1048576,
    free: false,
  },
  {
    id: 'deepseek/deepseek-v4-pro-0813',
    name: 'DeepSeek: DeepSeek V4 Pro 0813',
    supportsTools: true,
    promptPerMTok: 0.66,
    completionPerMTok: 1.98,
    contextLength: 1048576,
    free: false,
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Anthropic: Claude Haiku 5.5',
    supportsTools: true,
    promptPerMTok: 0.1,
    completionPerMTok: 0.5,
    contextLength: 1000000,
    free: false,
  },
  {
    id: 'openai/gpt-6-luna',
    name: 'OpenAI: GPT-6 Luna',
    supportsTools: true,
    promptPerMTok: 0.1,
    completionPerMTok: 0.5,
    contextLength: 1050000,
    free: false,
  },
  {
    id: 'google/gemini-3.8-flash',
    name: 'Google: Gemini 3.8 Flash',
    supportsTools: true,
    promptPerMTok: 0.825,
    completionPerMTok: 4.125,
    contextLength: 1048576,
    free: false,
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek: DeepSeek V4.1 Flash',
    supportsTools: true,
    promptPerMTok: 0.0342,
    completionPerMTok: 0.1368,
    contextLength: 1048576,
    free: false,
  },
];

export class SetupPanel {
  readonly element: HTMLElement;
  private readonly wiki: WikipediaClient = new WikipediaClient();
  private readonly callbacks: SetupPanelCallbacks;

  private availableModels: ModelInfo[] = [];
  /** The public catalogue, kept for its benchmark scores (the account list lacks them). */
  private catalogue: ModelInfo[] = [];
  private selectedModels: ModelInfo[] = [];
  private currentStartPick: StartPick | null = null;
  private isGeneratingStart = false;
  private targetVerified = false;
  private startVerified = false;
  private targetModeRandom!: HTMLInputElement;
  private targetPreviewBadge!: HTMLElement;
  private rerollTargetBtn!: HTMLButtonElement;
  private isPickingTarget = false;
  /** The preset that produced the current selection, cleared by manual edits. */
  private lastPreset: PresetName | null = null;
  private minIntelInput!: HTMLInputElement;
  private customPresetBtn!: HTMLButtonElement;
  /** Real per-model costs seen on this browser. */
  private costHistory: CostHistory = getCostHistory();
  private startStatusBadge!: HTMLElement;
  private startStatusRow!: HTMLElement;

  private canClose = false;
  private closeBtn!: HTMLButtonElement;

  // Form inputs
  private keyInput!: HTMLInputElement;
  private rememberKeyCheckbox!: HTMLInputElement;
  private keyStatusBadge!: HTMLElement;
  private testKeyBtn!: HTMLButtonElement;
  private modelSearchInput!: HTMLInputElement;
  private modelOptionsList!: HTMLElement;
  private selectedChipsContainer!: HTMLElement;
  private startModeRandom!: HTMLInputElement;
  private startCustomInput!: HTMLInputElement;
  private startPreviewBadge!: HTMLElement;
  private rerollStartBtn!: HTMLButtonElement;
  private targetInput!: HTMLInputElement;
  private targetStatusBadge!: HTMLElement;
  private targetAutocomplete!: Autocomplete;

  // Settings inputs
  private maxStepsInput!: HTMLInputElement;
  private linkCapInput!: HTMLInputElement;
  private temperatureInput!: HTMLInputElement;
  private circlingThresholdInput!: HTMLInputElement;
  private maxVisitsInput!: HTMLInputElement;
  private effortSelect!: HTMLSelectElement;
  private maxTokensInput!: HTMLInputElement;
  private stopOnFirstArrivalInput!: HTMLInputElement;

  private startRaceBtn!: HTMLButtonElement;

  constructor(container: HTMLElement, callbacks: SetupPanelCallbacks) {
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'setup-modal-overlay';
    container.appendChild(this.element);

    this.renderLayout();
    this.bindEvents();
    this.loadInitialData();
  }

  private renderLayout(): void {
    const saved = getStoredSettings();
    const storedKey = getStoredApiKey();
    const rememberKey = isApiKeyRemembered();

    this.element.innerHTML = `
      <div class="setup-card" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <header class="setup-header">
          <div class="setup-header-title">
            <h1 id="setup-title">⚡ Wikipedia Graph Race</h1>
            <p class="setup-subtitle">Six Degrees of Separation with Autonomous LLMs</p>
          </div>
          <div class="setup-header-actions">
            <input type="file" id="replay-file-input" accept=".json,application/json" class="is-hidden" />
            <button type="button" class="btn" id="btn-import-replay" title="Load an exported race JSON replay">📥 Replay JSON</button>
            <button type="button" class="btn btn-primary" id="btn-quick-demo">⚡ Try Offline Demo</button>
            <button type="button" class="btn btn-ghost btn-close-setup is-hidden" id="btn-close-setup" title="Close setup" aria-label="Close setup">✕</button>
          </div>
        </header>

        <div class="setup-scroll-body">
          <!-- Step 1: OpenRouter API Key -->
          <section class="setup-section">
            <div class="section-title">
              <span class="step-num">1</span>
              <h2>OpenRouter API Key</h2>
            </div>
            <p class="section-desc">
              Your key stays strictly in your browser (sessionStorage by default). Never logged, exported, or sent to any server other than OpenRouter.
            </p>

            <div class="key-input-row">
              <div class="input-with-action">
                <input type="password" id="api-key-input" class="text-input" placeholder="sk-or-v1-..." value="" autocomplete="off" spellcheck="false" />
                <button type="button" class="btn btn-ghost" id="toggle-key-visibility" title="Show/Hide Key">👁</button>
              </div>
              <button type="button" class="btn" id="btn-test-key">Test Key</button>
              <span id="key-status-badge" class="status-pill status-neutral">Not verified</span>
            </div>

            <div class="checkbox-row checkbox-row-spaced">
              <label class="checkbox-label">
                <input type="checkbox" id="remember-key-checkbox" ${rememberKey ? 'checked' : ''} />
                <span>Remember key on this browser (localStorage)</span>
              </label>
            </div>
          </section>

          <!-- Step 2: Model Selection -->
          <section class="setup-section">
            <div class="section-title">
              <span class="step-num">2</span>
              <h2>Select Models (Pick 2 to 6)</h2>
            </div>
            <p class="section-desc">
              Models receive identical starts, targets, prompt formats, and link budgets (fairness rule).
            </p>

            <div class="presets-row">
              <span class="presets-label">Presets:</span>
              <button type="button" class="preset-btn" data-preset="flagship" title="Top models from 4 different families">⭐ Flagships</button>
              <button type="button" class="preset-btn" data-preset="free" title="4 free models from different families">🎁 Free Models</button>
              <button type="button" class="preset-btn" data-preset="fast" title="The 4 cheapest models from different families">⚡ Fast & Cheap</button>
              <button type="button" class="preset-btn" data-preset="custom" id="btn-preset-custom" title="Your saved group">📌 My group</button>
              <button type="button" class="preset-btn preset-btn-save" id="btn-save-group" title="Save the selected models as your group">💾 Save group</button>
            </div>

            <div id="selected-chips" class="selected-chips-container"></div>

            <div class="model-picker-box">
              <div class="model-filter-row">
                <input type="text" id="model-search" class="text-input search-input" placeholder="Search models by name or provider..." />
                <label class="min-intel-label" for="model-sort">
                  Sort
                  <select id="model-sort" class="text-input model-sort-select">
                    <option value="name">Name</option>
                    <option value="intelligence">Intelligence</option>
                    <option value="price">Price</option>
                  </select>
                </label>
                <label class="min-intel-label" for="min-intelligence" title="Artificial Analysis Intelligence Index (from OpenRouter). Today's models score roughly 5 to 60. Models without a score are hidden while a minimum is set. Applies to the list and the preset buttons.">
                  Min intelligence
                  <input type="number" id="min-intelligence" class="text-input min-intel-input" min="0" max="100" step="1" placeholder="Any" value="${saved.minIntelligence ?? ''}" />
                </label>
              </div>
              <div class="model-list-meta">
                <p id="model-list-note" class="model-list-note">Showing all OpenRouter models. Verify your key to show only the ones your account can run.</p>
                <span id="model-count" class="model-count"></span>
              </div>
              <div id="model-options" class="model-options-list" role="listbox">
                <div class="loading-state">Loading model list from OpenRouter...</div>
              </div>
            </div>
          </section>

          <!-- Step 3: Start & Target Articles -->
          <section class="setup-section">
            <div class="section-title">
              <span class="step-num">3</span>
              <h2>Start & Target Articles</h2>
            </div>

            <div class="route-grid">
              <!-- Start article -->
              <div class="route-field">
                <label class="field-label">Start Article</label>
                <div class="radio-group">
                  <label class="radio-label">
                    <input type="radio" name="start-mode" value="random" checked />
                    <span>🎲 Obscure Start (&lt;100 views/day)</span>
                  </label>
                  <label class="radio-label">
                    <input type="radio" name="start-mode" value="custom" />
                    <span>Custom</span>
                  </label>
                </div>

                <div id="random-start-row" class="start-preview-row">
                  <span id="start-preview-badge" class="start-preview-badge">Generating obscure start...</span>
                  <button type="button" class="btn btn-small" id="btn-reroll-start">🔄 Re-roll</button>
                </div>

                <input type="text" id="start-custom-input" class="text-input start-custom-input is-hidden" placeholder="Title or Wikipedia link, e.g. Byzantine Empire" />
                <div class="field-helper start-status-row is-hidden" id="start-status-row">
                  <span id="start-status-badge" class="status-pill status-neutral">Enter a start article</span>
                </div>
              </div>

              <!-- Target article -->
              <div class="route-field">
                <label class="field-label" for="target-input">Target Article</label>
                <div class="radio-group">
                  <label class="radio-label">
                    <input type="radio" name="target-mode" value="random" checked />
                    <span>🎯 Well-known (random)</span>
                  </label>
                  <label class="radio-label">
                    <input type="radio" name="target-mode" value="custom" />
                    <span>Custom</span>
                  </label>
                </div>

                <div id="random-target-row" class="start-preview-row">
                  <span id="target-preview-badge" class="start-preview-badge">Picking a target...</span>
                  <button type="button" class="btn btn-small" id="btn-reroll-target">🔄 Re-roll</button>
                </div>

                <div class="target-input-wrapper is-hidden" id="target-autocomplete-container">
                  <input type="text" id="target-input" class="text-input" placeholder="Title or Wikipedia link, e.g. Philosophy" value="" />
                </div>
                <div class="field-helper">
                  <span id="target-status-badge" class="status-pill status-neutral">Verifying target...</span>
                </div>
              </div>
            </div>
          </section>

          <!-- Step 4: Race Rules -->
          <details class="setup-details">
            <summary class="details-summary">⚙️ Race Parameters & Fairness Settings</summary>
            <div class="settings-grid">
              <div class="setting-item">
                <label for="setting-max-steps">Max Clicks per Model</label>
                <input type="number" id="setting-max-steps" class="text-input" min="${RACE_LIMITS.maxSteps.min}" max="${RACE_LIMITS.maxSteps.max}" value="${saved.maxSteps ?? RACE_DEFAULTS.maxSteps}" />
              </div>

              <div class="setting-item">
                <label for="setting-link-cap">Links Offered per Page</label>
                <input type="number" id="setting-link-cap" class="text-input" min="${RACE_LIMITS.linkCap.min}" max="${RACE_LIMITS.linkCap.max}" value="${saved.linkCap ?? RACE_DEFAULTS.linkCap}" />
              </div>

              <div class="setting-item">
                <label for="setting-temperature">Sampling Temperature</label>
                <input type="number" id="setting-temperature" class="text-input" step="0.1" min="${RACE_LIMITS.temperature.min}" max="${RACE_LIMITS.temperature.max}" value="${saved.temperature ?? RACE_DEFAULTS.temperature}" />
              </div>

              <div class="setting-item">
                <label for="setting-circling" title="Visits to one page that mark a model as circling and warn it. Does not block anything.">Circling Warning (Visits)</label>
                <input type="number" id="setting-circling" class="text-input" min="${RACE_LIMITS.circlingThreshold.min}" max="${RACE_LIMITS.circlingThreshold.max}" value="${saved.circlingThreshold ?? RACE_DEFAULTS.circlingThreshold}" />
              </div>

              <div class="setting-item">
                <label for="setting-max-visits" title="After this many visits a page is no longer offered to that model, and it can't go back to it.">Max Visits per Page</label>
                <input type="number" id="setting-max-visits" class="text-input" min="${RACE_LIMITS.maxVisitsPerPage.min}" max="${RACE_LIMITS.maxVisitsPerPage.max}" value="${saved.maxVisitsPerPage ?? RACE_DEFAULTS.maxVisitsPerPage}" />
              </div>

              <div class="setting-item">
                <label for="setting-effort" title="How hard reasoning models think before answering. On most providers this is a share of Max Reply Tokens (Low is about 20%), so the rest is left for the answer. Same for every model; ignored by models that don't reason.">Reasoning Effort</label>
                <select id="setting-effort" class="text-input">
                  ${REASONING_EFFORTS.map((e) => `<option value="${e}" ${(saved.reasoningEffort ?? RACE_DEFAULTS.reasoningEffort) === e ? 'selected' : ''}>${e[0]!.toUpperCase()}${e.slice(1)}</option>`).join('')}
                </select>
              </div>

              <div class="setting-item">
                <label for="setting-max-tokens" title="Most tokens one reply may use, thinking included. A reply that hits it before answering wastes the click but is still billed.">Max Reply Tokens</label>
                <input type="number" id="setting-max-tokens" class="text-input" min="${RACE_LIMITS.maxOutputTokens.min}" max="${RACE_LIMITS.maxOutputTokens.max}" step="256" value="${saved.maxOutputTokens ?? RACE_DEFAULTS.maxOutputTokens}" />
              </div>

              <div class="setting-item full-width">
                <label class="checkbox-label">
                  <input type="checkbox" id="setting-stop-first" ${saved.stopOnFirstArrival ? 'checked' : ''} />
                  <span>Stop race immediately upon first arrival (uncheck to watch everyone finish or circle)</span>
                </label>
              </div>
            </div>
          </details>
        </div>

        <footer class="setup-footer">
          <div class="setup-footer-left">
            <button type="button" class="btn" id="btn-copy-share-link" title="Copy shareable configuration link to clipboard">🔗 Share Setup</button>
            <div class="footer-notice" id="validation-notice">Select 2 to 6 models to begin.</div>
          </div>
          <button type="button" class="btn btn-primary btn-large" id="btn-start-race" disabled>🚀 Start Race</button>
        </footer>
      </div>
    `;

    // Cache element references
    this.closeBtn = this.element.querySelector('#btn-close-setup')!;
    this.keyInput = this.element.querySelector('#api-key-input')!;
    if (storedKey) {
      this.keyInput.value = storedKey;
    }
    this.rememberKeyCheckbox = this.element.querySelector('#remember-key-checkbox')!;
    this.keyStatusBadge = this.element.querySelector('#key-status-badge')!;
    this.testKeyBtn = this.element.querySelector('#btn-test-key')!;
    this.modelSearchInput = this.element.querySelector('#model-search')!;
    this.modelOptionsList = this.element.querySelector('#model-options')!;
    this.selectedChipsContainer = this.element.querySelector('#selected-chips')!;
    this.startModeRandom = this.element.querySelector('input[name="start-mode"][value="random"]')!;
    this.startCustomInput = this.element.querySelector('#start-custom-input')!;
    this.startStatusBadge = this.element.querySelector('#start-status-badge')!;
    this.startStatusRow = this.element.querySelector('#start-status-row')!;
    this.startPreviewBadge = this.element.querySelector('#start-preview-badge')!;
    this.rerollStartBtn = this.element.querySelector('#btn-reroll-start')!;
    this.targetInput = this.element.querySelector('#target-input')!;
    this.targetModeRandom = this.element.querySelector(
      'input[name="target-mode"][value="random"]',
    )!;
    this.targetPreviewBadge = this.element.querySelector('#target-preview-badge')!;
    this.rerollTargetBtn = this.element.querySelector('#btn-reroll-target')!;
    this.targetStatusBadge = this.element.querySelector('#target-status-badge')!;
    this.maxStepsInput = this.element.querySelector('#setting-max-steps')!;
    this.linkCapInput = this.element.querySelector('#setting-link-cap')!;
    this.temperatureInput = this.element.querySelector('#setting-temperature')!;
    this.circlingThresholdInput = this.element.querySelector('#setting-circling')!;
    this.maxVisitsInput = this.element.querySelector('#setting-max-visits')!;
    this.effortSelect = this.element.querySelector('#setting-effort')!;
    this.maxTokensInput = this.element.querySelector('#setting-max-tokens')!;
    this.minIntelInput = this.element.querySelector('#min-intelligence')!;
    this.customPresetBtn = this.element.querySelector('#btn-preset-custom')!;
    this.syncCustomPresetButton();
    this.stopOnFirstArrivalInput = this.element.querySelector('#setting-stop-first')!;
    this.startRaceBtn = this.element.querySelector('#btn-start-race')!;

    const autocompleteContainer = this.element.querySelector(
      '#target-autocomplete-container',
    ) as HTMLElement;
    this.targetAutocomplete = new Autocomplete({
      input: this.targetInput,
      container: autocompleteContainer,
      fetchSuggestions: (q) => this.wiki.search(q, 8),
      onSelect: (val) => {
        this.validateTargetInput(val);
      },
    });
  }

  private bindEvents(): void {
    // Close button & Escape key
    this.closeBtn?.addEventListener('click', () => {
      if (this.canClose) this.hide();
    });

    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.canClose) {
        e.preventDefault();
        this.hide();
      }
    });

    // Quick Demo button
    this.element.querySelector('#btn-quick-demo')?.addEventListener('click', () => {
      this.callbacks.onLaunchDemo();
    });

    // Replay File Import
    const replayFileInput = this.element.querySelector('#replay-file-input') as HTMLInputElement;
    const importReplayBtn = this.element.querySelector('#btn-import-replay') as HTMLButtonElement;
    importReplayBtn?.addEventListener('click', () => {
      replayFileInput.value = '';
      replayFileInput.click();
    });

    replayFileInput?.addEventListener('change', () => {
      const file = replayFileInput.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target?.result as string;
          const raw = JSON.parse(text) as unknown;
          const replayData = validateReplayData(raw);
          toast.show(`Loaded replay with ${replayData.events.length} events!`, { type: 'success' });
          this.callbacks.onLoadReplay?.(replayData);
        } catch (err) {
          toast.show(`Invalid replay file: ${err instanceof Error ? err.message : String(err)}`, {
            type: 'error',
          });
        }
      };
      reader.readAsText(file);
    });

    // Copy Share Link
    this.element.querySelector('#btn-copy-share-link')?.addEventListener('click', async () => {
      const isRandom = this.startModeRandom.checked;
      const start = isRandom
        ? (this.currentStartPick?.title ?? '')
        : this.startCustomInput.value.trim();
      const target = this.targetInput.value.trim();

      const ok = await copyShareLink({
        start,
        target,
        models: this.selectedModels.map((m) => m.id),
        maxSteps: parseInt(this.maxStepsInput.value, 10),
        linkCap: parseInt(this.linkCapInput.value, 10),
        temperature: parseFloat(this.temperatureInput.value),
        circlingThreshold: parseInt(this.circlingThresholdInput.value, 10),
        maxVisitsPerPage: parseInt(this.maxVisitsInput.value, 10),
        reasoningEffort: this.reasoningEffort(),
        maxOutputTokens: parseInt(this.maxTokensInput.value, 10),
        stopOnFirstArrival: this.stopOnFirstArrivalInput.checked,
      });

      if (ok) {
        toast.show('Share link copied to clipboard! (API key strictly excluded)', {
          type: 'success',
        });
      } else {
        toast.show('Could not copy link to clipboard.', { type: 'warning' });
      }
    });

    // Toggle API Key visibility
    this.element.querySelector('#toggle-key-visibility')?.addEventListener('click', () => {
      this.keyInput.type = this.keyInput.type === 'password' ? 'text' : 'password';
    });

    // Test API Key
    this.testKeyBtn.addEventListener('click', () => {
      void this.checkApiKey(true);
    });

    // Key input changes
    this.keyInput.addEventListener('input', () => {
      this.keyStatusBadge.className = 'status-pill status-neutral';
      this.keyStatusBadge.textContent = 'Unverified';
      this.updateValidation();
    });

    // Model search
    this.modelSearchInput.addEventListener('input', () => {
      this.renderModelOptions();
    });

    // Intelligence filter: re-filters the list and re-runs the active preset.
    const sortSelect = this.element.querySelector('#model-sort') as HTMLSelectElement;
    sortSelect.value = getStoredSettings().modelSort ?? 'name';
    sortSelect.addEventListener('change', () => {
      storeSettings({ ...getStoredSettings(), modelSort: this.modelSort() });
      this.renderModelOptions();
    });

    this.minIntelInput.addEventListener('input', () => {
      storeSettings({ ...getStoredSettings(), minIntelligence: this.minIntelligence() });
      if (this.lastPreset) this.applyPreset(this.lastPreset);
      this.renderModelOptions();
    });

    this.element.querySelector('#btn-save-group')?.addEventListener('click', () => {
      if (this.selectedModels.length < RACE_DEFAULTS.minModels) {
        toast.show(`Select at least ${RACE_DEFAULTS.minModels} models to save a group.`, {
          type: 'warning',
        });
        return;
      }
      storeCustomGroup(this.selectedModels.map((m) => m.id));
      this.syncCustomPresetButton();
      toast.show(`Saved ${this.selectedModels.length} models as your group.`, { type: 'success' });
    });

    // Presets
    this.element.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.getAttribute('data-preset');
        if (preset) this.applyPreset(preset);
      });
    });

    // Start Mode radio switch
    this.element.querySelectorAll<HTMLInputElement>('input[name="start-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const isRandom = this.startModeRandom.checked;
        (this.element.querySelector('#random-start-row') as HTMLElement).style.display = isRandom
          ? 'flex'
          : 'none';
        this.startCustomInput.style.display = isRandom ? 'none' : 'block';
        this.startStatusRow.style.display = isRandom ? 'none' : 'block';
        if (!isRandom && this.startCustomInput.value.trim() && !this.startVerified) {
          void this.validateStartInput(this.startCustomInput.value);
        }
        if (isRandom && !this.currentStartPick) {
          void this.generateObscureStart();
        }
        this.updateValidation();
      });
    });

    this.rerollStartBtn.addEventListener('click', () => {
      void this.generateObscureStart();
    });

    this.startCustomInput.addEventListener('input', () => {
      // Any edit invalidates the last check; it re-runs on blur.
      this.startVerified = false;
      this.startStatusBadge.className = 'status-pill status-neutral';
      this.startStatusBadge.textContent = 'Checks when you leave the field';
      this.updateValidation();
    });
    this.startCustomInput.addEventListener('blur', () => {
      void this.validateStartInput(this.startCustomInput.value);
    });

    // Target mode radio switch (same pattern as the start)
    this.element
      .querySelectorAll<HTMLInputElement>('input[name="target-mode"]')
      .forEach((radio) => {
        radio.addEventListener('change', () => {
          this.showTargetMode(this.targetModeRandom.checked);
          if (this.targetModeRandom.checked) void this.generateRandomTarget();
          else {
            this.targetVerified = false;
            void this.validateTargetInput(this.targetInput.value);
            this.targetInput.focus();
          }
        });
      });
    this.rerollTargetBtn.addEventListener('click', () => {
      void this.generateRandomTarget();
    });

    this.targetInput.addEventListener('input', () => {
      // Any edit invalidates the last check; it re-runs on blur.
      this.targetVerified = false;
      this.targetStatusBadge.className = 'status-pill status-neutral';
      this.targetStatusBadge.textContent = 'Checks when you leave the field';
      this.updateValidation();
    });

    // Target input verification on blur
    this.targetInput.addEventListener('blur', () => {
      void this.validateTargetInput(this.targetInput.value);
    });

    // Start Race Button
    this.startRaceBtn.addEventListener('click', () => {
      this.handleStartRace();
    });
  }

  private async loadInitialData(): Promise<void> {
    // Load models list
    try {
      this.availableModels = await fetchModels();
      this.catalogue = this.availableModels;
    } catch {
      this.availableModels = FALLBACK_MODELS;
    }

    // Default select Flagship preset
    this.applyPreset('flagship');

    // Check URL hash for shared config
    try {
      const hashConfig = decodeShareConfig(window.location.hash);
      if (hashConfig) {
        if (hashConfig.target) {
          this.targetInput.value = hashConfig.target;
          (
            this.element.querySelector(
              'input[name="target-mode"][value="custom"]',
            ) as HTMLInputElement
          ).checked = true;
          this.showTargetMode(false);
        }
        if (hashConfig.start) {
          const customRadio = this.element.querySelector(
            'input[name="start-mode"][value="custom"]',
          ) as HTMLInputElement;
          if (customRadio) customRadio.checked = true;
          this.startCustomInput.value = hashConfig.start;
          this.startCustomInput.style.display = 'block';
          this.startStatusRow.style.display = 'block';
          void this.validateStartInput(hashConfig.start);
          (this.element.querySelector('#random-start-row') as HTMLElement).style.display = 'none';
        }
        if (hashConfig.maxSteps) this.maxStepsInput.value = String(hashConfig.maxSteps);
        if (hashConfig.linkCap) this.linkCapInput.value = String(hashConfig.linkCap);
        if (hashConfig.temperature !== undefined)
          this.temperatureInput.value = String(hashConfig.temperature);
        if (hashConfig.circlingThreshold)
          this.circlingThresholdInput.value = String(hashConfig.circlingThreshold);
        if (hashConfig.maxVisitsPerPage)
          this.maxVisitsInput.value = String(hashConfig.maxVisitsPerPage);
        if (hashConfig.reasoningEffort) this.effortSelect.value = hashConfig.reasoningEffort;
        if (hashConfig.maxOutputTokens)
          this.maxTokensInput.value = String(hashConfig.maxOutputTokens);
        if (hashConfig.stopOnFirstArrival !== undefined)
          this.stopOnFirstArrivalInput.checked = hashConfig.stopOnFirstArrival;

        if (hashConfig.models && hashConfig.models.length > 0) {
          const matched = hashConfig.models.map((id) => {
            const found = this.availableModels.find((m) => m.id === id);
            if (found) return found;
            return {
              id,
              name: id.split('/').pop() || id,
              supportsTools: true,
              promptPerMTok: null,
              completionPerMTok: null,
              contextLength: null,
              free: false,
            };
          });
          if (matched.length > 0) {
            this.selectedModels = matched.slice(0, RACE_DEFAULTS.maxModels);
            this.renderSelectedChips();
            this.renderModelOptions();
          }
        }
      }
    } catch {
      // Ignore hash parse errors
    }

    // If key exists, test it quietly
    if (this.keyInput.value.trim()) {
      void this.checkApiKey(false);
    }

    // Target first (random or shared), then the start, so the start picker can avoid the target.
    if (this.targetModeRandom.checked) await this.generateRandomTarget();
    else await this.validateTargetInput(this.targetInput.value);
    void this.generateObscureStart();
  }

  private showTargetMode(isRandom: boolean): void {
    (this.element.querySelector('#random-target-row') as HTMLElement).style.display = isRandom
      ? 'flex'
      : 'none';
    (this.element.querySelector('#target-autocomplete-container') as HTMLElement).style.display =
      isRandom ? 'none' : 'block';
  }

  /** Picks a random well-known target (never the current start) and verifies it. */
  private async generateRandomTarget(): Promise<void> {
    if (this.isPickingTarget) return;
    this.isPickingTarget = true;
    this.targetVerified = false;
    this.targetPreviewBadge.textContent = 'Picking a well-known article...';
    this.targetPreviewBadge.className = 'start-preview-badge is-loading';
    this.targetStatusBadge.className = 'status-pill status-neutral';
    this.targetStatusBadge.textContent = 'Verifying...';
    this.rerollTargetBtn.disabled = true;
    this.updateValidation();
    const start = this.startModeRandom.checked
      ? this.currentStartPick?.title
      : this.startCustomInput.value.trim();
    try {
      const pick = await pickRandomTarget(this.wiki, { exclude: start ? [start] : [] });
      // Ignore the result if the user switched to Custom meanwhile.
      if (!this.targetModeRandom.checked) return;
      this.targetInput.value = pick.title;
      this.targetPreviewBadge.textContent =
        pick.source === 'vital' ? `${pick.title} (Vital article)` : pick.title;
      this.targetPreviewBadge.className = 'start-preview-badge';
      this.targetStatusBadge.className = 'status-pill status-success';
      this.targetStatusBadge.textContent = `Valid (${pick.incomingLinks}+ incoming links)`;
      this.targetVerified = true;
    } catch (e) {
      this.targetPreviewBadge.textContent = 'No target picked';
      this.targetPreviewBadge.className = 'start-preview-badge';
      this.targetStatusBadge.className = 'status-pill status-danger';
      this.targetStatusBadge.textContent = `Couldn't pick a target (${e instanceof Error ? e.message : 'network error'}). Re-roll or use Custom.`;
    } finally {
      this.isPickingTarget = false;
      this.rerollTargetBtn.disabled = false;
      this.updateValidation();
    }
  }

  private async checkApiKey(showToastOnSuccess: boolean): Promise<boolean> {
    const key = this.keyInput.value.trim();
    if (!key) {
      this.keyStatusBadge.className = 'status-pill status-danger';
      this.keyStatusBadge.textContent = 'Key required';
      return false;
    }

    this.keyStatusBadge.className = 'status-pill status-neutral';
    this.keyStatusBadge.textContent = 'Verifying...';

    const check = await testApiKey(key);
    if (check.ok) {
      this.keyStatusBadge.className = 'status-pill status-success';
      const balance = check.limitRemaining !== null ? ` ($${check.limitRemaining.toFixed(2)})` : '';
      this.keyStatusBadge.textContent = `Valid${balance}`;
      if (showToastOnSuccess) toast.show('OpenRouter API key verified!', { type: 'success' });
      storeApiKey(key, this.rememberKeyCheckbox.checked);
      this.updateValidation();
      void this.loadAccountModels(key);
      return true;
    } else {
      this.keyStatusBadge.className = 'status-pill status-danger';
      this.keyStatusBadge.textContent = 'Invalid key';
      toast.show(check.reason, { type: 'error' });
      this.updateValidation();
      return false;
    }
  }

  private async generateObscureStart(): Promise<void> {
    if (this.isGeneratingStart) return;
    this.isGeneratingStart = true;
    this.startPreviewBadge.textContent = 'Searching obscure Wikipedia articles...';
    this.startPreviewBadge.className = 'start-preview-badge is-loading';
    this.rerollStartBtn.disabled = true;

    try {
      const pick = await pickObscureStart(this.wiki, {
        target: this.targetInput.value.trim(),
      });
      this.currentStartPick = pick;
      this.startPreviewBadge.textContent = `${pick.title} (~${Math.round(pick.avgDailyViews)} views/day, ${pick.outgoingLinks} links)`;
      this.startPreviewBadge.className = 'start-preview-badge';
    } catch {
      this.startPreviewBadge.textContent = 'Cothill Fen (fallback obscure start)';
      this.startPreviewBadge.className = 'start-preview-badge';
      this.currentStartPick = {
        title: 'Cothill Fen',
        avgDailyViews: 12,
        outgoingLinks: 24,
        incomingLinks: 5,
        attempts: 1,
      };
    } finally {
      this.isGeneratingStart = false;
      this.rerollStartBtn.disabled = false;
      this.updateValidation();
    }
  }

  private async validateStartInput(input: string): Promise<boolean> {
    if (!input.trim()) {
      this.startVerified = false;
      this.startStatusBadge.className = 'status-pill status-danger';
      this.startStatusBadge.textContent = 'Start article required';
      this.updateValidation();
      return false;
    }
    this.startStatusBadge.className = 'status-pill status-neutral';
    this.startStatusBadge.textContent = 'Verifying...';
    let res: Awaited<ReturnType<typeof validateStart>>;
    try {
      res = await validateStart(this.wiki, input);
    } catch (e) {
      this.startVerified = false;
      this.startStatusBadge.className = 'status-pill status-danger';
      this.startStatusBadge.textContent = `Couldn't check (${e instanceof Error ? e.message : 'network error'}). Retype to retry.`;
      this.updateValidation();
      return false;
    }
    // Ignore a stale answer if the field changed while we were checking.
    if (this.startCustomInput.value !== input) return this.startVerified;
    if (res.ok) {
      this.startCustomInput.value = res.title;
      this.startStatusBadge.className = 'status-pill status-success';
      this.startStatusBadge.textContent = `Valid (${res.outgoingLinks} links to follow)`;
      this.startVerified = true;
    } else {
      this.startStatusBadge.className = 'status-pill status-danger';
      this.startStatusBadge.textContent = res.reason;
      this.startVerified = false;
    }
    this.updateValidation();
    return this.startVerified;
  }

  private async validateTargetInput(title: string): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed) {
      this.targetStatusBadge.className = 'status-pill status-danger';
      this.targetStatusBadge.textContent = 'Target required';
      this.targetVerified = false;
      this.updateValidation();
      return false;
    }

    this.targetStatusBadge.className = 'status-pill status-neutral';
    this.targetStatusBadge.textContent = 'Verifying...';

    let res: Awaited<ReturnType<typeof validateTarget>>;
    try {
      res = await validateTarget(this.wiki, trimmed);
    } catch (e) {
      // Network or rate-limit failure: say so instead of leaving the badge on "Verifying..." forever.
      this.targetStatusBadge.className = 'status-pill status-danger';
      this.targetStatusBadge.textContent = `Couldn't check (${e instanceof Error ? e.message : 'network error'}). Retype to retry.`;
      this.targetVerified = false;
      this.updateValidation();
      return false;
    }
    if (res.ok) {
      this.targetInput.value = res.title;
      this.targetStatusBadge.className = 'status-pill status-success';
      this.targetStatusBadge.textContent = `Valid (${res.incomingLinks}+ incoming links)`;
      this.targetVerified = true;
    } else {
      this.targetStatusBadge.className = 'status-pill status-danger';
      this.targetStatusBadge.textContent = res.reason;
      this.targetVerified = false;
    }
    this.updateValidation();
    return this.targetVerified;
  }

  /** Re-reads real per-model costs after a race so the list and presets use them. */
  refreshCostHistory(): void {
    this.costHistory = getCostHistory();
    this.renderModelOptions();
  }

  private reasoningEffort(): ReasoningEffort {
    const v = this.effortSelect.value as ReasoningEffort;
    return REASONING_EFFORTS.includes(v) ? v : RACE_DEFAULTS.reasoningEffort;
  }

  private modelSort(): ModelSort {
    const v = (this.element.querySelector('#model-sort') as HTMLSelectElement | null)?.value;
    return v === 'intelligence' || v === 'price' ? v : 'name';
  }

  private minIntelligence(): number | null {
    const v = parseFloat(this.minIntelInput.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  private syncCustomPresetButton(): void {
    const group = getCustomGroup();
    this.customPresetBtn.disabled = group.length === 0;
    this.customPresetBtn.title = group.length
      ? `Your saved group: ${group.join(', ')}`
      : 'Select models and press Save group first';
  }

  /** Loads the saved group, keeping only models this account can run. */
  private applyCustomGroup(): void {
    const group = getCustomGroup();
    const available = this.availableModels.length ? this.availableModels : FALLBACK_MODELS;
    const found = group.flatMap((id) => available.filter((m) => m.id === id));
    const missing = group.length - found.length;
    if (found.length === 0) {
      toast.show('None of your saved models are available right now.', { type: 'warning' });
      return;
    }
    if (missing > 0) {
      toast.show(
        `${missing} saved model${missing === 1 ? ' is' : 's are'} not available on your account and were skipped.`,
        {
          type: 'warning',
        },
      );
    }
    this.lastPreset = null;
    this.selectedModels = found.slice(0, RACE_DEFAULTS.maxModels);
    this.renderSelectedChips();
    this.renderModelOptions();
    this.updateValidation();
  }

  private applyPreset(name: string): void {
    if (name === 'custom') {
      this.applyCustomGroup();
      return;
    }
    if (name !== 'flagship' && name !== 'free' && name !== 'fast') return;
    const available = filterByIntelligence(
      this.availableModels.length ? this.availableModels : FALLBACK_MODELS,
      this.minIntelligence(),
    );
    const candidates = choosePreset(name as PresetName, available, (id) =>
      observedCostPerCall(this.costHistory, id),
    );
    if (candidates.length < 2) {
      toast.show(
        this.minIntelligence() !== null
          ? 'Not enough models meet this preset and your minimum intelligence.'
          : 'Not enough models available for this preset on your account.',
        {
          type: 'warning',
        },
      );
      return;
    }
    this.lastPreset = name as PresetName;
    this.selectedModels = candidates;
    this.renderSelectedChips();
    this.renderModelOptions();
    this.updateValidation();
  }

  /**
   * Swaps the catalogue for the account-filtered list once a key is verified. Falls back to the
   * public list (with a note) if OpenRouter refuses the filtered list for this key.
   */
  private async loadAccountModels(key: string): Promise<void> {
    const note = this.element.querySelector('#model-list-note') as HTMLElement;
    let models: ModelInfo[];
    try {
      models = await fetchModels({ apiKey: key });
    } catch {
      note.textContent =
        "Couldn't get the list filtered for your account, so all models are shown. Some may not run.";
      note.className = 'model-list-note is-warning';
      return;
    }
    if (models.length === 0) {
      note.textContent =
        'Your account settings allow no models. Check your OpenRouter provider and privacy settings.';
      note.className = 'model-list-note is-warning';
      return;
    }
    if (this.catalogue.length === 0) {
      // The public list failed at startup; try once more so scores are available.
      try {
        this.catalogue = await fetchModels();
      } catch {
        // Scores stay unavailable; the list still works without them.
      }
    }
    this.availableModels = enrichFromCatalogue(models, this.catalogue);
    note.textContent = `Showing ${models.length} models your account can run.`;
    note.className = 'model-list-note is-ok';

    const runnable = new Set(models.map((m) => m.id));
    const dropped = this.selectedModels.filter((m) => !runnable.has(m.id));
    if (this.lastPreset) {
      // Re-run the preset against the filtered list so it only picks runnable models.
      this.applyPreset(this.lastPreset);
    } else if (dropped.length) {
      this.selectedModels = this.selectedModels.filter((m) => runnable.has(m.id));
      this.renderSelectedChips();
      this.updateValidation();
    }
    if (dropped.length) {
      toast.show(
        `Removed ${dropped.length} model${dropped.length === 1 ? '' : 's'} your account can't run: ${dropped.map((m) => m.name).join(', ')}`,
        { type: 'warning', durationMs: 6000 },
      );
    }
    this.renderModelOptions();
  }

  private renderSelectedChips(): void {
    this.selectedChipsContainer.innerHTML = '';
    this.selectedModels.forEach((m, idx) => {
      const chip = document.createElement('div');
      chip.className = 'model-chip';
      const color = racerColor(idx);

      chip.innerHTML = `
        <span class="chip-color-dot"></span>
        <span class="chip-name"></span>
        <button type="button" class="chip-remove">✕</button>
      `;

      // Colours go through CSSOM: the production CSP (style-src 'self') blocks inline style attributes.
      const dot = chip.querySelector('.chip-color-dot') as HTMLElement;
      dot.style.backgroundColor = color;
      dot.style.color = color;

      const chipName = chip.querySelector('.chip-name') as HTMLElement;
      chipName.textContent = m.name;
      chipName.title = m.name;

      const chipRemove = chip.querySelector('.chip-remove') as HTMLButtonElement;
      chipRemove.setAttribute('aria-label', `Remove ${m.name}`);
      chipRemove.addEventListener('click', () => {
        this.selectedModels = this.selectedModels.filter((sm) => sm.id !== m.id);
        this.lastPreset = null;
        this.renderSelectedChips();
        this.renderModelOptions();
        this.updateValidation();
      });

      this.selectedChipsContainer.appendChild(chip);
    });
  }

  private renderModelOptions(): void {
    const query = this.modelSearchInput.value.trim();
    const all = this.availableModels.length ? this.availableModels : FALLBACK_MODELS;
    const source = filterByIntelligence(all, this.minIntelligence());
    // No display cap: a row limit would silently hide most of a filtered list.
    const matches = sortModels(searchModels(source, query, Infinity), this.modelSort(), (id) =>
      observedCostPerCall(this.costHistory, id),
    );
    const countEl = this.element.querySelector('#model-count') as HTMLElement | null;
    if (countEl) {
      countEl.textContent =
        matches.length === all.length
          ? `${all.length} models`
          : `${matches.length} of ${all.length} models match`;
    }

    this.modelOptionsList.innerHTML = '';
    if (!matches.length) {
      const scored = all.some((m) => typeof m.intelligence === 'number');
      this.modelOptionsList.innerHTML =
        this.minIntelligence() !== null && !scored
          ? '<div class="no-results">Intelligence scores aren\'t available right now, so the minimum can\'t be applied. Clear it to see all models.</div>'
          : this.minIntelligence() !== null && source.length === 0
            ? '<div class="no-results">No models meet this minimum intelligence. Try a lower number.</div>'
            : '<div class="no-results">No matching models found.</div>';
      return;
    }

    matches.forEach((m) => {
      const isSelected = this.selectedModels.some((sm) => sm.id === m.id);
      const row = document.createElement('div');
      row.className = `model-option-row ${isSelected ? 'is-selected' : ''}`;

      const priceText = m.free
        ? 'Free'
        : m.promptPerMTok !== null && m.completionPerMTok !== null
          ? `$${m.promptPerMTok.toFixed(2)} / $${m.completionPerMTok.toFixed(2)} M`
          : '';

      row.innerHTML = `
        <div class="model-opt-info">
          <div class="model-opt-name"></div>
          <div class="model-opt-id"></div>
        </div>
        <div class="model-opt-meta">
          ${typeof m.intelligence === 'number' ? `<span class="badge-tag tag-intel" title="Artificial Analysis Intelligence Index">🧠 ${m.intelligence.toFixed(1)}</span>` : ''}
          ${m.supportsTools ? '<span class="badge-tag tag-tool">Tools</span>' : '<span class="badge-tag tag-json">JSON</span>'}
          <span class="model-opt-price">${priceText}</span>
          <span class="model-opt-observed"></span>
        </div>
      `;

      (row.querySelector('.model-opt-name') as HTMLElement).textContent = m.name;
      (row.querySelector('.model-opt-id') as HTMLElement).textContent = m.id;
      const seen = this.costHistory[m.id];
      if (seen && seen.calls > 0) {
        const observed = row.querySelector('.model-opt-observed') as HTMLElement;
        observed.textContent = `you: $${(seen.costUsd / seen.calls).toFixed(5)}/click`;
        observed.title = `Average real cost on this browser over ${seen.calls} model calls in ${seen.races} race${seen.races === 1 ? '' : 's'}`;
      }

      row.addEventListener('click', () => {
        if (isSelected) {
          this.selectedModels = this.selectedModels.filter((sm) => sm.id !== m.id);
          this.lastPreset = null;
        } else {
          if (this.selectedModels.length >= RACE_DEFAULTS.maxModels) {
            toast.show(`Maximum ${RACE_DEFAULTS.maxModels} models allowed`, { type: 'warning' });
            return;
          }
          this.selectedModels.push(m);
          this.lastPreset = null;
        }
        this.renderSelectedChips();
        this.renderModelOptions();
        this.updateValidation();
      });

      this.modelOptionsList.appendChild(row);
    });
  }

  private updateValidation(): void {
    const notice = this.element.querySelector('#validation-notice') as HTMLElement;
    const key = this.keyInput.value.trim();
    const modelCount = this.selectedModels.length;
    const isRandom = this.startModeRandom.checked;
    const startVal = isRandom ? this.currentStartPick?.title : this.startCustomInput.value.trim();
    const targetVal = this.targetInput.value.trim();

    const errors: string[] = [];
    if (!key) errors.push('Enter OpenRouter API key');
    if (modelCount < RACE_DEFAULTS.minModels || modelCount > RACE_DEFAULTS.maxModels) {
      errors.push(
        `Select ${RACE_DEFAULTS.minModels} to ${RACE_DEFAULTS.maxModels} models (currently ${modelCount})`,
      );
    }
    if (!startVal) errors.push('Start article required');
    else if (!isRandom && !this.startVerified) errors.push('Verified start article required');
    if (!targetVal || !this.targetVerified) errors.push('Verified target article required');

    if (errors.length > 0) {
      notice.textContent = errors[0]!;
      notice.className = 'footer-notice is-error';
      this.startRaceBtn.disabled = true;
    } else {
      notice.textContent = `Ready: ${modelCount} models racing to "${targetVal}"`;
      notice.className = 'footer-notice is-ready';
      this.startRaceBtn.disabled = false;
    }
  }

  private handleStartRace(): void {
    const key = this.keyInput.value.trim();
    const isRandom = this.startModeRandom.checked;
    const start = isRandom
      ? (this.currentStartPick?.title ?? 'Start')
      : this.startCustomInput.value.trim();
    const target = this.targetInput.value.trim();

    storeApiKey(key, this.rememberKeyCheckbox.checked);

    // HTML min/max don't stop typed values, so every setting is clamped to RACE_LIMITS here.
    const config: Partial<RaceConfig> = {
      maxSteps: clampSetting('maxSteps', parseInt(this.maxStepsInput.value, 10)),
      linkCap: clampSetting('linkCap', parseInt(this.linkCapInput.value, 10)),
      temperature: clampSetting('temperature', parseFloat(this.temperatureInput.value)),
      circlingThreshold: clampSetting(
        'circlingThreshold',
        parseInt(this.circlingThresholdInput.value, 10),
      ),
      maxVisitsPerPage: clampSetting('maxVisitsPerPage', parseInt(this.maxVisitsInput.value, 10)),
      reasoningEffort: this.reasoningEffort(),
      maxOutputTokens: clampSetting('maxOutputTokens', parseInt(this.maxTokensInput.value, 10)),
      stopOnFirstArrival: this.stopOnFirstArrivalInput.checked,
    };

    storeSettings({
      ...config,
      minIntelligence: this.minIntelligence(),
      modelSort: this.modelSort(),
      selectedModelIds: this.selectedModels.map((m) => m.id),
    });

    const entrants: Racer[] = this.selectedModels.map((m, idx) => ({
      id: m.id,
      label: m.name,
      colorIndex: idx,
    }));

    this.callbacks.onStartRace({
      apiKey: key,
      entrants,
      start,
      target,
      config,
    });
  }

  setCanClose(allow: boolean): void {
    this.canClose = allow;
    if (this.closeBtn) {
      this.closeBtn.style.display = allow ? 'inline-flex' : 'none';
    }
  }

  show(): void {
    this.element.style.display = 'flex';
  }

  hide(): void {
    this.element.style.display = 'none';
  }

  destroy(): void {
    this.targetAutocomplete.destroy();
    this.element.remove();
  }
}
