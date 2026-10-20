import { CanvasStage } from './stage.js';
import { InpaintClient, CancelError } from './worker-client.js';
import { eraseStrokes } from './pipeline.js';

const $ = (id) => document.getElementById(id);
const MAX_PIXELS = 16_000_000; // phones cannot make bigger canvases than this

const views = { home: $('view-home'), editor: $('view-editor'), result: $('view-result') };
const S = { view: 'home', base: null, stem: 'photo', type: 'image/jpeg', last: null, acceptNext: false };
const client = new InpaintClient();

// ---- small helpers ----------------------------------------------------------------------------

const live = $('live');
function announce(message) {
  live.textContent = '';
  setTimeout(() => { live.textContent = message; }, 30);
}

function show(name) {
  S.view = name;
  views.home.hidden = name !== 'home';
  views.editor.hidden = name !== 'editor' && name !== 'processing';
  views.result.hidden = name !== 'result';
  $('processing').hidden = name !== 'processing';
  $('ed-body').inert = name === 'processing';
  const target = { home: 'home-title', editor: 'ed-title', processing: 'proc-cancel', result: 'rs-title' }[name];
  const el = $(target);
  if (el) el.focus({ preventScroll: true });
}

function safeStorage(fn) { try { return fn(); } catch (_) { return null; } }

// ---- stages -----------------------------------------------------------------------------------

const ed = new CanvasStage({
  viewport: $('ed-viewport'), stage: $('ed-stage'), image: $('ed-image'), mask: $('ed-mask'),
  cursor: $('ed-cursor'), drawable: true,
  onChange: ({ hasMask, canUndo, canRedo }) => {
    $('ed-erase').disabled = !hasMask;
    $('ed-clear').disabled = !hasMask;
    $('ed-undo').disabled = !canUndo;
    $('ed-redo').disabled = !canRedo;
    if (hasMask) $('ed-hint').hidden = true;
  },
});
const rs = new CanvasStage({ viewport: $('rs-viewport'), stage: $('rs-stage'), image: $('rs-image'), drawable: false });

// ---- S01 and S02: open a photo ---------------------------------------------------------------

function setHomeError(text) {
  $('home-error').textContent = text;
  $('home-error').hidden = !text;
}

async function openFile(file) {
  setHomeError('');
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    setHomeError("That isn't a photo. Choose a JPEG, PNG or WebP image.");
    return;
  }
  $('pick').disabled = true;
  try {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { bmp = await createImageBitmap(file); }
    let w = bmp.width, h = bmp.height, scaled = false;
    if (w * h > MAX_PIXELS) {
      const f = Math.sqrt(MAX_PIXELS / (w * h));
      w = Math.floor(w * f); h = Math.floor(h * f); scaled = true;
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    S.base = c;
    S.stem = (file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
    S.type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    openEditor(scaled ? `This photo is very large, so it was scaled down to ${w} by ${h} pixels to fit in memory.` : '');
  } catch (_) {
    setHomeError("This photo couldn't be opened. Try a JPEG or PNG.");
  } finally {
    $('pick').disabled = false;
    $('file').value = '';
  }
}

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => openFile(e.target.files[0]));
window.addEventListener('dragover', (e) => { if (S.view === 'home') e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (S.view !== 'home') return;
  e.preventDefault();
  openFile(e.dataTransfer.files[0]);
});
window.addEventListener('paste', (e) => {
  if (S.view !== 'home') return;
  const f = [...(e.clipboardData ? e.clipboardData.files : [])].find((x) => x.type.startsWith('image/'));
  if (f) openFile(f);
});

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('install').hidden = false; });
window.addEventListener('appinstalled', () => { $('install').hidden = true; installPrompt = null; });
$('install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  installPrompt = null;
  $('install').hidden = true;
});

// ---- S03: editor ------------------------------------------------------------------------------

function openEditor(message) {
  history.pushState({ view: 'editor' }, '');
  show('editor');
  ed.setDimensions(S.base.width, S.base.height);
  ed.drawImage(S.base);
  $('ed-hint').hidden = false;
  announce(message || 'Photo opened. Paint over what you want removed.');
  if (message) { $('ed-hint').textContent = message; }
  else $('ed-hint').textContent = 'Paint over what you want gone. Pinch or scroll to zoom, two fingers to move around.';
}

const brushSlider = $('ed-brush');
function setBrush(v) {
  ed.setBrush(v);
  $('ed-brush-out').textContent = String(v);
  brushSlider.value = String(v);
  safeStorage(() => localStorage.setItem('tidy.brush', String(v)));
}
setBrush(Number(safeStorage(() => localStorage.getItem('tidy.brush'))) || 48);
brushSlider.addEventListener('input', () => setBrush(Number(brushSlider.value)));

$('ed-back').addEventListener('click', () => history.back());
$('ed-undo').addEventListener('click', () => ed.undo());
$('ed-redo').addEventListener('click', () => ed.redo());
$('ed-fit').addEventListener('click', () => ed.fit());
$('ed-clear').addEventListener('click', () => ed.clearStrokes());
$('ed-erase').addEventListener('click', () => runErase());

