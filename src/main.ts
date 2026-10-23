/**
 * Wikipedia Graph Race - Application Orchestrator & Entry Point
 *
 * Coordinates SetupPanel, Live HUD, Controls, ReplayBar, Sidebar (Scoreboard & LogPanel),
 * GraphRenderer Canvas 2D simulation, and ResultsModal.
 */
import './styles.css';
import { APP_NAME, RACE_DEFAULTS, clampNodeScale } from './config';
import { createDemoWiki, DEMO_START, DEMO_TARGET } from './mock/demoWorld';
import { MockProvider } from './mock/mockProvider';
import {
  flaky,
  looperDecider,
  shortestPathDecider,
  wandererDecider,
  seededRandom,
} from './mock/behaviours';
import { WikipediaClient } from './wiki/client';
import { OpenRouterClient } from './llm/openrouter';
import { RaceManager, type Entrant } from './race/raceManager';
import { buildRaceConfig } from './race/setup';
import { createGraph, applyEvent, describeGraph, type GraphModel } from './graph/graphModel';
import { GraphSimulation } from './graph/simulation';
import { GraphRenderer } from './graph/renderer';
import { ReplayController, type ReplayData } from './race/replay';
import { SetupPanel, type SetupRaceParams } from './ui/setupPanel';
import { Scoreboard } from './ui/scoreboard';
import { LogPanel } from './ui/logPanel';
import { Controls } from './ui/controls';
import { ReplayBar } from './ui/replayBar';
import { ResultsModal } from './ui/resultsModal';
import { toast } from './ui/toasts';
import {
  getCostHistory,
  getNodeScale,
  getThumbnailsEnabled,
  storeCostHistory,
  storeNodeScale,
  storeThumbnailsEnabled,
} from './ui/storage';
import { mergeCostHistory } from './race/costHistory';
import { ThumbnailLoader } from './ui/thumbnails';
import type { RaceConfig, RaceEvent, Racer, RaceState } from './race/types';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app container');

// Inject core layout structure
root.innerHTML = `
  <div id="graph-container" class="graph-container"></div>
  <div id="a11y-graph-summary" class="sr-only" role="region" aria-live="polite" aria-label="Graph description"></div>

  <header class="hud-header">
    <div class="hud-title-card">
      <h1 id="hud-title">⚡ ${APP_NAME} <span class="mode-badge" id="hud-mode-badge">(Demo)</span></h1>
      <div class="hud-route">
        <span>From</span>
        <span class="start-tag" id="hud-start">—</span>
        <span>➔</span>
        <span class="target-tag" id="hud-target">—</span>
      </div>
      <div class="hud-meta-row">
        <span class="status-pill status-neutral" id="hud-status">READY</span>
        <span class="hud-timer" id="hud-timer">00:00</span>
      </div>
    </div>

    <div id="controls-slot"></div>
  </header>

  <aside class="hud-sidebar" id="hud-sidebar">
    <div class="sidebar-tabs">
      <button type="button" class="tab-btn is-active" id="tab-btn-scoreboard">Scoreboard</button>
      <button type="button" class="tab-btn" id="tab-btn-log">Event Log</button>
    </div>
    <div class="sidebar-content" id="sidebar-content">
      <div id="scoreboard-pane"></div>
      <div id="log-pane" class="log-pane is-hidden"></div>
    </div>
  </aside>

  <div id="tooltip" class="graph-tooltip">
    <div class="tooltip-title" id="tooltip-title"></div>
    <div class="tooltip-details" id="tooltip-details"></div>
  </div>
`;

// Element references
const controlsSlot = document.getElementById('controls-slot') as HTMLElement;
const scoreboardPane = document.getElementById('scoreboard-pane') as HTMLElement;
const logPane = document.getElementById('log-pane') as HTMLElement;
const graphContainer = document.getElementById('graph-container') as HTMLElement;
const a11ySummary = document.getElementById('a11y-graph-summary') as HTMLElement;
const tooltipEl = document.getElementById('tooltip') as HTMLElement;
const tooltipTitle = document.getElementById('tooltip-title') as HTMLElement;
const tooltipDetails = document.getElementById('tooltip-details') as HTMLElement;
const hudStart = document.getElementById('hud-start') as HTMLElement;
const hudTarget = document.getElementById('hud-target') as HTMLElement;
const hudStatus = document.getElementById('hud-status') as HTMLElement;
const hudTimer = document.getElementById('hud-timer') as HTMLElement;
const hudModeBadge = document.getElementById('hud-mode-badge') as HTMLElement;

