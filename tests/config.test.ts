import { describe, expect, it } from 'vitest';
import { RACE_DEFAULTS } from '../src/config';

describe('config', () => {
  it('has a sane racer range', () => {
    expect(RACE_DEFAULTS.minModels).toBeLessThan(RACE_DEFAULTS.maxModels);
  });
});
