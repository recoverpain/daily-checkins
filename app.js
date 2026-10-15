// Check-ins: record short clips through the day, merge them into one vertical video.
// Everything stays on the phone (IndexedDB). Merging is done in merge.js.
import { mergeClips } from './merge.js?v=3';

const $ = (id) => document.getElementById(id);

// ---------- Dates ----------
function dayKey(ts = Date.now()) {
  const d = new Date(ts); // a new day starts at midnight, phone time
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const fmtDayShort = (key) => dayDate(key).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const fmtDayLong = (key) => dayDate(key).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// ---------- Storage ----------
let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('daily-checkins', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('clips', { keyPath: 'id' }).createIndex('day', 'day');
      d.createObjectStore('videos', { keyPath: 'id' }).createIndex('day', 'day');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
  });
}
const getAll = (store) => tx([store], 'readonly', (t) => t.objectStore(store).getAll());
const putItem = (store, item) => tx([store], 'readwrite', (t) => { t.objectStore(store).put(item); });
const deleteItem = (store, id) => tx([store], 'readwrite', (t) => { t.objectStore(store).delete(id); });

async function clipsByDay() {
  const clips = (await getAll('clips')).sort((a, b) => a.createdAt - b.createdAt);
  const groups = new Map();
  for (const c of clips) {
    if (!groups.has(c.day)) groups.set(c.day, []);
    groups.get(c.day).push(c);
  }
  return groups;
}

// Ask iOS not to clear our storage when space runs low.
navigator.storage?.persist?.().catch(() => {});

// ---------- Screens ----------
const screens = ['home', 'camera', 'today', 'library', 'player'];
let current = 'home';
let backTo = 'home';
function show(name) {
  for (const s of screens) $(s).hidden = s !== name;
  current = name;
  if (name === 'home') renderHome();
  if (name === 'today') renderToday();
  if (name === 'library') renderLibrary();
}
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show('home')));

let toastTimer;
function toast(text, ok = true) {
  const el = $('toast');
  el.innerHTML = (ok ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '') +
    `<span></span>`;
  el.querySelector('span').textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

// Object URLs for thumbnails are made per render and released on the next one.
let urls = [];
function objectUrl(blob) {
  const u = URL.createObjectURL(blob);
  urls.push(u);
  return u;
}
function releaseUrls() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
}

// ---------- Home ----------
async function renderHome() {
  const today = dayKey();
  $('homeYear').textContent = String(dayDate(today).getFullYear());
  $('homeDate').textContent = fmtDayShort(today);

  const clips = (await clipsByDay()).get(today) || [];
  const badge = $('todayBadge');
  badge.hidden = clips.length === 0;
  badge.textContent = clips.length;

  const status = $('homeStatus');
  if (clips.length) {
    status.textContent = `${plural(clips.length, 'check-in')} today, last at ${fmtTime(clips[clips.length - 1].createdAt)}`;
  } else {
    const merged = (await getAll('videos')).some((v) => v.day === today);
    status.textContent = merged ? 'Today is merged and in your Library' : 'No check-ins yet today';
  }

  // Day line: midnight on the left, the next midnight on the right.
  const track = $('daylineTrack');
  track.textContent = '';
  const midnight = dayDate(today);
  const start = midnight.getTime();
  midnight.setDate(midnight.getDate() + 1);
  const end = midnight.getTime(); // 23 or 25 hours on clock-change days
  const pos = (ts) => `${Math.min(100, Math.max(0, ((ts - start) / (end - start)) * 100))}%`;
  const now = document.createElement('span');
  now.className = 'dayline-now';
  now.style.left = pos(Date.now());
  track.append(now);
  for (const c of clips) {
    const dot = document.createElement('span');
    dot.className = 'dayline-dot';
    dot.style.left = pos(c.createdAt);
    dot.title = fmtTime(c.createdAt);
    track.append(dot);
  }
}
$('openRecord').addEventListener('click', openCamera);
$('openToday').addEventListener('click', () => show('today'));
$('openLibrary').addEventListener('click', () => show('library'));

// The date changes at midnight even if the app stays open; refresh when it comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && current === 'home') renderHome();
});

// ---------- Camera ----------
let stream = null;
let facing = 'user';
let recorder = null;
let chunks = [];
let recStart = 0;
let recTick = null;
let pending = null; // the clip just recorded, waiting for X or the check mark

function pickMime() {
  if (!window.MediaRecorder) return null;
  const options = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return options.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
}

function camMessage(text) {
  $('camMsg').textContent = text || '';
  $('camMsg').hidden = !text;
}

