// Joins a day's clips into one video.
//
// Fast path: copy the recorded video and audio data into a new file without re-encoding (a few seconds on a
// phone). This works when every clip was recorded in the same format, which is the normal case.
// Slow path: play the clips one after another into a canvas and record that. It takes as long as the clips
// themselves, but it copes with clips in different formats or sizes.

export async function mergeClips(clips, { onProgress = () => {}, onSlowPath = () => {} } = {}) {
  if (clips.length === 1) {
    onProgress(1);
    return { blob: clips[0].blob, duration: clips[0].duration };
  }
  try {
    return await remux(clips, onProgress);
  } catch (err) {
    console.warn('Fast merge failed, re-recording instead:', err);
    onSlowPath();
    onProgress(0);
    return await rerecord(clips, onProgress);
  }
}

// ---------- Fast path ----------
function bytes(desc) {
  if (!desc) return null;
  if (desc instanceof ArrayBuffer) return new Uint8Array(desc);
  return new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
}
function sameConfig(a, b) {
  if (!a || !b) return a === b;
  if (a.codec !== b.codec) return false;
  if ((a.codedWidth ?? 0) !== (b.codedWidth ?? 0) || (a.codedHeight ?? 0) !== (b.codedHeight ?? 0)) return false;
  if ((a.sampleRate ?? 0) !== (b.sampleRate ?? 0) || (a.numberOfChannels ?? 0) !== (b.numberOfChannels ?? 0)) return false;
  const x = bytes(a.description), y = bytes(b.description);
  if (!x || !y) return x === y;
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

async function remux(clips, onProgress) {
  const mb = await import('./vendor/mediabunny.min.mjs');
  const inputs = clips.map((c) => new mb.Input({ source: new mb.BlobSource(c.blob), formats: mb.ALL_FORMATS }));
  try {
    const parts = [];
    for (const input of inputs) {
      const video = await input.getPrimaryVideoTrack();
      if (!video) throw new Error('A clip has no video track');
      const audio = await input.getPrimaryAudioTrack();
      parts.push({
        video, audio,
        vcfg: await video.getDecoderConfig(),
        acfg: audio ? await audio.getDecoderConfig() : null,
      });
    }
    const first = parts[0];
    const hasAudio = parts.every((p) => p.audio);
    for (const p of parts.slice(1)) {
      if (p.video.codec !== first.video.codec || p.video.rotation !== first.video.rotation || !sameConfig(p.vcfg, first.vcfg)) {
        throw new Error('Clips were recorded in different video formats');
      }
      if (hasAudio && (p.audio.codec !== first.audio.codec || !sameConfig(p.acfg, first.acfg))) {
        throw new Error('Clips were recorded in different audio formats');
      }
    }

    const candidates = [new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), new mb.WebMOutputFormat()];
    const format = candidates.find((f) => {
      const supported = f.getSupportedCodecs();
      return supported.includes(first.video.codec) && (!hasAudio || supported.includes(first.audio.codec));
    });
    if (!format) throw new Error(`No container for ${first.video.codec}`);
    const mime = format instanceof mb.Mp4OutputFormat ? 'video/mp4' : 'video/webm';

    const output = new mb.Output({ format, target: new mb.BufferTarget() });
    const vsrc = new mb.EncodedVideoPacketSource(first.video.codec);
    output.addVideoTrack(vsrc, { rotation: first.video.rotation });
    const asrc = hasAudio ? new mb.EncodedAudioPacketSource(first.audio.codec) : null;
    if (asrc) output.addAudioTrack(asrc);
    await output.start();

    const total = clips.reduce((s, c) => s + (c.duration || 0), 0) || 1;
    let offset = 0, vSeq = 0, aSeq = 0, vMeta = false, aMeta = false;

    for (const p of parts) {
      const vStart = await p.video.getFirstTimestamp();
      const aStart = hasAudio ? await p.audio.getFirstTimestamp() : Infinity;
      const base = Math.min(vStart, aStart);
      let end = 0;

      const vIt = new mb.EncodedPacketSink(p.video).packets();
      const aIt = hasAudio ? new mb.EncodedPacketSink(p.audio).packets() : null;
      let vNext = await vIt.next();
      let aNext = aIt ? await aIt.next() : { done: true };

      // Interleave video and audio by time so the file plays smoothly from the start.
      while (!vNext.done || !aNext.done) {
        const takeVideo = aNext.done || (!vNext.done && vNext.value.timestamp <= aNext.value.timestamp);
        const pkt = takeVideo ? vNext.value : aNext.value;
        const rel = pkt.timestamp - base;
        end = Math.max(end, rel + pkt.duration);
        if (takeVideo) {
          await vsrc.add(pkt.clone({ timestamp: rel + offset, sequenceNumber: vSeq++ }), vMeta ? undefined : { decoderConfig: first.vcfg });
          vMeta = true;
          vNext = await vIt.next();
        } else {
          await asrc.add(pkt.clone({ timestamp: rel + offset, sequenceNumber: aSeq++ }), aMeta ? undefined : { decoderConfig: first.acfg });
          aMeta = true;
          aNext = await aIt.next();
        }
      }
      offset += end;
      onProgress(Math.min(0.97, offset / total));
    }

    await output.finalize();
    onProgress(1);
    return { blob: new Blob([output.target.buffer], { type: mime }), duration: offset };
  } finally {
    for (const input of inputs) { try { input.dispose?.(); } catch { /* already closed */ } }
  }
}

