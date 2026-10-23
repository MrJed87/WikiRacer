/**
 * Accessible, lightweight toast notification system.
 * Renders all messages using textContent, because message text can come from models or Wikipedia
 * and must be treated as untrusted.
 */

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  type?: ToastType;
  durationMs?: number;
}

class ToastManager {
  private container: HTMLElement | null = null;

  private getContainer(): HTMLElement {
    if (!this.container) {
      let el = document.getElementById('toast-container');
      if (!el) {
        el = document.createElement('div');
        el.id = 'toast-container';
        el.className = 'toast-container';
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('aria-atomic', 'true');
        document.body.appendChild(el);
      }
      this.container = el;
    }
    return this.container;
  }

  show(message: string, opts: ToastOptions = {}): () => void {
    const container = this.getContainer();
    const type = opts.type ?? 'info';
    const duration = opts.durationMs ?? (type === 'error' ? 6000 : 3500);

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-message';
    msgSpan.textContent = message; // Pure textContent: untrusted strings cannot inject HTML
    toast.appendChild(msgSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Close notification');
    closeBtn.textContent = '✕';
    toast.appendChild(closeBtn);

    let timer: number | null = null;

    const dismiss = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      toast.classList.add('toast-dismissing');
      setTimeout(() => {
        toast.remove();
      }, 200);
    };

    closeBtn.addEventListener('click', dismiss);

    if (duration > 0) {
      timer = window.setTimeout(dismiss, duration);
    }

    container.appendChild(toast);
    return dismiss;
  }
}

export const toast = new ToastManager();
