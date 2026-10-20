import { inpaint } from './inpaint-core.js';

// One job at a time. The page cancels by terminating this worker.
self.onmessage = (e) => {
  const { id, rgba, mask, w, h } = e.data;
  try {
    const out = inpaint(new Uint8ClampedArray(rgba), new Uint8Array(mask), w, h);
    self.postMessage({ id, ok: true, rgba: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