// Sidebar tabs switching
const tabBtnScoreboard = document.getElementById('tab-btn-scoreboard') as HTMLButtonElement;
const tabBtnLog = document.getElementById('tab-btn-log') as HTMLButtonElement;

tabBtnScoreboard.addEventListener('click', () => {
  tabBtnScoreboard.classList.add('is-active');
  tabBtnLog.classList.remove('is-active');
  scoreboardPane.style.display = 'block';
  logPane.style.display = 'none';
});

tabBtnLog.addEventListener('click', () => {
  tabBtnLog.classList.add('is-active');
  tabBtnScoreboard.classList.remove('is-active');
  logPane.style.display = 'flex';
  scoreboardPane.style.display = 'none';
});

// Graph Simulation & Canvas 2D Renderer
const sim = new GraphSimulation();
const racersMap = new Map<string, Racer>();

const renderer = new GraphRenderer({
  container: graphContainer,
  simulation: sim,
  getRacer: (id) => racersMap.get(id),
  isReplayActive: () => activeReplayController !== null,
  onHover: (node, screenPos) => {
    if (!node || !screenPos) {
      tooltipEl.style.display = 'none';
      return;
    }
    tooltipTitle.textContent = node.id;
    const visits = Object.entries(node.visits)
      .map(([id, n]) => `${racersMap.get(id)?.label ?? id}: ${n}`)
      .join(', ');
    tooltipDetails.textContent = visits ? `Visits: ${visits}` : 'Not yet visited';
    tooltipEl.style.left = `${screenPos.x}px`;
    tooltipEl.style.top = `${screenPos.y}px`;
    tooltipEl.style.display = 'block';
  },
});

// Scoreboard & LogPanel
const scoreboard = new Scoreboard({
  container: scoreboardPane,
  getRacer: (id) => racersMap.get(id),
  onFollowRacer: (id) => {
    renderer.setFollowRacer(id);
  },
  onFocusRacer: (id) => {
    renderer.setFocusedRacer(id);
  },
});

const logPanel = new LogPanel({
  container: logPane,
  getRacer: (id) => racersMap.get(id),
});

// Controls & Replay State
let currentConfig: RaceConfig | null = null;
let currentManager: RaceManager | null = null;
let graphModel: GraphModel = createGraph();
let lastRaceType: 'demo' | 'live' = 'demo';
/** The last finished race, so its finish screen (and export) can be reopened. */
let lastResults: { state: RaceState; events: readonly RaceEvent[] } | null = null;
let lastRaceParams: SetupRaceParams | null = null;
let activeReplayBar: ReplayBar | null = null;
let activeReplayController: ReplayController | null = null;

// Article thumbnails: their own client and cache, but the same app-wide Wikipedia queue as the
// race (one request at a time). Shared by live races and replays. Skipped for the offline demo.
const thumbnailWiki = new WikipediaClient();
let thumbnailsOn = getThumbnailsEnabled();
renderer.setThumbnailsEnabled(thumbnailsOn);
const thumbnails = new ThumbnailLoader({
  source: thumbnailWiki,
  apply: (title, url) => renderer.setNodeImage(title, url),
});
let thumbnailsAllowed = false;

function requestThumbnails(graph: GraphModel): void {
  if (thumbnailsOn && thumbnailsAllowed) thumbnails.request(graph.nodes.keys());
}

// Node size: one remembered value shared by the live controls bar and the replay bar.
let nodeScale = getNodeScale();
renderer.setNodeScale(nodeScale);

function applyNodeScale(scale: number): void {
  nodeScale = clampNodeScale(scale);
  storeNodeScale(nodeScale);
  renderer.setNodeScale(nodeScale);
  controls.setNodeScale(nodeScale);
  activeReplayBar?.setNodeScale(nodeScale);
}

