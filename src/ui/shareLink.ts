/**
 * Shareable Race Configuration Link Helpers.
 *
 * Encodes race setup (models, start, target, fairness settings) into the URL hash.
 *
 * Security rule: never log, persist (beyond opt-in storage), URL-encode or export the API key.
 * Share links must strictly exclude the key.
 */
import { clampSetting } from '../config';
import { REASONING_EFFORTS, type ReasoningEffort } from '../llm/types';

export interface ShareableConfig {
  start: string;
  target: string;
  models: string[];
  maxSteps?: number;
  linkCap?: number;
  temperature?: number;
  circlingThreshold?: number;
  maxVisitsPerPage?: number;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  stopOnFirstArrival?: boolean;
}

export function encodeShareConfig(cfg: ShareableConfig): string {
  const params = new URLSearchParams();

  if (cfg.start.trim()) params.set('start', cfg.start.trim());
  if (cfg.target.trim()) params.set('target', cfg.target.trim());
  if (cfg.models.length > 0) params.set('models', cfg.models.join(','));

  if (typeof cfg.maxSteps === 'number' && Number.isFinite(cfg.maxSteps)) {
    params.set('maxSteps', String(cfg.maxSteps));
  }
  if (typeof cfg.linkCap === 'number' && Number.isFinite(cfg.linkCap)) {
    params.set('linkCap', String(cfg.linkCap));
  }
  if (typeof cfg.temperature === 'number' && Number.isFinite(cfg.temperature)) {
    params.set('temp', String(cfg.temperature));
  }
  if (typeof cfg.circlingThreshold === 'number' && Number.isFinite(cfg.circlingThreshold)) {
    params.set('circling', String(cfg.circlingThreshold));
  }
  if (typeof cfg.maxVisitsPerPage === 'number' && Number.isFinite(cfg.maxVisitsPerPage)) {
    params.set('maxVisits', String(cfg.maxVisitsPerPage));
  }
  if (cfg.reasoningEffort) params.set('effort', cfg.reasoningEffort);
  if (typeof cfg.maxOutputTokens === 'number' && Number.isFinite(cfg.maxOutputTokens)) {
    params.set('maxTokens', String(cfg.maxOutputTokens));
  }
  if (cfg.stopOnFirstArrival) {
    params.set('stopFirst', '1');
  }

  const qs = params.toString();
  return qs ? `#${qs}` : '';
}

/** Untrusted input: numeric settings are clamped to RACE_LIMITS so a link can't set extreme values. */
export function decodeShareConfig(hash: string): Partial<ShareableConfig> | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.trim()) return null;

  try {
    const params = new URLSearchParams(raw);
    const result: Partial<ShareableConfig> = {};

    const start = params.get('start');
    if (start) result.start = start;

    const target = params.get('target');
    if (target) result.target = target;

    const models = params.get('models');
    if (models) {
      result.models = models
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    }

    const maxSteps = params.get('maxSteps');
    if (maxSteps) {
      const parsed = parseInt(maxSteps, 10);
      if (Number.isFinite(parsed)) result.maxSteps = clampSetting('maxSteps', parsed);
    }

    const linkCap = params.get('linkCap');
    if (linkCap) {
      const parsed = parseInt(linkCap, 10);
      if (Number.isFinite(parsed)) result.linkCap = clampSetting('linkCap', parsed);
    }

    const temp = params.get('temp');
    if (temp) {
      const parsed = parseFloat(temp);
      if (Number.isFinite(parsed)) result.temperature = clampSetting('temperature', parsed);
    }

    const circling = params.get('circling');
    if (circling) {
      const parsed = parseInt(circling, 10);
      if (Number.isFinite(parsed))
        result.circlingThreshold = clampSetting('circlingThreshold', parsed);
    }

    const maxVisits = params.get('maxVisits');
    if (maxVisits) {
      const parsed = parseInt(maxVisits, 10);
      if (Number.isFinite(parsed))
        result.maxVisitsPerPage = clampSetting('maxVisitsPerPage', parsed);
    }

    const effort = params.get('effort') as ReasoningEffort | null;
    if (effort && REASONING_EFFORTS.includes(effort)) result.reasoningEffort = effort;

    const maxTokens = params.get('maxTokens');
    if (maxTokens) {
      const parsed = parseInt(maxTokens, 10);
      if (Number.isFinite(parsed)) result.maxOutputTokens = clampSetting('maxOutputTokens', parsed);
    }

    const stopFirst = params.get('stopFirst');
    if (stopFirst !== null) {
      result.stopOnFirstArrival = stopFirst === '1' || stopFirst === 'true';
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function copyShareLink(cfg: ShareableConfig): Promise<boolean> {
  const hash = encodeShareConfig(cfg);
  const url = `${window.location.origin}${window.location.pathname}${hash}`;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch {
    // Clipboard API might be blocked
  }

  // Fallback for environments where clipboard writeText is denied
  try {
    const tempInput = document.createElement('textarea');
    tempInput.value = url;
    tempInput.style.position = 'fixed';
    tempInput.style.opacity = '0';
    document.body.appendChild(tempInput);
    tempInput.select();
    const success = document.execCommand('copy');
    tempInput.remove();
    return success;
  } catch {
    return false;
  }
}
