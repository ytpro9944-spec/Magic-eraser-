// Turns brush strokes into a job for the worker, and the worker's answer into pixels.
// Only a crop around the strokes is processed, so the rest of the photo is never touched.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Strokes are { r, pts: [[x, y], ...] } in full-resolution photo pixels. */
export function strokesBounds(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x - s.r); y0 = Math.min(y0, y - s.r);
      x1 = Math.max(x1, x + s.r); y1 = Math.max(y1, y + s.r);
    }
  }
  return { x0, y0, x1, y1 };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** One byte per pixel of the crop: 255 where the user painted, 0 elsewhere. */
export function renderMask(strokes, ox, oy, w, h) {
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = ctx.fillStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.lineWidth = Math.max(1, s.r * 2);
    ctx.beginPath();
    if (s.pts.length === 1) {
      ctx.arc(s.pts[0][0] - ox, s.pts[0][1] - oy, Math.max(0.5, s.r), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(s.pts[0][0] - ox, s.pts[0][1] - oy);
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i][0] - ox, s.pts[i][1] - oy);
      ctx.stroke();
    }
  }
  const px = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4] >= 128 ? 255 : 0;
  return mask;
}

/**
 * Removes whatever the strokes cover. Does not change `base`; the caller writes `after` back.
 * Returns { x, y, w, h, before, after } where before and after are ImageData for that rectangle.
 */
export async function eraseStrokes(base, strokes, client) {
  if (!strokes.length) throw new Error('Nothing is marked yet.');
  const W = base.width, H = base.height;
  const b = strokesBounds(strokes);
  const margin = Math.max(64, Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.6));
  const x0 = clamp(Math.floor(b.x0 - margin), 0, W), y0 = clamp(Math.floor(b.y0 - margin), 0, H);
  const x1 = clamp(Math.ceil(b.x1 + margin), 0, W), y1 = clamp(Math.ceil(b.y1 + margin), 0, H);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) throw new Error('The marks are outside the photo.');

  const ctx = base.getContext('2d', { willReadFrequently: true });
  const before = ctx.getImageData(x0, y0, w, h);
  const mask = renderMask(strokes, x0, y0, w, h);
  const rgba = new Uint8ClampedArray(before.data).buffer;
  const out = await client.run({ rgba, mask: mask.buffer, w, h });
  const after = new ImageData(new Uint8ClampedArray(out), w, h);
  return { x: x0, y: y0, w, h, before, after };
}