const controls = new Controls({
  container: controlsSlot,
  nodeScale,
  onNodeScaleChange: applyNodeScale,
  onShowResults: () => {
    if (lastResults) resultsModal.show(lastResults.state, lastResults.events);
  },
  thumbnailsEnabled: thumbnailsOn,
  onThumbnailsToggle: (enabled) => {
    thumbnailsOn = enabled;
    storeThumbnailsEnabled(enabled);
    renderer.setThumbnailsEnabled(enabled);
    requestThumbnails(graphModel);
  },
  onFitView: () => {
    renderer.fitView();
  },
  onNewRace: () => {
    if (currentManager) {
      currentManager.pause();
    }
    setupPanel.setCanClose(true);
    setupPanel.show();
  },
  onSpeedChange: (delayMs) => {
    if (currentConfig) {
      currentConfig.stepDelayMs = delayMs;
    }
  },
});

const resultsModal = new ResultsModal({
  container: document.body,
  getRacer: (id) => racersMap.get(id),
  onPlayAgain: () => {
    if (lastRaceType === 'demo') {
      void launchDemoRace();
    } else if (lastRaceParams) {
      void launchLiveRace(lastRaceParams);
    }
  },
  onNewRace: () => {
    setupPanel.setCanClose(true);
    setupPanel.show();
  },
});

// Setup Panel
const setupPanel = new SetupPanel(document.body, {
  onStartRace: (params) => {
    void launchLiveRace(params);
  },
  onLaunchDemo: () => {
    void launchDemoRace();
  },
  onLoadReplay: (replayData) => {
    launchReplay(replayData);
  },
});

// Timer Management
let timerInterval: number | null = null;
let raceStartTime = 0;
let accumulatedElapsed = 0;
let isPaused = false;

function startTimer(): void {
  stopTimer();
  raceStartTime = Date.now();
  accumulatedElapsed = 0;
  isPaused = false;
  timerInterval = window.setInterval(updateTimerDisplay, 250);
  updateTimerDisplay();
}

function pauseTimer(): void {
  if (isPaused) return;
  accumulatedElapsed += Date.now() - raceStartTime;
  isPaused = true;
  updateTimerDisplay();
}

function resumeTimer(): void {
  if (!isPaused) return;
  raceStartTime = Date.now();
  isPaused = false;
}