async function startStream() {
  stopStream();
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const v = $('preview');
  v.srcObject = stream;
  v.classList.toggle('mirror', facing === 'user');
  await v.play().catch(() => {});
}
function stopStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('preview').srcObject = null;
}

async function updateCamCount() {
  const n = ((await clipsByDay()).get(dayKey()) || []).length;
  $('camCount').textContent = n ? `${plural(n, 'check-in')} saved today` : 'First check-in of the day';
}

async function openCamera() {
  show('camera');
  setReviewMode(false);
  camMessage('');
  updateCamCount();
  if (!navigator.mediaDevices?.getUserMedia || pickMime() === null) {
    camMessage('This browser cannot record video. On iPhone, open the app from Safari or from your home screen.');
    $('recBtn').disabled = true;
    return;
  }
  $('recBtn').disabled = true;
  try {
    await startStream();
    $('recBtn').disabled = false;
  } catch (err) {
    console.warn(err);
    camMessage(err?.name === 'NotAllowedError'
      ? 'Camera access is off. Allow Camera and Microphone for this site in Settings > Apps > Safari, then try again.'
      : 'The camera could not start. Close other apps that use the camera and try again.');
  }
}

function closeCamera() {
  if (recorder?.state === 'recording') {
    recorder.onstop = null;
    recorder.stop();
  }
  clearInterval(recTick);
  discardPending();
  stopStream();
  show('home');
}
$('camClose').addEventListener('click', closeCamera);

$('camFlip').addEventListener('click', async () => {
  if (recorder?.state === 'recording' || pending) return;
  facing = facing === 'user' ? 'environment' : 'user';
  try { await startStream(); } catch (err) { console.warn(err); camMessage('Could not switch cameras.'); }
});

function setReviewMode(on) {
  $('camLive').hidden = on;
  $('camReview').hidden = !on;
  $('review').hidden = !on;
  $('preview').hidden = on;
  $('camFlip').hidden = on;
}

// A still from the live preview, used as the clip's thumbnail. Drawn from the raw camera frame (not mirrored),
// so it matches what the recording looks like.
function grabThumb() {
  const v = $('preview');
  if (!v.videoWidth) return Promise.resolve(null);
  const w = 270, h = 480;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const scale = Math.max(w / v.videoWidth, h / v.videoHeight);
  const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
  c.getContext('2d').drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.75));
}

function startRecording() {
  const mimeType = pickMime();
  chunks = [];
  try {
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 6_000_000 });
  } catch {
    recorder = new MediaRecorder(stream);
  }
  let thumbPromise = null;
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    clearInterval(recTick);
    const duration = (Date.now() - recStart) / 1000;
    const type = recorder.mimeType || mimeType || 'video/mp4';
    const blob = new Blob(chunks, { type });
    chunks = [];
    if (!blob.size) {
      camMessage('Nothing was recorded. Try again.');
      resetRecButton();
      return;
    }
    const thumb = (await thumbPromise) || null;
    pending = { id: uid(), createdAt: recStart, day: dayKey(recStart), blob, type, duration, thumb };
    showReview();
  };
  recorder.start();
  recStart = Date.now();
  setTimeout(() => { thumbPromise = grabThumb(); }, 400);
  $('recBtn').classList.add('recording');
  $('recBtn').setAttribute('aria-label', 'Stop recording');
  $('recTimer').hidden = false;
  $('recTime').textContent = '0:00';
  recTick = setInterval(() => { $('recTime').textContent = fmtDur((Date.now() - recStart) / 1000); }, 250);
  camMessage('');
}

function resetRecButton() {
  $('recBtn').classList.remove('recording');
  $('recBtn').setAttribute('aria-label', 'Start recording');
  $('recTimer').hidden = true;
}

$('recBtn').addEventListener('click', () => {
  if (!stream) return;
  if (recorder?.state === 'recording') {
    if (Date.now() - recStart < 600) return; // ignore an accidental double tap
    recorder.stop();
    resetRecButton();
  } else {
    startRecording();
  }
});

let reviewUrl = null;
function showReview() {
  const v = $('review');
  reviewUrl = URL.createObjectURL(pending.blob);
  v.src = reviewUrl;
  v.classList.toggle('mirror', facing === 'user');
  v.muted = false;
  setReviewMode(true);
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
}
$('review').addEventListener('click', () => { const v = $('review'); v.muted = !v.muted; });

