// Patch-based fill ("engine A2"). No dependencies. Runs in a Web Worker or in Node.
//
// Method (the published PatchMatch + voting approach, Barnes et al. 2009 and Wexler et al. 2007):
// from small to large, for every patch that touches the hole find the most similar patch that lies
// entirely in known pixels, then rebuild each hole pixel as the weighted average of what those
// patches say it should be. Texture is copied from the photo itself instead of being blurred in.
//
// Contract: patchFill(color, wt, w, h, opts) -> Float32Array RGBA (w * h * 4), or null if there is
// nothing to copy from (the caller then falls back to the smooth fill).
//   color  Float32 RGBA, known pixels filled in. Not modified.
//   wt     Float32, 1 = known pixel, below 0.999 = hole. Not modified.
//   opts   { init(color, wt, w, h) -> filled color (required, used for the smallest level),
//            seed, radius, iterations: [coarsest, middle, finest] }

const DEFAULT_RADIUS = 3; // 7 x 7 patches
const MIN_SOURCES = 16;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Half-size copy, averaging only known pixels. wt becomes the fraction of known pixels. */
function halve(c, wt, w, h) {
  const nw = (w + 1) >> 1, nh = (h + 1) >> 1;
  const nc = new Float32Array(nw * nh * 4);
  const nwt = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let sw = 0, r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let dy = 0; dy < 2; dy++) {
        const sy = 2 * y + dy;
        if (sy >= h) break;
        for (let dx = 0; dx < 2; dx++) {
          const sx = 2 * x + dx;
          if (sx >= w) break;
          const i = sy * w + sx;
          const wi = wt[i];
          cnt++;
          if (wi > 0) {
            sw += wi;
            r += wi * c[i * 4]; g += wi * c[i * 4 + 1]; b += wi * c[i * 4 + 2]; a += wi * c[i * 4 + 3];
          }
        }
      }
      const o = y * nw + x;
      if (sw > 0) {
        nc[o * 4] = r / sw; nc[o * 4 + 1] = g / sw; nc[o * 4 + 2] = b / sw; nc[o * 4 + 3] = a / sw;
        nwt[o] = sw / cnt;
      }
    }
  }
  return { c: nc, wt: nwt, w: nw, h: nh };
}

/**
 * For every pixel whose (2r+1) square window lies inside the image: how many hole pixels it holds.
 * -1 where the window leaves the image. Uses a summed-area table, so it is fast at any radius.
 */
function holeWindowCounts(isHole, w, h, r) {
  const W1 = w + 1;
  const sat = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += isHole[y * w + x];
      sat[(y + 1) * W1 + x + 1] = sat[y * W1 + x + 1] + row;
    }
  }
  const cnt = new Int32Array(w * h).fill(-1);
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const x0 = x - r, y0 = y - r, x1 = x + r + 1, y1 = y + r + 1;
      cnt[y * w + x] = sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
    }
  }
  return cnt;
}

function prepareLevel(lv, r) {
  const n = lv.w * lv.h;
  lv.isHole = new Uint8Array(n);
  for (let i = 0; i < n; i++) lv.isHole[i] = lv.wt[i] < 0.999 ? 1 : 0;
  const cnt = holeWindowCounts(lv.isHole, lv.w, lv.h, r);
  let nt = 0, ns = 0;
  for (let i = 0; i < n; i++) { if (cnt[i] > 0) nt++; else if (cnt[i] === 0) ns++; }
  lv.ok = new Uint8Array(n);               // 1 = a patch centred here is entirely known
  lv.targets = new Int32Array(nt);         // centres of patches that touch the hole
  lv.sources = new Int32Array(ns);
  for (let i = 0, a = 0, b = 0; i < n; i++) {
    if (cnt[i] > 0) lv.targets[a++] = i;
    else if (cnt[i] === 0) { lv.ok[i] = 1; lv.sources[b++] = i; }
  }
}

