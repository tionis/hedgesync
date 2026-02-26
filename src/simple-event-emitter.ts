type EventListener = (...args: any[]) => void;

/**
 * Minimal event emitter for browser-safe builds.
 */
export class SimpleEventEmitter {
  private listeners: Map<string, Set<EventListener>> = new Map();

  on(event: string, listener: EventListener): this {
    const existing = this.listeners.get(event);
    if (existing) {
      existing.add(listener);
    } else {
      this.listeners.set(event, new Set([listener]));
    }
    return this;
  }

  addListener(event: string, listener: EventListener): this {
    return this.on(event, listener);
  }

  once(event: string, listener: EventListener): this {
    const wrapped: EventListener = (...args: any[]) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: EventListener): this {
    const existing = this.listeners.get(event);
    if (!existing) return this;

    existing.delete(listener);
    if (existing.size === 0) {
      this.listeners.delete(event);
    }
    return this;
  }

  removeListener(event: string, listener: EventListener): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: any[]): boolean {
    const existing = this.listeners.get(event);
    if (!existing || existing.size === 0) {
      return false;
    }

    for (const listener of Array.from(existing)) {
      listener(...args);
    }
    return true;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
