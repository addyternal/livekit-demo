const { Room, RoomEvent, Track } = LivekitClient;

const IDS = [
  'join', 'joinForm', 'joinBtn', 'error', 'name', 'room', 'diceBtn',
  'pvVideo', 'pvOff', 'pvMsg', 'pvMic', 'pvCam', 'pvLevel', 'pvCamSel', 'pvMicSel',
  'roomView', 'roomName', 'recPill', 'recText', 'inviteBtn', 'layoutBtn', 'fsBtn', 'count',
  'grid', 'waiting', 'waitInvite', 'banner', 'toasts',
  'side', 'tabChat', 'tabPeople', 'peopleCount', 'closeSide',
  'chatView', 'messages', 'chatForm', 'chatInput', 'emojiBtn', 'emojiPanel', 'peopleView', 'people',
  'micBtn', 'camBtn', 'shareBtn', 'recBtn', 'handBtn', 'reactBtn', 'chatBtn', 'peopleBtn',
  'settingsBtn', 'moreBtn', 'leaveBtn', 'unread', 'reactPop', 'morePop',
  'settings', 'setMic', 'setCam', 'setSpk', 'setSpkWrap', 'optNs', 'optEc', 'optAgc',
  'openShortcuts', 'shortcuts', 'audioSink',
  'recList', 'roomHint', 'roomClear', 'resume', 'resumeRoom', 'resumeCancel', 'setName',
];
const el = Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)]));

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

let room = null;
let ready = false;          // false while connecting, so existing participants don't toast "joined"
let sideTab = null;         // 'chat' | 'people' | null
let unread = 0;
let lastDay = null;
let handUp = false;
let layoutMode = 'grid';    // 'grid' | 'speaker'
let pinnedKey = null;
let activeKey = null;       // active speaker's tile key
let pipPos = null;          // dragged picture-in-picture position
const tiles = new Map();    // key -> tile

/* ---------- Theme ---------- */
const mq = matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () => document.documentElement.dataset.theme || (mq.matches ? 'dark' : 'light');
function paintTheme() {
  const dark = effectiveTheme() === 'dark';
  document.querySelectorAll('.js-theme i').forEach((i) => { i.className = `fa-solid ${dark ? 'fa-sun' : 'fa-moon'}`; });
}
document.querySelectorAll('.js-theme').forEach((b) => b.addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('huddle:theme', next);
  paintTheme();
}));
mq.addEventListener?.('change', paintTheme);
paintTheme();

/* ---------- Helpers ---------- */
const AVATAR_COLORS = ['#c2410c', '#b45309', '#15803d', '#0e7490', '#1d4ed8', '#6d28d9', '#be185d', '#475569'];
function avatarColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
const baseId = (identity) => identity; // identities are already unique per join

function toast({ title, text, icon = 'fa-circle-info', onClick, ms = 4000 }) {
  const t = document.createElement(onClick ? 'button' : 'div');
  t.className = 'toast';
  const i = document.createElement('i'); i.className = `fa-solid ${icon}`;
  const box = document.createElement('div');
  const b = document.createElement('b'); b.textContent = title;
  box.append(b);
  if (text) { const s = document.createElement('span'); s.textContent = text; box.append(s); }
  t.append(i, box);
  if (onClick) t.addEventListener('click', () => { onClick(); t.remove(); });
  el.toasts.appendChild(t);
  while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
  setTimeout(() => t.remove(), ms);
}

/* ---------- Audio/video preferences ---------- */
const prefs = { ns: store.get('huddle:ns', true), ec: store.get('huddle:ec', true), agc: store.get('huddle:agc', true) };
const audioOpts = () => ({ noiseSuppression: prefs.ns, echoCancellation: prefs.ec, autoGainControl: prefs.agc });

/* Turn a getUserMedia error into something a person can act on */
function cameraProblem(name) {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera blocked. Click the lock icon in the address bar and allow camera access.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Camera is busy. Close other apps or browsers using it, then reload.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found.';
    default:
      return 'Camera unavailable.';
  }
}

/* Turn the camera on/off, retrying once if the device is still being released */
async function setCamera(on) {
  const lp = room.localParticipant;
  try {
    await lp.setCameraEnabled(on);
  } catch (err) {
    if (on && (err.name === 'NotReadableError' || err.name === 'AbortError')) {
      await new Promise((r) => setTimeout(r, 700));
      try { await lp.setCameraEnabled(true); return; } catch (e2) { err = e2; }
    }
    toast({ title: 'Camera did not start', text: cameraProblem(err.name), icon: 'fa-triangle-exclamation', ms: 8000 });
  }
}

/* ---------- Pre-join: prefill, random room, preview ---------- */
const ADJ = ['calm', 'bright', 'quick', 'brave', 'cosy', 'swift', 'lucky', 'gentle', 'sunny', 'clever'];
const NOUN = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'willow', 'tiger', 'orbit', 'river', 'lantern'];
el.diceBtn.addEventListener('click', () => {
  el.room.value = `${pick(ADJ)}-${pick(NOUN)}-${10 + Math.floor(Math.random() * 90)}`;
});

/* What we remember:
   - name: forever (editable any time; updated whenever it changes)
   - last room: 2 hours since last use
   - an in-progress call: per tab, so a refresh drops you straight back in */
const TWO_HOURS = 2 * 60 * 60 * 1000;
const lastRoom = () => {
  const r = store.get('huddle:room', null);
  return r && Date.now() - r.ts < TWO_HOURS ? r.v : '';
};
const rememberRoom = (v) => store.set('huddle:room', { v, ts: Date.now() });
const session = {
  read() {
    try {
      const s = JSON.parse(sessionStorage.getItem('huddle:session'));
      return s && Date.now() - s.ts < TWO_HOURS ? s : null;
    } catch { return null; }
  },
  write(s) { try { sessionStorage.setItem('huddle:session', JSON.stringify({ ...s, ts: Date.now() })); } catch {} },
  clear() { try { sessionStorage.removeItem('huddle:session'); } catch {} },
};

