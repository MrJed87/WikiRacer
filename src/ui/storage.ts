/**
 * Safe local and session storage helpers.
 *
 * Security rule: never log, persist (beyond opt-in storage), URL-encode or export the API key.
 * The default is sessionStorage, so the key disappears when the tab closes.
 */
import { STORAGE_KEYS } from '../config';
import { sanitiseCostHistory, type CostHistory } from '../race/costHistory';

export interface SavedSettings {
  maxSteps: number;
  linkCap: number;
  temperature: number;
  circlingThreshold: number;
  maxVisitsPerPage: number;
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens: number;
  budgetUsd: number;
  stepDelayMs: number;
  stopOnFirstArrival: boolean;
  selectedModelIds: string[];
  minIntelligence: number | null;
  modelSort: 'name' | 'intelligence' | 'price';
}

export function getStoredApiKey(): string {
  try {
    const sessionKey = sessionStorage.getItem(STORAGE_KEYS.apiKey);
    if (sessionKey) return sessionKey;
    const isRemembered = localStorage.getItem(STORAGE_KEYS.rememberKey) === 'true';
    if (isRemembered) {
      return localStorage.getItem(STORAGE_KEYS.apiKey) ?? '';
    }
  } catch {
    // Storage might be disabled or in private browsing
  }
  return '';
}

export function isApiKeyRemembered(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.rememberKey) === 'true';
  } catch {
    return false;
  }
}

export function storeApiKey(key: string, remember: boolean): void {
  const trimmed = key.trim();
  try {
    if (!trimmed) {
      clearStoredApiKey();
      return;
    }
    sessionStorage.setItem(STORAGE_KEYS.apiKey, trimmed);
    if (remember) {
      localStorage.setItem(STORAGE_KEYS.apiKey, trimmed);
      localStorage.setItem(STORAGE_KEYS.rememberKey, 'true');
    } else {
      localStorage.removeItem(STORAGE_KEYS.apiKey);
      localStorage.removeItem(STORAGE_KEYS.rememberKey);
    }
  } catch {
    // Graceful fallback
  }
}

export function clearStoredApiKey(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEYS.apiKey);
    localStorage.removeItem(STORAGE_KEYS.apiKey);
    localStorage.removeItem(STORAGE_KEYS.rememberKey);
  } catch {
    // Graceful fallback
  }
}

export function getStoredSettings(): Partial<SavedSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (raw) return JSON.parse(raw) as Partial<SavedSettings>;
  } catch {
    // Graceful fallback
  }
  return {};
}

export function storeSettings(settings: Partial<SavedSettings>): void {
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  } catch {
    // Graceful fallback
  }
}

/** Node thumbnails are on unless the viewer turned them off. */
export function getThumbnailsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.thumbnails) !== 'off';
  } catch {
    return true;
  }
}

export function storeThumbnailsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.thumbnails, enabled ? 'on' : 'off');
  } catch {
    // Graceful fallback
  }
}

/** What models have actually cost on this browser (per-viewer, not shared). */
export function getCostHistory(): CostHistory {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.costHistory);
    return raw ? sanitiseCostHistory(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function storeCostHistory(history: CostHistory): void {
  try {
    localStorage.setItem(STORAGE_KEYS.costHistory, JSON.stringify(history));
  } catch {
    // Graceful fallback
  }
}

/** The user's saved model group (the 📌 My group preset). */
export function getCustomGroup(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.customGroup);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function storeCustomGroup(ids: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.customGroup, JSON.stringify(ids));
  } catch {
    // Graceful fallback
  }
}
