/** Shared Wikipedia-layer types. No DOM. */

export interface PageData {
  /** Canonical title after redirect resolution. */
  title: string;
  /** Lead text for the prompt. */
  summary: string;
  /** Canonical link titles, in page order, deduped and capped. */
  links: string[];
  /** Distinct valid links before the cap. */
  totalLinks: number;
  truncated: boolean;
  isDisambiguation: boolean;
}

/** What the race engine needs from Wikipedia. The real client and the fake wiki both implement it. */
export interface WikiSource {
  getPage(title: string): Promise<PageData>;
}

export type WikiErrorKind =
  'not-found' | 'rate-limit' | 'network' | 'api' | 'invalid-response' | 'no-start';

export class WikiError extends Error {
  readonly kind: WikiErrorKind;
  readonly status: number | undefined;

  constructor(kind: WikiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'WikiError';
    this.kind = kind;
    this.status = status;
  }

  /** Transient failures worth retrying. */
  get retryable(): boolean {
    return (
      this.kind === 'rate-limit' ||
      this.kind === 'network' ||
      (this.status !== undefined && this.status >= 500)
    );
  }
}