const urlRoom = new URLSearchParams(location.search).get('room');
const saved = session.read();
const resume = saved && (!urlRoom || urlRoom === saved.room) ? saved : null;

el.name.value = store.get('huddle:name', '');
el.room.value = urlRoom || resume?.room || lastRoom();
el.name.addEventListener('change', () => { const v = el.name.value.trim(); if (v) store.set('huddle:name', v); });

function paintHint() { el.roomHint.hidden = !(el.room.value && el.room.value === lastRoom() && !urlRoom); }
el.room.addEventListener('input', paintHint);
el.roomClear.addEventListener('click', () => {
  store.set('huddle:room', null);
  el.room.value = '';
  paintHint();
  el.room.focus();
});
paintHint();

/* Put the cursor where the next action is, so Enter completes the join */
function focusJoinForm() {
  if (!el.name.value) el.name.focus();
  else if (!el.room.value) el.room.focus();
  else el.joinBtn.focus({ preventScroll: true });
}

const pv = { stream: null, micOn: true, camOn: true, hasAudio: false, hasVideo: false, ctx: null, raf: 0, seq: 0 };

function stopPreview() {
  pv.seq++;
  cancelAnimationFrame(pv.raf);
  pv.stream?.getTracks().forEach((t) => t.stop());
  pv.ctx?.close().catch(() => {});
  pv.stream = null; pv.ctx = null;
  el.pvVideo.srcObject = null;
  el.pvLevel.style.width = '0';
}

async function startPreview() {
  stopPreview();
  const my = pv.seq;
  const camId = el.pvCamSel.value, micId = el.pvMicSel.value;
  const audio = { ...audioOpts(), ...(micId ? { deviceId: { exact: micId } } : {}) };
  const video = camId ? { deviceId: { exact: camId } } : true;
  const attempts = [{ video, audio }, { video: true, audio: true }, { video: true }, { audio: true }];

  let stream = null;
  pv.err = null;
  for (const c of attempts) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (err) {
      if (c.video && !pv.err) pv.err = err.name; // remember why the camera failed
    }
  }
  if (my !== pv.seq) { stream?.getTracks().forEach((t) => t.stop()); return; }

  pv.stream = stream;
  pv.hasVideo = !!stream?.getVideoTracks().length;
  pv.hasAudio = !!stream?.getAudioTracks().length;
  el.pvVideo.srcObject = stream;
  paintPreview();
  await fillPreviewDevices(stream);
  if (stream && pv.hasAudio) startMeter(stream, my);
}

function paintPreview() {
  const vt = pv.stream?.getVideoTracks()[0], at = pv.stream?.getAudioTracks()[0];
  if (vt) vt.enabled = pv.camOn;
  if (at) at.enabled = pv.micOn;
  const showVideo = pv.hasVideo && pv.camOn;
  el.pvVideo.hidden = !showVideo;
  el.pvOff.hidden = showVideo;
  el.pvMsg.textContent = pv.hasVideo ? 'Camera is off' : cameraProblem(pv.err);
  el.pvMic.classList.toggle('off', !pv.micOn || !pv.hasAudio);
  el.pvCam.classList.toggle('off', !pv.camOn || !pv.hasVideo);
  el.pvMic.querySelector('i').className = `fa-solid ${pv.micOn && pv.hasAudio ? 'fa-microphone' : 'fa-microphone-slash'}`;
  el.pvCam.querySelector('i').className = `fa-solid ${pv.camOn && pv.hasVideo ? 'fa-video' : 'fa-video-slash'}`;
}

el.pvMic.addEventListener('click', () => { pv.micOn = !pv.micOn; paintPreview(); });
el.pvCam.addEventListener('click', () => { pv.camOn = !pv.camOn; paintPreview(); });
el.pvCamSel.addEventListener('change', startPreview);
el.pvMicSel.addEventListener('change', startPreview);