document.addEventListener('keydown', (e) => {
  if (S.view !== 'editor') return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) ed.redo(); else ed.undo(); }
  else if (mod && key === 'y') { e.preventDefault(); ed.redo(); }
  else if (e.key === '[') setBrush(Math.max(12, Number(brushSlider.value) - 8));
  else if (e.key === ']') setBrush(Math.min(160, Number(brushSlider.value) + 8));
});

// ---- S04: working -----------------------------------------------------------------------------

function showWorking() {
  $('proc-working').hidden = false;
  $('proc-failed').hidden = true;
  show('processing');
}

function runErase() {
  if (S.view !== 'editor' || !ed.hasMask()) return;
  history.pushState({ view: 'processing' }, '');
  performErase();
}

// Also used by Try again, which stays on the same history entry (no back-then-forward race).
async function performErase() {
  showWorking();
  announce('Removing it. This can take a few seconds.');
  try {
    const res = await eraseStrokes(S.base, ed.getStrokes(), client);
    S.last = { ...res, beforeDisplay: copyScaled(S.base) }; // copy first: the next line changes the photo
    S.base.getContext('2d', { willReadFrequently: true }).putImageData(res.after, res.x, res.y);
    history.replaceState({ view: 'result' }, '');
    showResult();
  } catch (err) {
    if (err instanceof CancelError) return;
    $('proc-error-text').textContent = 'Something went wrong while removing it. Your photo is unchanged.';
    $('proc-working').hidden = true;
    $('proc-failed').hidden = false;
    $('proc-retry').focus();
    announce('That did not work. Your photo is unchanged.');
  }
}

/** A copy of the photo at on-screen size, so Show original can swap instantly. */
function copyScaled(src) {
  const k = Math.min(1, 2048 / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * k));
  c.height = Math.max(1, Math.round(src.height * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

$('proc-cancel').addEventListener('click', () => history.back());
$('proc-back').addEventListener('click', () => history.back());
$('proc-retry').addEventListener('click', () => { if (S.view === 'processing') performErase(); });

// ---- S05: result ------------------------------------------------------------------------------

function showResult() {
  show('result');
  rs.setDimensions(S.base.width, S.base.height);
  rs.drawImage(S.base);
  setCompare(false);
  announce('Done. Hold Show original to compare.');
}

const cmp = $('rs-compare');
function setCompare(on) {
  if (S.last && S.last.beforeDisplay) rs.drawImage(on ? S.last.beforeDisplay : S.base);
  cmp.setAttribute('aria-pressed', String(on));
}
cmp.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { cmp.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
  setCompare(true);
});
cmp.addEventListener('pointerup', () => setCompare(false));
cmp.addEventListener('pointercancel', () => setCompare(false));
// A keyboard or screen reader press (click with no pointer) toggles instead of holding.
cmp.addEventListener('click', (e) => { if (e.detail === 0) setCompare(cmp.getAttribute('aria-pressed') !== 'true'); });

async function exportFile() {
  const type = S.type;
  const blob = await new Promise((res) => S.base.toBlob(res, type, 0.95));
  const name = `${S.stem}-clean.${type === 'image/png' ? 'png' : 'jpg'}`;
  return { blob, name, type };
}

$('rs-save').addEventListener('click', async () => {
  const { blob, name } = await exportFile();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  announce(`Saved as ${name}.`);
});

const canShareFiles = () => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] })); } catch (_) { return false; }
};
$('rs-share').hidden = !canShareFiles();
$('rs-share').addEventListener('click', async () => {
  const { blob, name, type } = await exportFile();
  try { await navigator.share({ files: [new File([blob], name, { type })], title: name }); } catch (_) { /* cancelled */ }
});

function revert() {
  if (!S.last) return;
  S.base.getContext('2d', { willReadFrequently: true }).putImageData(S.last.before, S.last.x, S.last.y);
  S.last = null;
}
function accept() {
  ed.drawImage(S.base);
  ed.clearStrokes();
  S.last = null;
}

$('rs-back').addEventListener('click', () => history.back());
$('rs-continue').addEventListener('click', () => { S.acceptNext = true; history.back(); });
$('rs-new').addEventListener('click', () => history.go(-2));

function toHome() {
  client.cancel();
  S.base = null; S.last = null; S.acceptNext = false;
  $('file').value = '';
  show('home');
}

// ---- back button handling ---------------------------------------------------------------------

history.replaceState({ view: 'home' }, '');
window.addEventListener('popstate', (e) => {
  const target = (e.state && e.state.view) || 'home';
  if (S.view === 'processing') {
    client.cancel();
    if (target === 'home') toHome(); else show('editor');
    return;
  }
  if (S.view === 'result') {
    if (target === 'home') { toHome(); return; }
    if (S.acceptNext) accept(); else revert();
    S.acceptNext = false;
    show('editor');
    return;
  }
  if (S.view === 'editor' && target === 'home') toHome();
});

// ---- offline and install ----------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
