import { describe, expect, it } from 'vitest';
import { EXAMPLE_REPLAYS, loadExampleReplay } from '../src/examples';
import { ReplayController } from '../src/race/replay';

describe('bundled example replays', () => {
  it('lists five examples with unique ids', () => {
    expect(EXAMPLE_REPLAYS).toHaveLength(5);
    expect(new Set(EXAMPLE_REPLAYS.map((e) => e.id)).size).toBe(5);
  });

  it.each(EXAMPLE_REPLAYS.map((e) => [e.id, e] as const))(
    '%s loads and replays to the end',
    async (id, example) => {
      const data = await loadExampleReplay(id);

      expect(data.events[0]?.type).toBe('RaceStarted');
      expect(data.events.at(-1)?.type).toBe('RaceEnded');
      expect(data.racers.length).toBeGreaterThanOrEqual(2);
      // The picker title names the start and target the recording was made with.
      expect(example.title).toContain(data.config.target);

      const controller = new ReplayController(data);
      controller.seek(data.events.length);
      let finalState: unknown;
      controller.subscribe(({ state }) => {
        finalState = state;
      });
      expect(finalState).toBeDefined();
      controller.destroy();
    },
  );

  it('rejects an unknown id', async () => {
    await expect(loadExampleReplay('nope')).rejects.toThrow(/Unknown example replay/);
  });
});