async function fillPreviewDevices(stream) {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const fill = (sel, kind, track) => {
    const list = devs.filter((d) => d.kind === kind);
    sel.innerHTML = '';
    list.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`;
      sel.appendChild(o);
    });
    const active = track?.getSettings().deviceId;
    if (active) sel.value = active;
    sel.disabled = !list.length;
  };
  fill(el.pvCamSel, 'videoinput', stream?.getVideoTracks()[0]);
  fill(el.pvMicSel, 'audioinput', stream?.getAudioTracks()[0]);
}

function startMeter(stream, my) {
  try {
    const ctx = new AudioContext();
    pv.ctx = ctx;
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const tick = () => {
      if (my !== pv.seq) return;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      const level = pv.micOn ? clamp(Math.sqrt(sum / buf.length) * 4, 0, 1) : 0;
      el.pvLevel.style.width = `${Math.round(level * 100)}%`;
      pv.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch { /* meter is optional */ }
}

/* ---------- Join / leave ---------- */
let resumeAborted = false;

async function joinRoom({ name, roomName, sel }) {
  el.error.hidden = true;
  el.joinBtn.disabled = true;
  stopPreview(); // release the devices before LiveKit grabs them

  try {
    const res = await fetch(`/api/token?room=${encodeURIComponent(roomName)}&name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error((await res.json()).error || 'Could not get a token');
    const { token, url } = await res.json();

    ready = false;
    room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { ...audioOpts(), deviceId: sel.micId || undefined },
      videoCaptureDefaults: { deviceId: sel.camId || undefined },
    });
    bindRoomEvents(room);
    await room.connect(url, token);
    if (resumeAborted) { resumeAborted = false; room.disconnect(); return; }
    ready = true;

    // Remember who/where, so a refresh or a return visit is one click (or none)
    store.set('huddle:name', name);
    rememberRoom(roomName);
    session.write({ room: roomName, name, ...sel });
    history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(roomName)}`);

    el.roomName.textContent = roomName;
    el.resume.hidden = true;
    el.join.hidden = true;
    el.roomView.hidden = false;
    paintLayoutBtn();
    el.fsBtn.hidden = !document.fullscreenEnabled;
    el.shareBtn.hidden = !navigator.mediaDevices?.getDisplayMedia;

    renderParticipant(room.localParticipant);
    room.remoteParticipants.forEach(renderParticipant);
    updateCount();
    updateWaiting();
    schedulePeople();

    // Permission may have been denied; the call still works as a viewer.
    if (sel.mic) await room.localParticipant.setMicrophoneEnabled(true).catch(() => {});
    if (sel.cam) await setCamera(true);
    syncControls();
    startRecordingPoll();
  } catch (err) {
    el.error.textContent = err.message || 'Failed to join';
    el.error.hidden = false;
    room?.disconnect();
    room = null;
    ready = false;
    showJoinScreen();
  } finally {
    el.joinBtn.disabled = false;
  }
}

function showJoinScreen() {
  el.resume.hidden = true;
  el.join.hidden = false;
  startPreview();
  focusJoinForm();
}

el.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();

  // Ask for notification permission while we still have the user's click
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  joinRoom({
    name: el.name.value.trim(),
    roomName: el.room.value.trim(),
    sel: {
      micId: el.pvMicSel.value, camId: el.pvCamSel.value,
      mic: pv.micOn && pv.hasAudio, cam: pv.camOn && pv.hasVideo,
    },
  });
});

/* Refreshed mid-call? Skip the form and go straight back in, with mic/camera as you left them. */
if (resume && resume.name) {
  el.join.hidden = true;
  el.resume.hidden = false;
  el.resumeRoom.textContent = resume.room;
  el.resumeCancel.addEventListener('click', () => {
    resumeAborted = true;
    showJoinScreen();
  });
  joinRoom({
    name: resume.name,
    roomName: resume.room,
    sel: { micId: resume.micId, camId: resume.camId, mic: resume.mic, cam: resume.cam },
  });
} else {
  startPreview();
  focusJoinForm();
}

function resetUI() {
  if (!room && el.roomView.hidden) return;
  resetRecording();
  tiles.forEach((t) => t.root.remove());
  tiles.clear();
  el.audioSink.innerHTML = '';
  el.messages.innerHTML = '';
  el.toasts.innerHTML = '';
  lastDay = null;
  pinnedKey = null; activeKey = null; pipPos = null; layoutMode = 'grid';
  handUp = false;
  el.handBtn.classList.remove('active');
  closePops();
  closeSide();
  unread = 0;
  el.unread.hidden = true;
  el.banner.hidden = true;
  el.recPill.hidden = true;
  el.roomView.hidden = true;
  el.join.hidden = false;
  room = null;
  ready = false;
  session.clear();
  history.replaceState(null, '', location.pathname);
  paintHint();
  showJoinScreen();
}

el.leaveBtn.addEventListener('click', () => room?.disconnect());

/* ---------- Room events ---------- */
function bindRoomEvents(r) {
  const refresh = (p) => { if (p) renderParticipant(p); };

  r.on(RoomEvent.ParticipantConnected, (p) => {
    renderParticipant(p); updateCount(); updateWaiting();
    if (ready) toast({ title: `${p.name || 'Someone'} joined`, icon: 'fa-user-plus' });
  })
  .on(RoomEvent.ParticipantDisconnected, (p) => {
    removeTiles(p.identity); updateCount(); updateWaiting(); schedulePeople();
    if (ready) toast({ title: `${p.name || 'Someone'} left`, icon: 'fa-user-minus' });
  })
  .on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
    if (track.kind === Track.Kind.Audio) el.audioSink.appendChild(track.attach());
    refresh(p);
  })
  .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => {
    if (track.kind === Track.Kind.Audio) track.detach().forEach((n) => n.remove());
    refresh(p);
  })
  .on(RoomEvent.TrackMuted, (_pub, p) => refresh(p))
  .on(RoomEvent.TrackUnmuted, (_pub, p) => refresh(p))
  .on(RoomEvent.LocalTrackPublished, () => { refresh(r.localParticipant); syncControls(); })
  .on(RoomEvent.LocalTrackUnpublished, () => { refresh(r.localParticipant); syncControls(); })
  .on(RoomEvent.ConnectionQualityChanged, (_q, p) => refresh(p))
  .on(RoomEvent.ParticipantNameChanged, (_n, p) => refresh(p))
  .on(RoomEvent.RecordingStatusChanged, () => refreshRecording())
  .on(RoomEvent.ParticipantAttributesChanged, (changed, p) => {
    refresh(p);
    if (!p.isLocal && ready) {
      if (changed.hand === '1') toast({ title: `${p.name} raised their hand`, icon: 'fa-hand' });
    }
  })
  .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const ids = new Set(speakers.map((s) => s.identity));
    tiles.forEach((t) => t.root.classList.toggle('speaking', !t.isScreen && ids.has(t.identity)));
    const top = speakers.find((s) => !s.isLocal) || speakers[0];
    if (top) queueActiveSpeaker(`${top.identity}|cam`);
  })
  .on(RoomEvent.Reconnecting, () => { el.banner.hidden = false; })
  .on(RoomEvent.Reconnected, () => { el.banner.hidden = true; })
  .on(RoomEvent.Disconnected, resetUI)
  .on(RoomEvent.DataReceived, (payload, p, _kind, topic) => {
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
    if (topic === 'chat' && msg.text) {
      const who = p?.name || 'Guest';
      addMessage(who, msg.text, false, msg.ts);
      notifyMessage(who, msg.text);
    } else if (topic === 'reaction' && msg.e && p) {
      floatReaction(`${p.identity}|cam`, msg.e);
    }
  });
}

let speakerTimer = 0;
function queueActiveSpeaker(key) {
  clearTimeout(speakerTimer);
  speakerTimer = setTimeout(() => {
    if (key === activeKey || !tiles.has(key)) return;
    activeKey = key;
    layout();
  }, 900); // hysteresis so the big tile doesn't flicker between speakers
}

/* ---------- Tiles ---------- */
function makeTile(key, p, isScreen) {
  const root = document.createElement('div');
  root.className = 'tile no-anim' + (p.isLocal ? ' local' : '') + (isScreen ? ' screen' : '');
  root.innerHTML = `
    <div class="avatar"><b></b></div>
    <video autoplay playsinline ${p.isLocal ? 'muted' : ''}></video>
    <div class="hand" hidden title="Hand raised"><i class="fa-solid fa-hand"></i></div>
    <div class="tile-actions"><button type="button" class="pin" aria-label="Pin" title="Pin"><i class="fa-solid fa-thumbtack"></i></button></div>
    <div class="label"><i class="fa-solid fa-microphone-slash" hidden></i><span></span><i class="q fa-solid fa-signal"></i></div>`;
  const avatar = root.querySelector('.avatar b');
  avatar.textContent = (p.name || '?').trim().charAt(0).toUpperCase();
  avatar.style.background = avatarColor(p.identity);

  const t = {
    key, identity: p.identity, isLocal: p.isLocal, isScreen, root,
    video: root.querySelector('video'),
    mic: root.querySelector('.fa-microphone-slash'),
    name: root.querySelector('.label span'),
    avatar,
    q: root.querySelector('.q'),
    hand: root.querySelector('.hand'),
  };
  root.querySelector('.pin').addEventListener('click', (ev) => { ev.stopPropagation(); togglePin(key); });
  root.addEventListener('dblclick', () => { if (!root.classList.contains('pip')) togglePin(key); });
  if (p.isLocal && !isScreen) bindPipDrag(t);

  tiles.set(key, t);
  el.grid.appendChild(root);
  layout();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('no-anim')));
  return t;
}

function setTrack(t, pub) {
  const track = pub?.track;
  const live = !!track && !pub.isMuted;
  if (live) track.attach(t.video);
  else if (track) track.detach(t.video);
  t.root.classList.toggle('has-video', live);
}

function renderParticipant(p) {
  const cam = tiles.get(`${p.identity}|cam`) || makeTile(`${p.identity}|cam`, p, false);
  setTrack(cam, p.getTrackPublication(Track.Source.Camera));
  cam.name.textContent = (p.name || 'Guest') + (p.isLocal ? ' (you)' : '');
  cam.avatar.textContent = (p.name || '?').trim().charAt(0).toUpperCase();
  cam.mic.hidden = p.isMicrophoneEnabled;
  cam.hand.hidden = p.attributes?.hand !== '1';
  cam.q.className = `q fa-solid fa-signal q-${p.connectionQuality || 'unknown'}`;

  const scrKey = `${p.identity}|screen`;
  const scrPub = p.getTrackPublication(Track.Source.ScreenShare);
  if (scrPub?.track) {
    const s = tiles.get(scrKey) || makeTile(scrKey, p, true);
    setTrack(s, scrPub);
    s.name.textContent = `${p.name || 'Guest'}'s screen`;
    s.mic.hidden = true;
    s.hand.hidden = true;
  } else if (tiles.has(scrKey)) {
    removeTile(scrKey);
  }
  schedulePeople();
}

