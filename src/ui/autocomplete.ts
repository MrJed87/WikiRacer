/**
 * Accessible autocomplete dropdown for Wikipedia article titles.
 * Supports keyboard navigation (Up, Down, Enter, Escape) and click selection.
 * Safely renders article titles using textContent.
 */

export interface AutocompleteOptions {
  input: HTMLInputElement;
  container: HTMLElement;
  fetchSuggestions: (query: string) => Promise<string[]>;
  onSelect: (value: string) => void;
  debounceMs?: number;
}

export class Autocomplete {
  private readonly input: HTMLInputElement;
  private readonly listbox: HTMLElement;
  private readonly fetchSuggestions: (query: string) => Promise<string[]>;
  private readonly onSelect: (value: string) => void;
  private readonly debounceMs: number;

  private items: string[] = [];
  private activeIndex = -1;
  private debounceTimer: number | null = null;
  private isOpen = false;

  constructor(opts: AutocompleteOptions) {
    this.input = opts.input;
    this.fetchSuggestions = opts.fetchSuggestions;
    this.onSelect = opts.onSelect;
    this.debounceMs = opts.debounceMs ?? 200;

    this.listbox = document.createElement('ul');
    this.listbox.className = 'autocomplete-listbox';
    this.listbox.setAttribute('role', 'listbox');
    this.listbox.style.display = 'none';

    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');

    opts.container.appendChild(this.listbox);

    this.setupListeners();
  }

  private setupListeners(): void {
    this.input.addEventListener('input', () => {
      this.handleInput();
    });

    this.input.addEventListener('keydown', (e) => {
      this.handleKeyDown(e);
    });

    this.input.addEventListener('blur', () => {
      // Delay to allow click event on suggestion item to register
      setTimeout(() => this.close(), 180);
    });
  }

  private handleInput(): void {
    const val = this.input.value.trim();
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    if (!val) {
      this.close();
      return;
    }
    this.debounceTimer = window.setTimeout(async () => {
      try {
        const results = await this.fetchSuggestions(val);
        if (this.input.value.trim() !== val) return; // Stale query
        this.renderSuggestions(results);
      } catch {
        this.close();
      }
    }, this.debounceMs);
  }

  private renderSuggestions(items: string[]): void {
    this.items = items;
    this.listbox.innerHTML = '';
    this.activeIndex = -1;

    if (!items.length) {
      this.close();
      return;
    }

    items.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'autocomplete-option';
      li.setAttribute('role', 'option');
      li.id = `autocomplete-opt-${idx}`;
      li.textContent = item; // untrusted Wikipedia text rendered via textContent

      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent input blur before click
      });

      li.addEventListener('click', () => {
        this.select(item);
      });

      this.listbox.appendChild(li);
    });

    this.open();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.isOpen) {
      if (e.key === 'ArrowDown') {
        this.handleInput();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.setActiveIndex((this.activeIndex + 1) % this.items.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.setActiveIndex((this.activeIndex - 1 + this.items.length) % this.items.length);
        break;
      case 'Enter':
        if (this.activeIndex >= 0 && this.items[this.activeIndex]) {
          e.preventDefault();
          this.select(this.items[this.activeIndex]!);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.close();
        break;
    }
  }

  private setActiveIndex(idx: number): void {
    this.activeIndex = idx;
    const options = this.listbox.querySelectorAll<HTMLElement>('.autocomplete-option');
    options.forEach((opt, i) => {
      const isSelected = i === idx;
      opt.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      opt.classList.toggle('is-active', isSelected);
      if (isSelected) {
        opt.scrollIntoView({ block: 'nearest' });
        this.input.setAttribute('aria-activedescendant', opt.id);
      }
    });
  }

  private select(item: string): void {
    this.input.value = item;
    this.onSelect(item);
    this.close();
  }

  private open(): void {
    this.isOpen = true;
    this.listbox.style.display = 'block';
    this.input.setAttribute('aria-expanded', 'true');
  }

  private close(): void {
    this.isOpen = false;
    this.listbox.style.display = 'none';
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.activeIndex = -1;
  }

  destroy(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.listbox.remove();
  }
}
