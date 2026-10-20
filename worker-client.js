export class CancelError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelError';
  }
}

/** Runs removal jobs in a module worker. cancel() stops the work at once by ending the worker. */
export class InpaintClient {
  constructor() {
    this.worker = null;
    this.pending = null;
    this.counter = 0;
  }

  _ensure() {
    if (this.worker) return;
    const worker = new Worker(new URL('./inpaint.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = this.pending;
      if (!p || e.data.id !== p.id) return;
      this.pending = null;
      if (e.data.ok) p.resolve(e.data.rgba);
      else {
        // Start fresh next time: a worker that failed (for example out of memory) may be in a bad state.
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        p.reject(new Error(e.data.error));
      }
    };
    worker.onerror = (e) => {
      const p = this.pending;
      this.pending = null;
      this.worker = null;
      if (p) p.reject(new Error(e.message || 'The worker stopped unexpectedly.'));
    };
    this.worker = worker;
  }

  run({ rgba, mask, w, h }) {
    this._ensure();
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      this.pending = { id, resolve, reject };
      this.worker.postMessage({ id, rgba, mask, w, h }, [rgba, mask]);
    });
  }

  cancel() {
    if (this.pending) {
      this.pending.reject(new CancelError());
      this.pending = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