function removeTile(key) {
  tiles.get(key)?.root.remove();
  tiles.delete(key);
  if (pinnedKey === key) pinnedKey = null;
  if (activeKey === key) activeKey = null;
  layout();
}
function removeTiles(identity) {
  [...tiles.keys()].filter((k) => k.startsWith(`${identity}|`)).forEach(removeTile);
}

function updateCount() { el.count.textContent = room ? room.remoteParticipants.size + 1 : 1; }
function updateWaiting() { el.waiting.hidden = !room || room.remoteParticipants.size > 0; }

/* ---------- Pin ---------- */
function togglePin(key) {
  pinnedKey = pinnedKey === key ? null : key;
  tiles.forEach((t) => {
    const pinned = t.key === pinnedKey;
    t.root.classList.toggle('is-pinned', pinned);
    const pin = t.root.querySelector('.pin');
    pin.title = pinned ? 'Unpin' : 'Pin';
    pin.setAttribute('aria-label', pin.title);
  });
  layout();
}

/* ---------- Layout engine ----------
   Every tile is absolutely positioned, so the same elements animate between
   grid, speaker and picture-in-picture without being re-parented (which would pause video). */
function place(t, x, y, w, h, z = 1) {
  const s = t.root.style;
  s.width = `${Math.max(0, Math.round(w))}px`;
  s.height = `${Math.max(0, Math.round(h))}px`;
  s.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  s.zIndex = z;
}

function focusTile() {
  if (pinnedKey && tiles.has(pinnedKey)) return tiles.get(pinnedKey);
  const screen = [...tiles.values()].find((t) => t.isScreen);
  if (screen) return screen;
  if (layoutMode === 'speaker') {
    return tiles.get(activeKey)
      || [...tiles.values()].find((t) => !t.isLocal && !t.isScreen)
      || tiles.values().next().value;
  }
  return null;
}

function layout() {
  if (!tiles.size) return;
  const cs = getComputedStyle(el.grid);
  const pl = parseFloat(cs.paddingLeft), pt = parseFloat(cs.paddingTop);
  const W = el.grid.clientWidth - pl - parseFloat(cs.paddingRight);
  const H = el.grid.clientHeight - pt - parseFloat(cs.paddingBottom);
  const gap = parseFloat(cs.columnGap) || 10;
  if (W <= 0 || H <= 0) return;

  const all = [...tiles.values()];
  const focus = all.length > 1 ? focusTile() : null;
  const box = { W, H, gap, pl, pt };

  all.forEach((t) => {
    t.root.classList.remove('pip');
    t.root.classList.toggle('is-main', t === focus);
  });

  if (focus) return speakerLayout(all, focus, box);

  // Two people, no focus: remote fills the stage, you float as a draggable picture-in-picture
  const mine = all.length === 2 ? all.find((t) => t.isLocal && !t.isScreen) : null;
  if (mine) {
    const remote = all.find((t) => t !== mine);
    place(remote, pl, pt, W, H, 1);
    const portrait = H > W;
    const pw = portrait ? clamp(W * 0.3, 90, 150) : clamp(W * 0.22, 120, 260);
    const ph = pw / (portrait ? 3 / 4 : 16 / 10);
    const pos = pipPos || { x: pl + W - pw - 12, y: pt + H - ph - 12 };
    mine.root.classList.add('pip');
    place(mine, clamp(pos.x, pl, pl + W - pw), clamp(pos.y, pt, pt + H - ph), pw, ph, 5);
    return;
  }
  gridLayout(all, box);
}