/** Sum of squared RGB differences between the patches centred at p and q. Stops early once past `best`. */
function patchDist(cur, w, p, q, r, best) {
  let d = 0;
  for (let dy = -r; dy <= r; dy++) {
    let a = (p + dy * w - r) * 4, b = (q + dy * w - r) * 4;
    for (let dx = -r; dx <= r; dx++, a += 4, b += 4) {
      const e0 = cur[a] - cur[b], e1 = cur[a + 1] - cur[b + 1], e2 = cur[a + 2] - cur[b + 2];
      d += e0 * e0 + e1 * e1 + e2 * e2;
    }
    if (d >= best) return d;
  }
  return d;
}

/** Bilinear upsample of the coarse result into the hole pixels of the finer level. */
function upsampleHole(fine, coarse, cw, ch, cur) {
  const { w, h, c: known, isHole } = fine;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(ch - 1, Math.max(0, y * 0.5 - 0.25));
    const y0 = Math.floor(fy), y1 = Math.min(ch - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isHole[i]) {
        for (let k = 0; k < 4; k++) cur[i * 4 + k] = known[i * 4 + k];
        continue;
      }
      const fx = Math.min(cw - 1, Math.max(0, x * 0.5 - 0.25));
      const x0 = Math.floor(fx), x1 = Math.min(cw - 1, x0 + 1), tx = fx - x0;
      const a00 = (y0 * cw + x0) * 4, a10 = (y0 * cw + x1) * 4, a01 = (y1 * cw + x0) * 4, a11 = (y1 * cw + x1) * 4;
      for (let k = 0; k < 4; k++) {
        const t = coarse[a00 + k] * (1 - tx) + coarse[a10 + k] * tx;
        const b = coarse[a01 + k] * (1 - tx) + coarse[a11 + k] * tx;
        cur[i * 4 + k] = t * (1 - ty) + b * ty;
      }
    }
  }
}