function stopTimer(): void {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay(): void {
  const currentElapsed = isPaused
    ? accumulatedElapsed
    : accumulatedElapsed + (Date.now() - raceStartTime);
  const totalSeconds = Math.max(0, Math.floor(currentElapsed / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  hudTimer.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateHudStatus(status: RaceState['status']): void {
  hudStatus.textContent = status.toUpperCase();
  if (status === 'running') {
    hudStatus.className = 'status-pill status-success';
  } else if (status === 'paused') {
    hudStatus.className = 'status-pill status-neutral';
  } else if (status === 'finished' || status === 'stopped') {
    hudStatus.className = 'status-pill status-neutral';
  }
}

function bindManagerEvents(manager: RaceManager): void {
  manager.store.subscribe((event: RaceEvent, state: RaceState) => {
    applyEvent(graphModel, event);
    renderer.setModel(graphModel);
    requestThumbnails(graphModel);
    scoreboard.update(state);
    logPanel.addEvent(event);
    controls.updateState(state);
    updateHudStatus(state.status);

    a11ySummary.textContent = describeGraph(graphModel, (id) => racersMap.get(id)?.label ?? id);

    if (event.type === 'RaceStarted') {
      setTimeout(() => renderer.fitView(120), 100);
    } else if (event.type === 'RacePaused') {
      pauseTimer();
    } else if (event.type === 'RaceResumed') {
      resumeTimer();
    } else if (event.type === 'Arrived') {
      const racer = racersMap.get(event.racerId);
      toast.show(
        `🏆 ${racer?.label ?? event.racerId} reached the target in ${event.steps} clicks!`,
        { type: 'success' },
      );
    } else if (event.type === 'Circling') {
      const racer = racersMap.get(event.racerId);
      toast.show(
        `⚠️ ${racer?.label ?? event.racerId} is circling "${event.title}" (${event.visits} visits)`,
        { type: 'warning' },
      );
    } else if (event.type === 'AgentFailed') {
      const racer = racersMap.get(event.racerId);
      toast.show(`❌ ${racer?.label ?? event.racerId} failed: ${event.message}`, { type: 'error' });
    } else if (event.type === 'RaceEnded') {
      stopTimer();
      lastResults = { state, events: manager.store.events };
      controls.setResultsAvailable(true);
      // Learn real per-click costs from live races (the demo's mock models cost nothing).
      if (lastRaceType === 'live') {
        storeCostHistory(mergeCostHistory(getCostHistory(), manager.store.events));
        setupPanel.refreshCostHistory();
      }
      setTimeout(() => {
        resultsModal.show(state, manager.store.events);
      }, 700);
    }
  });

  scoreboard.update(manager.store.state);
  updateHudStatus(manager.store.state.status);
}

function cleanupActiveReplay(): void {
  if (activeReplayBar) {
    activeReplayBar.destroy();
    activeReplayBar = null;
  }
  if (activeReplayController) {
    activeReplayController.destroy();
    activeReplayController = null;
  }
  controls.element.style.display = 'flex';
}

async function launchDemoRace(): Promise<void> {
  lastRaceType = 'demo';
  thumbnailsAllowed = false;
  setupPanel.hide();
  resultsModal.close();
  cleanupActiveReplay();

  if (currentManager) {
    currentManager.stop();
  }

  hudModeBadge.textContent = '(Demo)';
  hudStart.textContent = DEMO_START;
  hudTarget.textContent = DEMO_TARGET;

  graphModel = createGraph();
  renderer.setModel(graphModel);
  lastResults = null;
  controls.setResultsAvailable(false);
  renderer.setFollowRacer(null);
  renderer.setFocusedRacer(null);
  logPanel.clear();

  const wiki = createDemoWiki(70);
  const distances = wiki.distancesTo(DEMO_TARGET);

  const entrants: Entrant[] = [
    {
      racer: { id: 'deepseek-r1', label: 'DeepSeek R1', colorIndex: 0 },
      provider: new MockProvider(shortestPathDecider(distances), { latencyMs: 380 }),
    },
    {
      racer: { id: 'claude-3-5', label: 'Claude 3.5 Sonnet', colorIndex: 1 },
      provider: new MockProvider(wandererDecider(seededRandom(7)), { latencyMs: 420 }),
    },
    {
      racer: { id: 'gpt-4o', label: 'GPT-4o (Circling)', colorIndex: 2 },
      provider: new MockProvider(looperDecider(), { latencyMs: 350 }),
    },
    {
      racer: { id: 'llama-3-3', label: 'Llama 3.3 (Flaky)', colorIndex: 3 },
      provider: new MockProvider(flaky(shortestPathDecider(distances, 0.2), 3), { latencyMs: 450 }),
    },
  ];

  racersMap.clear();
  entrants.forEach((e) => racersMap.set(e.racer.id, e.racer));
  logPanel.setRacers(entrants.map((e) => e.racer));

  const config = await buildRaceConfig(wiki, {
    start: DEMO_START,
    target: DEMO_TARGET,
    overrides: {
      maxSteps: 25,
      stepDelayMs: 250,
      circlingThreshold: 3,
    },
  });
  currentConfig = config;

  const manager = new RaceManager({ entrants, wiki, config });
  currentManager = manager;
  controls.setManager(manager);

  bindManagerEvents(manager);
  startTimer();

  manager.start().catch((err: unknown) => {
    console.error('Demo race error:', err);
    toast.show(`Demo race error: ${err instanceof Error ? err.message : String(err)}`, {
      type: 'error',
    });
  });
}

async function launchLiveRace(params: SetupRaceParams): Promise<void> {
  lastRaceType = 'live';
  thumbnailsAllowed = true;
  lastRaceParams = params;
  setupPanel.hide();
  resultsModal.close();
  cleanupActiveReplay();

  if (currentManager) {
    currentManager.stop();
  }

  hudModeBadge.textContent = '(Live)';
  hudStart.textContent = params.start;
  hudTarget.textContent = params.target;

  graphModel = createGraph();
  renderer.setModel(graphModel);
  lastResults = null;
  controls.setResultsAvailable(false);
  renderer.setFollowRacer(null);
  renderer.setFocusedRacer(null);
  logPanel.clear();

  // The client applies the link cap during extraction, so it must be built with the race's cap.
  const wiki = new WikipediaClient({ linkCap: params.config.linkCap ?? RACE_DEFAULTS.linkCap });
  const provider = new OpenRouterClient({
    apiKey: params.apiKey,
    referer: window.location.origin,
  });

  const entrants: Entrant[] = params.entrants.map((r) => ({
    racer: r,
    provider,
  }));

  racersMap.clear();
  entrants.forEach((e) => racersMap.set(e.racer.id, e.racer));
  logPanel.setRacers(entrants.map((e) => e.racer));

  let config: RaceConfig;
  try {
    toast.show('Preparing Wikipedia pages and rules...', { type: 'info', durationMs: 2000 });
    config = await buildRaceConfig(wiki, {
      start: params.start,
      target: params.target,
      overrides: params.config,
    });
  } catch (err) {
    toast.show(`Failed to prepare race: ${err instanceof Error ? err.message : String(err)}`, {
      type: 'error',
    });
    setupPanel.show();
    return;
  }

  currentConfig = config;
  const manager = new RaceManager({ entrants, wiki, config });
  currentManager = manager;
  controls.setManager(manager);

  bindManagerEvents(manager);
  startTimer();

  manager.start().catch((err: unknown) => {
    console.error('Live race error:', err);
    toast.show(`Race error: ${err instanceof Error ? err.message : String(err)}`, {
      type: 'error',
    });
  });
}

function launchReplay(data: ReplayData): void {
  setupPanel.hide();
  resultsModal.close();

  if (currentManager) {
    currentManager.stop();
    currentManager = null;
  }
  cleanupActiveReplay();

  controls.element.style.display = 'none';
  hudModeBadge.textContent = '(Replay)';
  // Replays of real races get pictures too (the toggle is in the live controls bar).
  thumbnailsAllowed = true;
  hudStart.textContent = data.config.start;
  hudTarget.textContent = data.config.target;
  hudStatus.textContent = 'REPLAY';
  hudStatus.className = 'status-pill status-neutral';
  stopTimer();

  racersMap.clear();
  data.racers.forEach((r) => racersMap.set(r.id, r));
  logPanel.setRacers(data.racers);
  logPanel.clear();

  const controller = new ReplayController(data);
  activeReplayController = controller;

  const bar = new ReplayBar({
    container: controlsSlot,
    controller,
    nodeScale,
    onNodeScaleChange: applyNodeScale,
    onExit: () => {
      cleanupActiveReplay();
      setupPanel.setCanClose(true);
      setupPanel.show();
    },
  });
  activeReplayBar = bar;

  controller.subscribe(({ index, graph, state, event }) => {
    renderer.setModel(graph);
    graphModel = graph;
    requestThumbnails(graph);
    scoreboard.update(state);
    a11ySummary.textContent = describeGraph(graph, (id) => racersMap.get(id)?.label ?? id);

    logPanel.clear();
    for (let i = 0; i < index; i++) {
      const ev = data.events[i];
      if (ev) logPanel.addEvent(ev);
    }

    if (event) {
      const mins = Math.floor(event.t / 60000);
      const secs = Math.floor((event.t % 60000) / 1000);
      hudTimer.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
  });

  setTimeout(() => renderer.fitView(120), 100);
  controller.play();
}

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  const activeEl = document.activeElement;
  if (
    activeEl &&
    (activeEl.tagName === 'INPUT' ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.tagName === 'SELECT')
  ) {
    return;
  }

  if (activeReplayController) {
    if (e.code === 'Space') {
      e.preventDefault();
      activeReplayController.toggle();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      activeReplayController.pause();
      activeReplayController.stepBackward();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      activeReplayController.pause();
      activeReplayController.stepForward();
    } else if (e.key === 'f' || e.key === 'F') {
      renderer.fitView();
    }
    return;
  }

  if (e.code === 'Space') {
    e.preventDefault();
    if (!currentManager) return;
    if (currentManager.store.state.status === 'paused') {
      currentManager.resume();
    } else if (currentManager.store.state.status === 'running') {
      currentManager.pause();
    }
  } else if (e.key === 'f' || e.key === 'F') {
    renderer.fitView();
  }
});