function gridLayout(list, { W, H, gap, pl, pt }) {
  const n = list.length;
  const ar = W >= H ? 16 / 10 : 4 / 3;
  let best = { w: 0, h: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (W - gap * (cols - 1)) / cols;
    let h = w / ar;
    if (h * rows + gap * (rows - 1) > H) { h = (H - gap * (rows - 1)) / rows; w = h * ar; }
    if (w > best.w) best = { w, h, cols };
  }
  const rows = Math.ceil(n / best.cols);
  let y = pt + (H - (rows * best.h + gap * (rows - 1))) / 2;
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(best.cols, n - r * best.cols);
    let x = pl + (W - (inRow * best.w + gap * (inRow - 1))) / 2;
    for (let c = 0; c < inRow; c++) {
      place(list[r * best.cols + c], x, y, best.w, best.h);
      x += best.w + gap;
    }
    y += best.h + gap;
  }
}

function speakerLayout(all, focus, { W, H, gap, pl, pt }) {
  const others = all.filter((t) => t !== focus);
  const k = others.length;
  const ar = 16 / 10;

  if (W >= H && W >= 560) {
    // Strip on the right
    const stripW = clamp(W * 0.2, 140, 220);
    const th = Math.min(stripW / ar, (H - gap * (k - 1)) / k);
    const tw = th * ar;
    const mainW = W - tw - gap;
    place(focus, pl, pt, mainW, H);
    let y = pt + (H - (k * th + gap * (k - 1))) / 2;
    others.forEach((t) => { place(t, pl + mainW + gap, y, tw, th); y += th + gap; });
  } else {
    // Strip along the bottom
    const stripH = clamp(H * 0.16, 80, 120);
    const tw = Math.min(stripH * ar, (W - gap * (k - 1)) / k);
    const th = tw / ar;
    place(focus, pl, pt, W, H - th - gap);
    let x = pl + (W - (k * tw + gap * (k - 1))) / 2;
    others.forEach((t) => { place(t, x, pt + H - th, tw, th); x += tw + gap; });
  }
}

new ResizeObserver(layout).observe(el.grid);

/* Draggable self-view */
function bindPipDrag(t) {
  let drag = null;
  t.root.addEventListener('pointerdown', (e) => {
    if (!t.root.classList.contains('pip')) return;
    const r = t.root.getBoundingClientRect(), g = el.grid.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, gx: g.left, gy: g.top };
    t.root.setPointerCapture(e.pointerId);
    el.grid.classList.add('dragging');
  });
  t.root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    pipPos = { x: e.clientX - drag.gx - drag.dx, y: e.clientY - drag.gy - drag.dy };
    layout();
  });
  const end = () => { drag = null; el.grid.classList.remove('dragging'); };
  t.root.addEventListener('pointerup', end);
  t.root.addEventListener('pointercancel', end);
}

function paintLayoutBtn() {
  const speaker = layoutMode === 'speaker';
  el.layoutBtn.querySelector('i').className = `fa-solid ${speaker ? 'fa-user' : 'fa-table-cells-large'}`;
  const label = speaker ? 'Switch to grid view (L)' : 'Switch to speaker view (L)';
  el.layoutBtn.title = label;
  el.layoutBtn.setAttribute('aria-label', label);
}
el.layoutBtn.addEventListener('click', () => {
  layoutMode = layoutMode === 'grid' ? 'speaker' : 'grid';
  if (pinnedKey) togglePin(pinnedKey); // un-pin so the toggle always does something
  paintLayoutBtn();
  layout();
});

/* ---------- Controls ---------- */
function setCtl(btn, on, iconOn, iconOff, cls) {
  btn.classList.toggle('off', cls === 'off' && !on);
  btn.classList.toggle('active', cls === 'active' && on);
  btn.querySelector('i').className = `fa-solid ${on ? iconOn : iconOff}`;
}

function syncControls() {
  if (!room) return;
  const lp = room.localParticipant;
  setCtl(el.micBtn, lp.isMicrophoneEnabled, 'fa-microphone', 'fa-microphone-slash', 'off');
  setCtl(el.camBtn, lp.isCameraEnabled, 'fa-video', 'fa-video-slash', 'off');
  setCtl(el.shareBtn, lp.isScreenShareEnabled, 'fa-display', 'fa-display', 'active');
  const sess = session.read();
  if (sess) session.write({ ...sess, mic: lp.isMicrophoneEnabled, cam: lp.isCameraEnabled });
}

el.micBtn.addEventListener('click', async () => {
  await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled).catch(() => {});
  renderParticipant(room.localParticipant); syncControls();
});
el.camBtn.addEventListener('click', async () => {
  await setCamera(!room.localParticipant.isCameraEnabled);
  renderParticipant(room.localParticipant); syncControls();
});
el.shareBtn.addEventListener('click', async () => {
  try { await room.localParticipant.setScreenShareEnabled(!room.localParticipant.isScreenShareEnabled); }
  catch { /* user cancelled the picker */ }
  renderParticipant(room.localParticipant); syncControls();
});

/* Raise hand: stored as a participant attribute so late joiners see it too */
el.handBtn.addEventListener('click', async () => {
  handUp = !handUp;
  el.handBtn.classList.toggle('active', handUp);
  el.handBtn.querySelector('i').className = `${handUp ? 'fa-solid' : 'fa-regular'} fa-hand`;
  await room.localParticipant.setAttributes({ hand: handUp ? '1' : '' }).catch(() => {});
  renderParticipant(room.localParticipant);
});

/* Reactions */
const REACTIONS = ['👍', '👏', '❤️', '😂', '😮', '🎉'];
REACTIONS.forEach((emoji) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = emoji;
  b.setAttribute('aria-label', `React ${emoji}`);
  b.addEventListener('click', () => {
    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify({ e: emoji })),
      { reliable: false, topic: 'reaction' },
    ).catch(() => {});
    floatReaction(`${room.localParticipant.identity}|cam`, emoji);
  });
  el.reactPop.appendChild(b);
});