export function patchFill(color, wt, w, h, opts = {}) {
  const r = opts.radius ?? DEFAULT_RADIUS;
  const init = opts.init;
  if (typeof init !== 'function') throw new Error('patchFill needs opts.init');
  const iters = opts.iterations ?? [6, 4, 2];
  const rnd = mulberry32(opts.seed ?? 0x2545f491);
  const win = 2 * r + 1;
  if (w < win + 2 || h < win + 2) return null;

  // pyramid, finest first, stopping when the picture is small or too thin for patches
  const levels = [{ c: color, wt, w, h }];
  for (;;) {
    const t = levels[levels.length - 1];
    if (Math.max(t.w, t.h) <= 40 || Math.min(t.w, t.h) < 4 * win) break;
    levels.push(halve(t.c, t.wt, t.w, t.h));
  }
  for (const lv of levels) prepareLevel(lv, r);

  // start at the coarsest level that still has something to copy from
  let top = levels.length - 1;
  while (top >= 0 && levels[top].sources.length < MIN_SOURCES) top--;
  if (top < 0) return null;
  for (let l = top; l >= 0; l--) if (levels[l].sources.length === 0) return null;

  const T = levels[top];
  let cur = init(T.c.slice(), T.wt.slice(), T.w, T.h);
  let nnf = null;

  for (let l = top; l >= 0; l--) {
    const lv = levels[l];
    const { w: lw, h: lh, ok, targets, sources, isHole } = lv;
    const n = lw * lh;

    if (l < top) {
      const coarse = levels[l + 1];
      const next = new Float32Array(n * 4);
      upsampleHole(lv, cur, coarse.w, coarse.h, next);
      // carry the matches down a level: twice the coordinates, same patch
      const prev = nnf;
      nnf = new Int32Array(n).fill(-1);
      for (let k = 0; k < targets.length; k++) {
        const p = targets[k];
        const px = p % lw, py = (p - px) / lw;
        const cx = Math.min(coarse.w - 1, px >> 1), cy = Math.min(coarse.h - 1, py >> 1);
        const cq = prev[cy * coarse.w + cx];
        if (cq >= 0) {
          const qx = (cq % coarse.w) * 2 + (px & 1), qy = Math.floor(cq / coarse.w) * 2 + (py & 1);
          if (qx >= 0 && qx < lw && qy >= 0 && qy < lh && ok[qy * lw + qx]) nnf[p] = qy * lw + qx;
        }
      }
      cur = next;
    } else {
      nnf = new Int32Array(n).fill(-1);
    }
    for (let k = 0; k < targets.length; k++) {
      if (nnf[targets[k]] < 0) nnf[targets[k]] = sources[(rnd() * sources.length) | 0];
    }

    const dst = new Float32Array(n);
    const acc = new Float32Array(n * 4);
    const wsum = new Float32Array(n);
    const rounds = l === top ? iters[0] : l === 0 ? iters[2] : iters[1];
    const maxRad = Math.max(lw, lh);

    for (let it = 0; it < rounds; it++) {
      for (let k = 0; k < targets.length; k++) dst[targets[k]] = patchDist(cur, lw, targets[k], nnf[targets[k]], r, Infinity);

      const forward = (it & 1) === 0;
      const nt = targets.length;
      for (let k = 0; k < nt; k++) {
        const p = forward ? targets[k] : targets[nt - 1 - k];
        let best = nnf[p], bd = dst[p];
        // propagation: a neighbour's match, shifted by one pixel, is a good guess for me
        const px = p % lw;
        const s = forward ? -1 : 1;
        const nbrs = [px + s >= 0 && px + s < lw ? p + s : -1, p + s * lw];
        for (let t = 0; t < 2; t++) {
          const nb = nbrs[t];
          if (nb < 0 || nb >= n || nnf[nb] < 0) continue;
          const q = nnf[nb] - (nb - p);
          if (q < 0 || q >= n || !ok[q]) continue;
          const d = patchDist(cur, lw, p, q, r, bd);
          if (d < bd) { bd = d; best = q; }
        }
        // random search around the current best, with a shrinking radius
        for (let rad = maxRad; rad >= 1; rad >>= 1) {
          const bx = best % lw, by = (best - bx) / lw;
          const qx = bx + ((rnd() * (2 * rad + 1)) | 0) - rad;
          const qy = by + ((rnd() * (2 * rad + 1)) | 0) - rad;
          if (qx < r || qx >= lw - r || qy < r || qy >= lh - r) continue;
          const q = qy * lw + qx;
          if (!ok[q]) continue;
          const d = patchDist(cur, lw, p, q, r, bd);
          if (d < bd) { bd = d; best = q; }
        }
        nnf[p] = best;
        dst[p] = bd;
      }

      // vote: every hole pixel becomes the weighted mean of what the patches covering it say
      acc.fill(0);
      wsum.fill(0);
      const area3 = win * win * 3;
      for (let k = 0; k < nt; k++) {
        const p = targets[k], q = nnf[p];
        const wgt = 1 / (1 + dst[p] / area3 / 40);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = p + dy * lw + dx;
            if (!isHole[x]) continue;
            const sIdx = (q + dy * lw + dx) * 4;
            acc[x * 4] += wgt * cur[sIdx]; acc[x * 4 + 1] += wgt * cur[sIdx + 1];
            acc[x * 4 + 2] += wgt * cur[sIdx + 2]; acc[x * 4 + 3] += wgt * cur[sIdx + 3];
            wsum[x] += wgt;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        if (isHole[i] && wsum[i] > 0) {
          const inv = 1 / wsum[i];
          cur[i * 4] = acc[i * 4] * inv; cur[i * 4 + 1] = acc[i * 4 + 1] * inv;
          cur[i * 4 + 2] = acc[i * 4 + 2] * inv; cur[i * 4 + 3] = acc[i * 4 + 3] * inv;
        }
      }
    }
  }
  return cur;
}
