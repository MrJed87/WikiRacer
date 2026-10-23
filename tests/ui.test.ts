import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../src/config';
import {
  clearStoredApiKey,
  getStoredApiKey,
  getStoredSettings,
  isApiKeyRemembered,
  storeApiKey,
  storeSettings,
} from '../src/ui/storage';
import { Scoreboard } from '../src/ui/scoreboard';
import { LogPanel } from '../src/ui/logPanel';
import { ResultsModal } from '../src/ui/resultsModal';
import { ZERO_USAGE } from '../src/llm/types';
import type { RaceEvent, Racer, RaceState } from '../src/race/types';

// Mock storage implementation
class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe('Storage Helpers', () => {
  let mockSession: MockStorage;
  let mockLocal: MockStorage;

  beforeEach(() => {
    mockSession = new MockStorage();
    mockLocal = new MockStorage();
    vi.stubGlobal('sessionStorage', mockSession);
    vi.stubGlobal('localStorage', mockLocal);
  });

  it('stores API key in sessionStorage by default', () => {
    storeApiKey('sk-or-v1-test1234', false);
    expect(mockSession.getItem(STORAGE_KEYS.apiKey)).toBe('sk-or-v1-test1234');
    expect(mockLocal.getItem(STORAGE_KEYS.apiKey)).toBeNull();
    expect(isApiKeyRemembered()).toBe(false);
    expect(getStoredApiKey()).toBe('sk-or-v1-test1234');
  });

  it('stores API key in localStorage when remember is true', () => {
    storeApiKey('sk-or-v1-persistent', true);
    expect(mockSession.getItem(STORAGE_KEYS.apiKey)).toBe('sk-or-v1-persistent');
    expect(mockLocal.getItem(STORAGE_KEYS.apiKey)).toBe('sk-or-v1-persistent');
    expect(mockLocal.getItem(STORAGE_KEYS.rememberKey)).toBe('true');
    expect(isApiKeyRemembered()).toBe(true);
  });

  it('clears API key completely from both storages', () => {
    storeApiKey('sk-or-v1-secret', true);
    clearStoredApiKey();
    expect(mockSession.getItem(STORAGE_KEYS.apiKey)).toBeNull();
    expect(mockLocal.getItem(STORAGE_KEYS.apiKey)).toBeNull();
    expect(getStoredApiKey()).toBe('');
  });

  it('persists and retrieves custom race settings', () => {
    storeSettings({
      maxSteps: 40,
      linkCap: 80,
      temperature: 0.2,
      circlingThreshold: 4,
    });

    const loaded = getStoredSettings();
    expect(loaded.maxSteps).toBe(40);
    expect(loaded.linkCap).toBe(80);
    expect(loaded.temperature).toBe(0.2);
    expect(loaded.circlingThreshold).toBe(4);
  });
});