// ---------- Slow path ----------
function pickMime() {
  const options = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return options.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
}
const once = (el, ev) => new Promise((resolve, reject) => {
  const ok = () => { cleanup(); resolve(); };
  const bad = () => { cleanup(); reject(el.error || new Error(`Video failed while waiting for ${ev}`)); };
  const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  el.addEventListener(ev, ok);
  el.addEventListener('error', bad);
});

async function rerecord(clips, onProgress) {
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  // iOS only decodes frames for videos that are in the page.
  Object.assign(v.style, { position: 'fixed', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none', left: '0', top: '0' });
  document.body.append(v);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  await ctx.resume().catch(() => {});
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaElementSource(v).connect(dest); // routed into the recording only, so nothing plays out loud

  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const urls = [];
  let recorder;
  try {
    // Size the canvas from the first clip, capped at 1080 x 1920.
    const firstUrl = URL.createObjectURL(clips[0].blob);
    urls.push(firstUrl);
    v.src = firstUrl;
    await once(v, 'loadedmetadata');
    const scale = Math.min(1, 1920 / Math.max(v.videoWidth, v.videoHeight));
    canvas.width = Math.round((v.videoWidth || 1080) * scale / 2) * 2;
    canvas.height = Math.round((v.videoHeight || 1920) * scale / 2) * 2;

    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = pickMime();
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { recorder.onstop = r; });

    const total = clips.reduce((s, c) => s + (c.duration || 0), 0) || 1;
    let done = 0;
    for (let i = 0; i < clips.length; i++) {
      if (i > 0) {
        const url = URL.createObjectURL(clips[i].blob);
        urls.push(url);
        v.src = url;
        await once(v, 'loadedmetadata');
      }
      const draw = () => {
        const s = Math.max(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
        const w = v.videoWidth * s, h = v.videoHeight * s;
        g.drawImage(v, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        onProgress(Math.min(0.99, (done + (v.currentTime || 0)) / total));
      };
      const ended = once(v, 'ended');
      await v.play();
      draw();
      if (recorder.state === 'inactive') recorder.start(1000);
      else if (recorder.state === 'paused') recorder.resume();
      let running = true;
      const loop = () => {
        if (!running) return;
        draw();
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop);
        else requestAnimationFrame(loop);
      };
      loop();
      await ended;
      running = false;
      if (i < clips.length - 1) recorder.pause();
      done += clips[i].duration || v.duration || 0;
    }
    recorder.stop();
    await stopped;
    onProgress(1);
    return { blob: new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/mp4' }), duration: done };
  } finally {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    v.pause();
    v.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
    ctx.close().catch(() => {});
  }
}