function discardPending() {
  const v = $('review');
  v.pause();
  v.removeAttribute('src');
  v.load();
  if (reviewUrl) URL.revokeObjectURL(reviewUrl);
  reviewUrl = null;
  pending = null;
}

$('discardBtn').addEventListener('click', () => {
  discardPending();
  setReviewMode(false);
  camMessage('');
});

async function savePending() {
  const clip = pending;
  await putItem('clips', clip);
  discardPending();
  return clip;
}

$('keepBtn').addEventListener('click', async () => {
  if (!pending) return;
  try {
    await savePending();
  } catch (err) {
    console.warn(err);
    toast('Could not save. Your phone may be out of space.', false);
    return;
  }
  stopStream();
  show('home');
  toast('Saved');
});

$('mergeBtn').addEventListener('click', async () => {
  if (!pending) return;
  let clip;
  try {
    clip = await savePending();
  } catch (err) {
    console.warn(err);
    toast('Could not save. Your phone may be out of space.', false);
    return;
  }
  stopStream();
  show('home');
  await finishDay(clip.day);
});

// ---------- Finish and Merge ----------
let merging = false;
async function finishDay(day) {
  if (merging) return;
  const clips = (await clipsByDay()).get(day) || [];
  if (!clips.length) { toast('No check-ins to merge yet', false); return; }

  merging = true;
  $('mergingTitle').textContent = `Merging ${plural(clips.length, 'check-in')}`;
  $('mergingNote').textContent = 'Keep the app open until it finishes.';
  $('mergingBar').style.width = '0%';
  $('merging').hidden = false;
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }

  try {
    const result = await mergeClips(clips, {
      onProgress: (p) => { $('mergingBar').style.width = `${Math.round(p * 100)}%`; },
      onSlowPath: () => { $('mergingNote').textContent = 'This takes about as long as the clips themselves. Keep the app open.'; },
    });
    const video = {
      id: uid(),
      day,
      createdAt: Date.now(),
      blob: result.blob,
      type: result.blob.type,
      duration: result.duration || clips.reduce((s, c) => s + (c.duration || 0), 0),
      clipCount: clips.length,
      thumb: clips.find((c) => c.thumb)?.thumb || null,
    };
    // Save the video and remove the clips in one step, so a failure never loses both.
    await tx(['videos', 'clips'], 'readwrite', (t) => {
      t.objectStore('videos').put(video);
      for (const c of clips) t.objectStore('clips').delete(c.id);
    });
    $('merging').hidden = true;
    show('library');
    toast('Saved to Library');
  } catch (err) {
    console.error(err);
    $('merging').hidden = true;
    toast('Merge failed. Your clips are still in Today.', false);
  } finally {
    lock?.release?.().catch?.(() => {});
    merging = false;
  }
}
$('todayMergeBtn').addEventListener('click', () => finishDay(dayKey()));

// ---------- Today ----------
// Two taps to delete: the first turns the button into "Delete", the second deletes.
function deleteButton(onDelete) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row-del';
  b.setAttribute('aria-label', 'Delete');
  const icon = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  b.innerHTML = icon;
  let armed = false, timer;
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      b.classList.add('confirm');
      b.textContent = 'Delete';
      timer = setTimeout(() => { armed = false; b.classList.remove('confirm'); b.innerHTML = icon; }, 3000);
      return;
    }
    clearTimeout(timer);
    await onDelete();
  });
  return b;
}

function row({ thumb, title, meta, onOpen, onDelete }) {
  const r = document.createElement('div');
  r.className = 'row';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'row-main';
  const img = document.createElement('img');
  img.className = 'thumb';
  img.alt = '';
  if (thumb) img.src = objectUrl(thumb);
  const text = document.createElement('span');
  text.className = 'row-text';
  const t = document.createElement('span');
  t.className = 'row-title';
  t.textContent = title;
  const m = document.createElement('span');
  m.className = 'row-meta';
  m.textContent = meta;
  text.append(t, m);
  main.append(img, text);
  main.addEventListener('click', onOpen);
  r.append(main);
  if (onDelete) r.append(deleteButton(onDelete));
  return r;
}

function emptyState(title, body) {
  const p = document.createElement('p');
  p.className = 'empty';
  const s = document.createElement('strong');
  s.textContent = title;
  p.append(s, body);
  return p;
}