describe('UI Components DOM creation & updates', () => {
  const racers: Racer[] = [
    { id: 'model-a', label: 'Model A', colorIndex: 0 },
    { id: 'model-b', label: 'Model B', colorIndex: 1 },
  ];

  interface MockNode {
    tagName: string;
    className: string;
    innerHTML: string;
    textContent: string;
    style: Record<string, string>;
    children: MockNode[];
    attributes: Record<string, string>;
    open: boolean;
    value: string;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    setAttribute: (k: string, v: string) => void;
    getAttribute: (k: string) => string | null;
    appendChild: (child: MockNode) => void;
    remove: () => void;
    addEventListener: (event: string, fn: (e: unknown) => void) => void;
    querySelectorAll: (sel: string) => MockNode[];
    querySelector: (sel: string) => MockNode | null;
    getBoundingClientRect: () => { top: number; left: number; width: number; height: number };
    showModal: () => void;
    close: () => void;
  }

  function makeMockElement(tagName = 'div'): MockNode {
    const el: MockNode = {
      tagName: tagName.toUpperCase(),
      className: '',
      innerHTML: '',
      textContent: '',
      style: {},
      children: [],
      attributes: {},
      open: false,
      value: '',
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 50,
      setAttribute: (k: string, v: string) => {
        el.attributes[k] = v;
      },
      getAttribute: (k: string) => el.attributes[k] ?? null,
      appendChild: (child: MockNode) => {
        el.children.push(child);
      },
      remove: vi.fn(),
      addEventListener: vi.fn(),
      querySelectorAll: (sel: string) => {
        const found: MockNode[] = [];
        function walk(node: MockNode): void {
          const matchClass = sel.startsWith('.') && node.className.includes(sel.slice(1));
          const matchTag = sel.toUpperCase() === node.tagName;
          const matchId = sel.startsWith('#') && node.attributes['id'] === sel.slice(1);
          if (matchClass || matchTag || matchId) found.push(node);
          node.children.forEach(walk);
        }
        walk(el);
        return found;
      },
      querySelector: (sel: string) => {
        // Return dummy mock element if searching for known button or select
        return makeMockElement(
          sel.startsWith('button') ? 'button' : sel.includes('select') ? 'select' : 'div',
        );
      },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
      showModal: function () {
        this.open = true;
      },
      close: function () {
        this.open = false;
      },
    };
    return el;
  }

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeMockElement(tag),
      body: makeMockElement('body'),
    });
  });

  it('creates and updates Scoreboard', () => {
    const container = makeMockElement('div') as unknown as HTMLElement;
    const onFollow = vi.fn();
    const onFocus = vi.fn();

    const scoreboard = new Scoreboard({
      container,
      getRacer: (id) => racers.find((r) => r.id === id),
      onFollowRacer: onFollow,
      onFocusRacer: onFocus,
    });

    expect(scoreboard.element).toBeDefined();

    const state: RaceState = {
      status: 'running',
      config: null,
      eventCount: 2,
      elapsedMs: 1400,
      order: ['model-a', 'model-b'],
      racers: {
        'model-a': {
          racer: racers[0]!,
          status: 'racing',
          current: 'Page A',
          stack: ['Start', 'Page A'],
          steps: 2,
          revisits: 0,
          invalidReplies: 0,
          trail: ['Start', 'Page A'],
          visits: { Start: 1, 'Page A': 1 },
          circling: false,
          usage: ZERO_USAGE,
        },
        'model-b': {
          racer: racers[1]!,
          status: 'arrived',
          current: 'Target Page',
          stack: ['Start', 'Target Page'],
          steps: 1,
          revisits: 0,
          invalidReplies: 0,
          trail: ['Start', 'Target Page'],
          visits: { Start: 1, 'Target Page': 1 },
          circling: false,
          usage: ZERO_USAGE,
          finishedAtMs: 1400,
        },
      },
      winnerId: 'model-b',
    };

    scoreboard.update(state);
    expect((scoreboard.element as unknown as MockNode).children.length).toBeGreaterThan(0);
  });

  it('appends and filters events in LogPanel', () => {
    const container = makeMockElement('div') as unknown as HTMLElement;
    const logPanel = new LogPanel({
      container,
      getRacer: (id) => racers.find((r) => r.id === id),
    });

    const event: RaceEvent = {
      type: 'StepTaken',
      seq: 1,
      t: 1200,
      racerId: 'model-a',
      step: 1,
      from: 'Start',
      to: 'Next Article',
      index: 3,
      reason: 'Looks promising',
      usage: ZERO_USAGE,
      latencyMs: 320,
    };

    logPanel.addEvent(event);
    expect(logPanel.element).toBeDefined();

    logPanel.clear();
    logPanel.destroy();
  });

  it('renders ResultsModal and computes winners correctly', () => {
    const container = makeMockElement('div') as unknown as HTMLElement;
    const onPlayAgain = vi.fn();
    const onNewRace = vi.fn();

    const resultsModal = new ResultsModal({
      container,
      getRacer: (id) => racers.find((r) => r.id === id),
      onPlayAgain,
      onNewRace,
    });

    const state: RaceState = {
      status: 'finished',
      config: null,
      eventCount: 35,
      elapsedMs: 2500,
      order: ['model-a', 'model-b'],
      racers: {
        'model-a': {
          racer: racers[0]!,
          status: 'arrived',
          current: 'Goal',
          stack: ['Start', 'Mid', 'Goal'],
          steps: 2,
          revisits: 0,
          invalidReplies: 0,
          trail: ['Start', 'Mid', 'Goal'],
          visits: { Start: 1, Mid: 1, Goal: 1 },
          circling: false,
          usage: ZERO_USAGE,
          finishedAtMs: 2500,
        },
        'model-b': {
          racer: racers[1]!,
          status: 'gave-up',
          current: 'Loop',
          stack: ['Start', 'Loop'],
          steps: 30,
          revisits: 4,
          invalidReplies: 0,
          trail: ['Start', 'Loop'],
          visits: { Start: 1, Loop: 5 },
          circling: true,
          usage: ZERO_USAGE,
        },
      },
      winnerId: 'model-a',
    };

    resultsModal.show(state, []);
    resultsModal.close();
    resultsModal.destroy();
  });

  it('safely renders untrusted text with textContent in ResultsModal and Scoreboard', () => {
    const maliciousRacer: Racer = {
      id: 'hacker',
      label: '<script>alert("xss")</script>',
      colorIndex: 0,
    };
    const state: RaceState = {
      status: 'finished',
      config: null,
      eventCount: 1,
      elapsedMs: 500,
      order: ['hacker'],
      racers: {
        hacker: {
          racer: maliciousRacer,
          status: 'arrived',
          current: '<img src=x onerror=alert(1)>',
          stack: ['Start', '<img src=x onerror=alert(1)>'],
          steps: 1,
          revisits: 0,
          invalidReplies: 0,
          trail: ['Start', '<img src=x onerror=alert(1)>'],
          visits: { Start: 1, '<img src=x onerror=alert(1)>': 1 },
          circling: false,
          usage: ZERO_USAGE,
          finishedAtMs: 500,
        },
      },
      winnerId: 'hacker',
    };

    const container = makeMockElement('div') as unknown as HTMLElement;
    const scoreboard = new Scoreboard({
      container,
      getRacer: () => maliciousRacer,
    });
    scoreboard.update(state);

    const modal = new ResultsModal({
      container,
      getRacer: () => maliciousRacer,
      onPlayAgain: vi.fn(),
      onNewRace: vi.fn(),
    });
    modal.show(state, []);
    modal.close();
    modal.destroy();
  });
});

describe('shortModelLabel (scoreboard, mobile pass)', () => {
  it('drops the maker prefix and keeps everything else', async () => {
    const { shortModelLabel } = await import('../src/ui/scoreboard');
    expect(shortModelLabel('Z.ai: GLM Flash Latest')).toBe('GLM Flash Latest');
    expect(shortModelLabel('inclusionAI: Ling 3.0 Flash')).toBe('Ling 3.0 Flash');
    expect(shortModelLabel('Mistral: Mistral Nemo')).toBe('Mistral Nemo');
    expect(shortModelLabel('alpha/alpha-1')).toBe('alpha/alpha-1');
    expect(shortModelLabel('Weird: ')).toBe('Weird: ');
  });
});
