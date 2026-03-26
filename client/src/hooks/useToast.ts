import { createContext, useContext, useCallback, useRef, useSyncExternalStore } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  createdAt: number;
}

type Listener = () => void;

class ToastStore {
  private toasts: Toast[] = [];
  private listeners = new Set<Listener>();
  private counter = 0;

  getSnapshot = (): Toast[] => this.toasts;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    this.toasts = [...this.toasts];
    for (const l of this.listeners) l();
  }

  add(type: ToastType, message: string, duration = 4000): string {
    const id = `toast-${++this.counter}-${Date.now()}`;
    this.toasts = [...this.toasts, { id, type, message, createdAt: Date.now() }];
    this.emit();
    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
    return id;
  }

  dismiss(id: string) {
    const idx = this.toasts.findIndex(t => t.id === id);
    if (idx === -1) return;
    this.toasts = this.toasts.filter(t => t.id !== id);
    this.emit();
  }
}

// Singleton store — no context provider needed
const store = new ToastStore();

export function useToast() {
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const toast = useCallback((type: ToastType, message: string, duration?: number) => {
    return store.add(type, message, duration);
  }, []);

  const dismiss = useCallback((id: string) => {
    store.dismiss(id);
  }, []);

  return { toasts, toast, dismiss };
}

// Also export the store for imperative use (e.g., from WebSocket handlers)
export const toastStore = store;