async function renderToday() {
  releaseUrls();
  const list = $('todayList');
  list.textContent = '';
  const today = dayKey();
  const groups = await clipsByDay();
  const todays = groups.get(today) || [];

  $('todayFoot').hidden = todays.length === 0;

  if (!groups.size) {
    list.append(emptyState('No check-ins yet', 'Tap Record on the home screen. Each clip you keep shows up here until you finish the day.'));
    return;
  }

  // Today first, then any earlier day that was never merged.
  const days = [...groups.keys()].sort((a, b) => (a === today ? -1 : b === today ? 1 : b.localeCompare(a)));
  for (const day of days) {
    const head = document.createElement('div');
    head.className = 'group-head';
    const label = document.createElement('span');
    label.textContent = day === today ? fmtDayShort(day) : `${fmtDayShort(day)}, not merged`;
    head.append(label);
    if (day !== today) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Merge';
      b.addEventListener('click', () => finishDay(day));
      head.append(b);
    }
    list.append(head);
    groups.get(day).forEach((c, i) => {
      list.append(row({
        thumb: c.thumb,
        title: fmtTime(c.createdAt),
        meta: `Check-in ${i + 1} · ${fmtDur(c.duration)}`,
        onOpen: () => openPlayer('clips', c, `Check-in ${i + 1}`, `${fmtTime(c.createdAt)} · ${fmtDur(c.duration)}`),
        onDelete: async () => { await deleteItem('clips', c.id); renderToday(); },
      }));
    });
  }
}

// ---------- Library ----------
async function renderLibrary() {
  releaseUrls();
  const list = $('libraryList');
  list.textContent = '';
  const videos = (await getAll('videos')).sort((a, b) => b.day.localeCompare(a.day) || b.createdAt - a.createdAt);
  if (!videos.length) {
    list.append(emptyState('No videos yet', 'When you tap Finish and Merge, the day\'s check-ins become one video here.'));
    return;
  }
  // If a day was merged more than once, number its videos in the order they were made.
  const byDay = {};
  for (const v of videos) (byDay[v.day] ??= []).push(v);
  for (const list of Object.values(byDay)) list.sort((a, b) => a.createdAt - b.createdAt);
  for (const v of videos) {
    const sameDay = byDay[v.day];
    const part = sameDay.length > 1 ? sameDay.indexOf(v) + 1 : 0;
    const title = fmtDayLong(v.day);
    const meta = `${plural(v.clipCount, 'check-in')} · ${fmtDur(v.duration)}${part ? ` · Part ${part}` : ''}`;
    list.append(row({
      thumb: v.thumb,
      title,
      meta,
      onOpen: () => openPlayer('videos', v, title, meta),
    }));
  }
}

// ---------- Player ----------
let playing = null;
let playerUrl = null;
function openPlayer(store, item, title, meta) {
  backTo = current;
  playing = { store, item };
  $('playerTitle').textContent = title;
  $('playerMeta').textContent = meta;
  const v = $('playerVideo');
  playerUrl = URL.createObjectURL(item.blob);
  v.src = playerUrl;
  resetPlayerDelete();
  show('player');
  v.play().catch(() => {});
}
function closePlayer() {
  const v = $('playerVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = null;
  playing = null;
  show(backTo);
}
$('playerClose').addEventListener('click', closePlayer);

$('playerSave').addEventListener('click', async () => {
  if (!playing) return;
  const { item } = playing;
  const ext = (item.type || item.blob.type).includes('webm') ? 'webm' : 'mp4';
  const name = `Check-ins ${item.day}${playing.store === 'clips' ? ` ${fmtTime(item.createdAt).replace(/[: ]/g, '')}` : ''}.${ext}`;
  const file = new File([item.blob], name, { type: item.type || item.blob.type });
  // On iPhone the share sheet has "Save Video", which puts it in Photos.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (err) { if (err?.name !== 'AbortError') toast('Could not open the share sheet', false); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

let playerDeleteArmed = false, playerDeleteTimer;
function resetPlayerDelete() {
  playerDeleteArmed = false;
  clearTimeout(playerDeleteTimer);
  $('playerDelete').classList.remove('confirm');
  $('playerDelete').textContent = 'Delete';
}
$('playerDelete').addEventListener('click', async () => {
  if (!playing) return;
  if (!playerDeleteArmed) {
    playerDeleteArmed = true;
    $('playerDelete').classList.add('confirm');
    $('playerDelete').textContent = 'Tap to delete';
    playerDeleteTimer = setTimeout(resetPlayerDelete, 3000);
    return;
  }
  await deleteItem(playing.store, playing.item.id);
  closePlayer();
  toast('Deleted');
});

// ---------- Start ----------
show('home');
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline support unavailable', err));
}

// Hook for testing in a desktop browser without a camera.
window.checkins = { putItem, getAll, dayKey, finishDay, show };