function floatReaction(key, emoji) {
  const t = tiles.get(key);
  if (!t) return;
  const f = document.createElement('span');
  f.className = 'float';
  f.textContent = emoji;
  f.style.setProperty('--x', `${20 + Math.random() * 60}%`);
  t.root.appendChild(f);
  f.addEventListener('animationend', () => f.remove());
}

/* Popovers + "More" menu (phones) */
function closePops() { el.reactPop.hidden = true; el.morePop.hidden = true; }
el.reactBtn.addEventListener('click', () => { const open = el.reactPop.hidden; closePops(); el.reactPop.hidden = !open; });
el.moreBtn.addEventListener('click', () => {
  const open = el.morePop.hidden;
  closePops();
  if (!open) return;
  el.morePop.innerHTML = '';
  const recOn = rec.active;
  [
    ['shareBtn', 'fa-display', room?.localParticipant.isScreenShareEnabled ? 'Stop sharing' : 'Share screen'],
    ['recBtn', recOn ? 'fa-stop' : 'fa-circle-dot', recOn ? 'Stop recording' : 'Record call'],
    ['peopleBtn', 'fa-user-group', 'People'],
    ['settingsBtn', 'fa-gear', 'Settings'],
  ].forEach(([target, icon, label]) => {
    if (el[target].hidden) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    b.querySelector('span').textContent = label;
    b.addEventListener('click', () => { closePops(); el[target].click(); });
    el.morePop.appendChild(b);
  });
  el.morePop.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.popover, #reactBtn, #moreBtn')) closePops();
  if (!el.emojiPanel.hidden && !el.emojiPanel.contains(e.target) && !el.emojiBtn.contains(e.target)) el.emojiPanel.hidden = true;
});

