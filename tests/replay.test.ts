import { describe, expect, it } from 'vitest';
import { ReplayController, validateReplayData, type ReplayData } from '../src/race/replay';
import { ZERO_USAGE } from '../src/llm/types';
import type { RaceConfig, RaceEvent, Racer } from '../src/race/types';

describe('Replay Controller', () => {
  const config: RaceConfig = {
    start: 'Start Page',
    target: 'Target Page',
    targetSummary: 'Summary of target',
    maxSteps: 20,
    linkCap: 50,
    temperature: 0.2,
    circlingThreshold: 3,
    budgetUsd: 0.5,
    budgetTokens: 100000,
    stepDelayMs: 0,
    stopOnFirstArrival: false,
    promptVersion: 1,
  };

  const racers: Racer[] = [
    { id: 'm1', label: 'Model One', colorIndex: 0 },
    { id: 'm2', label: 'Model Two', colorIndex: 1 },
  ];

  const events: RaceEvent[] = [
    {
      type: 'RaceStarted',
      seq: 0,
      t: 0,
      config,
      racers,
      startedAtEpochMs: 1700000000000,
    },
    {
      type: 'StepTaken',
      seq: 1,
      t: 500,
      racerId: 'm1',
      step: 1,
      from: 'Start Page',
      to: 'Intermediate Page',
      index: 2,
      reason: 'Closest topic',
      usage: ZERO_USAGE,
      latencyMs: 300,
    },
    {
      type: 'StepTaken',
      seq: 2,
      t: 1100,
      racerId: 'm1',
      step: 2,
      from: 'Intermediate Page',
      to: 'Target Page',
      index: 5,
      reason: 'Direct link',
      usage: ZERO_USAGE,
      latencyMs: 320,
    },
    {
      type: 'Arrived',
      seq: 3,
      t: 1200,
      racerId: 'm1',
      steps: 2,
      title: 'Target Page',
    },
    {
      type: 'RaceEnded',
      seq: 4,
      t: 1300,
      reason: 'all-done',
    },
  ];

  const replayData: ReplayData = {
    app: 'Wikipedia Graph Race',
    version: 1,
    config,
    racers,
    events,
  };

  it('validates replay file structure', () => {
    expect(() => validateReplayData(replayData)).not.toThrow();
    expect(() => validateReplayData(null)).toThrow();
    expect(() => validateReplayData({})).toThrow();
    expect(() => validateReplayData({ events: [] })).toThrow();
  });

  it('precomputes and seeks snapshots accurately', () => {
    const controller = new ReplayController(replayData);
    expect(controller.totalEvents).toBe(5);

    let lastIndex = -1;
    let lastEventType = '';
    let arrivedStatus = '';

    controller.subscribe(({ index, event, state }) => {
      lastIndex = index;
      lastEventType = event ? event.type : '';
      arrivedStatus = state.racers['m1']?.status ?? '';
    });

    // Initial state: index 0
    expect(lastIndex).toBe(0);
    expect(lastEventType).toBe('');

    // Seek to step 2 (after 1st StepTaken)
    controller.seek(2);
    expect(lastIndex).toBe(2);
    expect(lastEventType).toBe('StepTaken');
    expect(arrivedStatus).toBe('racing');

    // Seek to step 4 (after Arrived)
    controller.seek(4);
    expect(lastIndex).toBe(4);
    expect(lastEventType).toBe('Arrived');
    expect(arrivedStatus).toBe('arrived');

    // Seek to start (index 0)
    controller.seek(0);
    expect(lastIndex).toBe(0);
    expect(arrivedStatus).toBe('');
  });

  it('steps forward and backward', () => {
    const controller = new ReplayController(replayData);

    controller.stepForward();
    expect(controller.index).toBe(1);

    controller.stepForward();
    expect(controller.index).toBe(2);

    controller.stepBackward();
    expect(controller.index).toBe(1);

    controller.stepBackward();
    expect(controller.index).toBe(0);

    // Cannot step back past 0
    controller.stepBackward();
    expect(controller.index).toBe(0);
  });

  it('adjusts playback speed and delay', () => {
    const controller = new ReplayController(replayData);
    controller.setDelayMs(100);
    expect(controller.delayMs).toBe(100);

    // Clamps within [50, 2000]
    controller.setDelayMs(10);
    expect(controller.delayMs).toBe(50);
    controller.setDelayMs(5000);
    expect(controller.delayMs).toBe(2000);
  });
});
