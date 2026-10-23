import type { ChooseLinkRequest } from '../../src/llm/types';

export const baseRequest = (over: Partial<ChooseLinkRequest> = {}): ChooseLinkRequest => ({
  model: 'acme/model-a',
  target: 'Philosophy',
  targetSummary: 'Philosophy is the study of general questions.',
  current: {
    title: 'Obscure Bridge',
    summary: 'A bridge.',
    links: ['Bridge', 'River'],
    totalLinks: 2,
    truncated: false,
  },
  path: ['Obscure Bridge'],
  step: 1,
  maxSteps: 30,
  canGoBack: false,
  temperature: 0.2,
  ...over,
});