/* Invite link, fullscreen */
async function copyInvite() {
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(el.roomName.textContent)}`;
  try {
    await navigator.clipboard.writeText(link);
    toast({ title: 'Invite link copied', text: link, icon: 'fa-link' });
  } catch {
    window.prompt('Copy this invite link', link);
  }
}
el.inviteBtn.addEventListener('click', copyInvite);
el.waitInvite.addEventListener('click', copyInvite);

el.fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  el.fsBtn.querySelector('i').className = `fa-solid ${document.fullscreenElement ? 'fa-compress' : 'fa-expand'}`;
});

/* ---------- Side panel: chat + people ---------- */
function openSide(tab) {
  sideTab = tab;
  el.side.classList.add('open');
  el.chatView.hidden = tab !== 'chat';
  el.peopleView.hidden = tab !== 'people';
  el.tabChat.setAttribute('aria-selected', tab === 'chat');
  el.tabPeople.setAttribute('aria-selected', tab === 'people');
  el.chatBtn.classList.toggle('active', tab === 'chat');
  el.peopleBtn.classList.toggle('active', tab === 'people');
  if (tab === 'chat') {
    unread = 0;
    el.unread.hidden = true;
    el.toasts.innerHTML = '';
    el.messages.scrollTop = el.messages.scrollHeight;
    if (matchMedia('(hover: hover)').matches) el.chatInput.focus({ preventScroll: true });
  } else {
    renderPeople();
  }
  layout();
}
function closeSide() {
  sideTab = null;
  el.side.classList.remove('open');
  el.chatBtn.classList.remove('active');
  el.peopleBtn.classList.remove('active');
  el.emojiPanel.hidden = true;
  layout();
}
const chatVisible = () => sideTab === 'chat';
el.chatBtn.addEventListener('click', () => (sideTab === 'chat' ? closeSide() : openSide('chat')));
el.peopleBtn.addEventListener('click', () => (sideTab === 'people' ? closeSide() : openSide('people')));
el.tabChat.addEventListener('click', () => openSide('chat'));
el.tabPeople.addEventListener('click', () => openSide('people'));
el.closeSide.addEventListener('click', closeSide);

/* People list */
let peopleQueued = false;
function schedulePeople() {
  if (peopleQueued) return;
  peopleQueued = true;
  requestAnimationFrame(() => { peopleQueued = false; renderPeople(); });
}
function renderPeople() {
  if (!room) return;
  const list = [room.localParticipant, ...room.remoteParticipants.values()];
  el.peopleCount.textContent = list.length;
  if (sideTab !== 'people') return;
  el.people.innerHTML = '';
  list.forEach((p) => {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.className = 'person';
    row.type = 'button';
    row.title = 'Pin this person';
    const av = document.createElement('span');
    av.className = 'mini-avatar';
    av.style.background = avatarColor(p.identity);
    av.textContent = (p.name || '?').trim().charAt(0).toUpperCase();
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = (p.name || 'Guest') + (p.isLocal ? ' (you)' : '');
    const st = document.createElement('span');
    st.className = 'status';
    const icons = [];
    if (p.attributes?.hand === '1') icons.push('<i class="fa-solid fa-hand hand-on" title="Hand raised"></i>');
    icons.push(`<i class="fa-solid ${p.isMicrophoneEnabled ? 'fa-microphone' : 'fa-microphone-slash bad'}"></i>`);
    icons.push(`<i class="fa-solid ${p.isCameraEnabled ? 'fa-video' : 'fa-video-slash bad'}"></i>`);
    st.innerHTML = icons.join('');
    row.append(av, nm, st);
    row.addEventListener('click', () => { togglePin(`${p.identity}|cam`); });
    li.appendChild(row);
    el.people.appendChild(li);
  });
}

/* ---------- Chat (LiveKit data channel, topic "chat") ---------- */
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
function dayLabel(d) {
  const now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((start(d) - start(now)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}
const timeLabel = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function addMessage(who, text, mine, ts) {
  const d = new Date(ts || Date.now());
  if (dayKey(d) !== lastDay) {
    lastDay = dayKey(d);
    const sep = document.createElement('li');
    sep.className = 'day';
    sep.textContent = dayLabel(d);
    el.messages.appendChild(sep);
  }
  const li = document.createElement('li');
  li.className = 'msg' + (mine ? ' me' : '');
  const w = document.createElement('span'); w.className = 'who'; w.textContent = mine ? 'You' : who;
  const body = document.createElement('div'); body.className = 'body';
  const t = document.createElement('span'); t.className = 'text'; t.textContent = text;
  const time = document.createElement('time'); time.dateTime = d.toISOString(); time.textContent = timeLabel(d);
  body.append(t, time);
  li.append(w, body);
  el.messages.appendChild(li);
  el.messages.scrollTop = el.messages.scrollHeight;

  if (!mine && !chatVisible()) {
    el.unread.textContent = ++unread;
    el.unread.hidden = false;
  }
}

/* In-app toast when chat isn't showing; browser notification when the tab is hidden */
function notifyMessage(who, text) {
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`${who} · ${el.roomName.textContent}`, { body: text, tag: 'huddle-chat' });
    n.onclick = () => { window.focus(); openSide('chat'); n.close(); };
  }
  if (!document.hidden && !chatVisible()) {
    toast({ title: who, text, icon: 'fa-comment', onClick: () => openSide('chat') });
  }
}

const EMOJIS = ('😀 😁 😂 🤣 😊 😍 😘 😎 🤔 😅 😉 🙂 😴 😢 😭 😡 🥳 🤯 😱 🙄 😇 🤗 🤝 👍 ' +
  '👎 👏 🙌 🙏 💪 👋 ✌️ 👌 🤞 ❤️ 🧡 💛 💚 💙 💜 💔 🔥 ✨ 🎉 💯 ✅ ❌ ⚡ ' +
  '☕ 🍕 🎂 🚀 💡 📌 📎 👀').split(' ');
EMOJIS.forEach((e) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = e;
  b.setAttribute('aria-label', `Insert ${e}`);
  b.addEventListener('click', () => {
    const i = el.chatInput;
    const s = i.selectionStart ?? i.value.length;
    i.setRangeText(e, s, i.selectionEnd ?? s, 'end');
    i.focus({ preventScroll: true });
  });
  el.emojiPanel.appendChild(b);
});
el.emojiBtn.addEventListener('click', () => { el.emojiPanel.hidden = !el.emojiPanel.hidden; });

el.chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text || !room) return;
  const ts = Date.now();
  await room.localParticipant.publishData(
    new TextEncoder().encode(JSON.stringify({ text, ts })),
    { reliable: true, topic: 'chat' },
  );
  addMessage('You', text, true, ts);
  el.chatInput.value = '';
  el.emojiPanel.hidden = true;
});

/* ---------- Settings: devices + audio processing ---------- */
const hasSinkId = 'setSinkId' in HTMLMediaElement.prototype;

async function fillDevices(sel, kind) {
  let devs = [];
  try { devs = await Room.getLocalDevices(kind, false); } catch {}
  sel.innerHTML = '';
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `${kind} ${i + 1}`;
    sel.appendChild(o);
  });
  const active = room?.getActiveDevice?.(kind);
  if (active) sel.value = active;
  sel.disabled = !devs.length;
}

el.settingsBtn.addEventListener('click', async () => {
  el.setName.value = room?.localParticipant.name || '';
  fillRecordings();
  el.optNs.checked = prefs.ns; el.optEc.checked = prefs.ec; el.optAgc.checked = prefs.agc;
  el.setSpkWrap.hidden = !hasSinkId;
  el.settings.showModal();
  await Promise.all([
    fillDevices(el.setMic, 'audioinput'),
    fillDevices(el.setCam, 'videoinput'),
    hasSinkId ? fillDevices(el.setSpk, 'audiooutput') : null,
  ]);
});
const switchDevice = (kind) => (e) => room?.switchActiveDevice(kind, e.target.value).catch(() => {
  toast({ title: 'Could not switch device', icon: 'fa-triangle-exclamation' });
});
el.setMic.addEventListener('change', switchDevice('audioinput'));
el.setCam.addEventListener('change', switchDevice('videoinput'));
el.setSpk.addEventListener('change', switchDevice('audiooutput'));

async function applyAudioPrefs() {
  store.set('huddle:ns', prefs.ns); store.set('huddle:ec', prefs.ec); store.set('huddle:agc', prefs.agc);
  // Re-open the live mic track with the new processing constraints
  const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
  await track?.restartTrack(audioOpts()).catch(() => {});
}
[['optNs', 'ns'], ['optEc', 'ec'], ['optAgc', 'agc']].forEach(([id, key]) => {
  el[id].addEventListener('change', () => { prefs[key] = el[id].checked; applyAudioPrefs(); });
});

el.setName.addEventListener('change', async () => {
  const v = el.setName.value.trim();
  if (!v || !room) return;
  store.set('huddle:name', v);           // remembered for next time
  el.name.value = v;
  const sess = session.read();
  if (sess) session.write({ ...sess, name: v });
  await room.localParticipant.setName(v).catch(() => {});
  renderParticipant(room.localParticipant);
  toast({ title: 'Name updated', text: v, icon: 'fa-pen' });
});

el.openShortcuts.addEventListener('click', () => { el.settings.close(); el.shortcuts.showModal(); });

/* ---------- Recording (server-side, LiveKit Egress) ----------
   The server composites the whole room into one MP4, so nobody shares a screen and it keeps going if the
   person who started it leaves. The UI follows the server's own status (polled), not LiveKit's room flag,
   which can lag by many seconds after a stop. */
const rec = { active: false, status: null, startedAt: 0, stopping: false };
let recTimer = 0;   // 1s clock for the REC pill
let recPoll = 0;    // status poll
let recBusy = false;

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const currentRoom = () => el.roomName.textContent;

function drawPill() {
  if (!rec.active) return;
  if (rec.stopping || rec.status === 'EGRESS_ENDING') { el.recText.textContent = 'Saving…'; return; }
  if (rec.status === 'EGRESS_STARTING') { el.recText.textContent = 'Starting…'; return; }
  const s = Math.max(0, Math.floor((Date.now() - rec.startedAt) / 1000));
  el.recText.textContent = `REC ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function paintRecording() {
  const busy = rec.stopping || rec.status === 'EGRESS_ENDING';
  el.recBtn.classList.toggle('off', rec.active);
  el.recBtn.querySelector('i').className = `fa-solid ${busy ? 'fa-spinner fa-spin' : rec.active ? 'fa-stop' : 'fa-circle-dot'}`;
  el.recBtn.title = busy ? 'Saving recording…' : rec.active ? 'Stop recording' : 'Record this call';
  el.recBtn.disabled = recBusy || busy;
  el.recPill.hidden = !rec.active;
  clearInterval(recTimer);
  drawPill();
  if (rec.active) recTimer = setInterval(drawPill, 1000);
}

/* Ask the server what's happening and update the UI; announces start/stop to everyone */
async function refreshRecording() {
  if (!room) return;
  const roomName = currentRoom();
  let s;
  try { s = await api(`/api/record/status?room=${encodeURIComponent(roomName)}`); } catch { return; }
  const was = rec.active;
  rec.active = !!s.active;
  rec.status = s.active ? s.status : null;
  rec.startedAt = s.active ? s.startedAt : 0;
  if (!rec.active) rec.stopping = false;
  paintRecording();
  if (!was && rec.active) toast({ title: 'This call is being recorded', icon: 'fa-circle-dot', ms: 6000 });
  if (was && !rec.active) offerRecording(roomName);
}

function startRecordingPoll() {
  clearInterval(recPoll);
  recPoll = setInterval(refreshRecording, 3000);
  refreshRecording();
}
function resetRecording() {
  clearInterval(recPoll);
  clearInterval(recTimer);
  Object.assign(rec, { active: false, status: null, startedAt: 0, stopping: false });
  recBusy = false;
  el.recPill.hidden = true;
}

el.recBtn.addEventListener('click', async () => {
  if (recBusy || !room) return;
  recBusy = true;
  paintRecording();
  const roomName = currentRoom();
  try {
    await refreshRecording();                 // never act on stale state
    if (rec.active) {
      rec.stopping = true;
      paintRecording();
      await api('/api/record/stop', { room: roomName });
      toast({ title: 'Stopping recording', text: 'Saving the file…', icon: 'fa-stop' });
    } else {
      await api('/api/record/start', { room: roomName });
      Object.assign(rec, { active: true, status: 'EGRESS_STARTING', startedAt: Date.now() });
      toast({ title: 'Starting recording', text: 'This takes a few seconds.', icon: 'fa-circle-dot' });
    }
  } catch (err) {
    rec.stopping = false;
    toast({ title: 'Recording failed', text: err.message, icon: 'fa-triangle-exclamation', ms: 8000 });
  } finally {
    recBusy = false;
    paintRecording();
    setTimeout(refreshRecording, 1500);
  }
});

/* After it stops, the MP4 is finalised a few seconds later: poll, then offer the file */
async function offerRecording(roomName) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let s;
    try { s = await api(`/api/record/status?room=${encodeURIComponent(roomName)}`); } catch { return; }
    if (s.status === 'EGRESS_COMPLETE' && s.file) {
      toast({ title: 'Recording saved', text: 'Click to open it', icon: 'fa-film', ms: 15000, onClick: () => window.open(s.file.url, '_blank') });
      return;
    }
    if (s.status === 'EGRESS_FAILED' || s.status === 'EGRESS_ABORTED') {
      toast({ title: 'Recording failed', text: s.error || 'The file could not be saved.', icon: 'fa-triangle-exclamation', ms: 8000 });
      return;
    }
  }
}

/* Settings → list of saved recordings for this room */
async function fillRecordings() {
  el.recList.innerHTML = '';
  let files = [];
  try { files = await api(`/api/recordings?room=${encodeURIComponent(currentRoom())}`); } catch {}
  if (!files.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No recordings yet';
    el.recList.appendChild(li);
    return;
  }
  files.forEach((f) => {
    const d = new Date(f.at);
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = f.url; a.target = '_blank'; a.rel = 'noopener';
    a.innerHTML = '<i class="fa-solid fa-film"></i><span></span><small></small>';
    a.querySelector('span').textContent = `${dayLabel(d)}, ${timeLabel(d)}`;
    a.querySelector('small').textContent = `${(f.size / 1048576).toFixed(1)} MB`;
    li.appendChild(a);
    el.recList.appendChild(li);
  });
}

/* ---------- Keyboard shortcuts ---------- */
document.addEventListener('keydown', (e) => {
  if (!room || e.metaKey || e.ctrlKey || e.altKey) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
  if (document.querySelector('dialog[open]')) return;
  const actions = {
    m: () => el.micBtn.click(),
    v: () => el.camBtn.click(),
    h: () => el.handBtn.click(),
    c: () => el.chatBtn.click(),
    p: () => el.peopleBtn.click(),
    l: () => el.layoutBtn.click(),
    f: () => { if (!el.fsBtn.hidden) el.fsBtn.click(); },
    '?': () => el.shortcuts.showModal(),
    escape: closePops,
  };
  const act = actions[e.key.toLowerCase()];
  if (act) { e.preventDefault(); act(); }
});

/* Refresh the 2-hour window whenever the page goes away mid-call (reload, close, navigate) */
addEventListener('pagehide', () => {
  if (!room) return;
  rememberRoom(el.roomName.textContent);
  const sess = session.read();
  if (sess) session.write(sess);
});

/* ---------- Stale-tab guard ----------
   If the app files change while this page is open, reload (idle) or offer to reload (in a call;
   a reload rejoins automatically). Prevents old tabs from running old logic after an update. */
let appVersion = null;
let updateToastShown = false;
async function checkVersion() {
  try {
    const { v } = await (await fetch('/api/version', { cache: 'no-store' })).json();
    if (appVersion === null) { appVersion = v; return; }
    if (v === appVersion) return;
    if (!room) { location.reload(); return; }
    if (!updateToastShown) {
      updateToastShown = true;
      toast({ title: 'Update available', text: 'Click to reload. You will rejoin automatically.', icon: 'fa-rotate', ms: 600000, onClick: () => location.reload() });
    }
  } catch { /* offline or restarting */ }
}
checkVersion();
setInterval(checkVersion, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
