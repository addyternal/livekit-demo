import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  AccessToken, EgressClient, EncodedFileOutput, EncodedFileType, EgressStatus,
} from 'livekit-server-sdk';

// LIVEKIT_URL is what browsers connect to (ws:// locally, wss:// behind HTTPS).
// LIVEKIT_API_URL is how this server reaches LiveKit for recording; it defaults to the same host over http(s).
const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, PORT = 8100 } = process.env;
const LIVEKIT_API_URL = process.env.LIVEKIT_API_URL || (LIVEKIT_URL || '').replace(/^ws/, 'http');

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env');
  process.exit(1);
}

// Egress writes MP4s into this folder (mounted into the egress container as /out)
const RECORDINGS_DIR = path.resolve('recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const egress = new EgressClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const lastEgress = new Map(); // room -> egressId of the most recent recording

const app = express();
app.use(express.json());
// Always revalidate so a normal reload picks up new code
app.use(express.static('public', { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// Lets open pages notice that the files changed (see checkVersion in app.js)
const PUBLIC_DIR = path.resolve('public');
app.get('/api/version', (_req, res) => {
  const v = Math.max(...fs.readdirSync(PUBLIC_DIR).map((f) => fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs));
  res.set('Cache-Control', 'no-store').json({ v: String(Math.floor(v)) });
});
app.use('/recordings', express.static(RECORDINGS_DIR));

const cleanRoom = (v) => String(v || '').trim().slice(0, 64);
const safeName = (room) => room.replace(/[^\w.-]+/g, '_').slice(0, 48);

// The API secret never leaves the server; the browser only receives a short-lived JWT.
app.get('/api/token', async (req, res) => {
  const room = cleanRoom(req.query.room);
  const name = String(req.query.name || '').trim().slice(0, 32);
  if (!room || !name) return res.status(400).json({ error: 'room and name are required' });

  const identity = `${name}-${Math.random().toString(36).slice(2, 7)}`;
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name, ttl: '1h' });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });

  res.json({ token: await at.toJwt(), url: LIVEKIT_URL });
});

/* ---------- Server-side recording (LiveKit Egress) ----------
   Egress joins the room as a hidden recorder, composites everyone into one grid and writes an MP4.
   Nobody has to share their screen, and it keeps going if the person who started it leaves. */
const toMs = (ns) => Number(BigInt(ns || 0) / 1_000_000n);
const activeFor = async (room) => (await egress.listEgress({ roomName: room, active: true }));

function describe(info) {
  const file = info.fileResults?.[0];
  return {
    egressId: info.egressId,
    status: EgressStatus[info.status],
    startedAt: toMs(info.startedAt),
    file: file?.filename ? { name: path.basename(file.filename), url: `/recordings/${encodeURIComponent(path.basename(file.filename))}`, size: Number(file.size || 0) } : null,
    error: info.error || null,
  };
}

function unavailable(res, err) {
  console.error('egress error:', err.message);
  res.status(503).json({ error: 'Recording service is not running. Start Redis and the egress container (see README).' });
}

app.post('/api/record/start', async (req, res) => {
  const room = cleanRoom(req.body?.room);
  if (!room) return res.status(400).json({ error: 'room is required' });
  try {
    const running = await activeFor(room);
    if (running.length) return res.json(describe(running[0]));

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: `/out/${safeName(room)}-${stamp}.mp4`,
    });
    const info = await egress.startRoomCompositeEgress(room, output, { layout: 'grid' });
    lastEgress.set(room, info.egressId);
    res.json(describe(info));
  } catch (err) {
    if (err?.status === 404 || /not found|does not exist/i.test(err?.message || '')) {
      return res.status(404).json({ error: 'Room not found' });
    }
    unavailable(res, err);
  }
});

app.post('/api/record/stop', async (req, res) => {
  const room = cleanRoom(req.body?.room);
  if (!room) return res.status(400).json({ error: 'room is required' });
  try {
    const running = await activeFor(room);
    await Promise.all(running.map((i) => egress.stopEgress(i.egressId)));
    res.json({ stopped: running.length });
  } catch (err) { unavailable(res, err); }
});

// Active recording (for the timer) or, failing that, the most recent one (so the page can offer the file)
app.get('/api/record/status', async (req, res) => {
  const room = cleanRoom(req.query.room);
  try {
    const running = await activeFor(room);
    if (running.length) return res.json({ active: true, ...describe(running[0]) });

    const id = lastEgress.get(room);
    if (!id) return res.json({ active: false });
    const [info] = await egress.listEgress({ egressId: id });
    res.json({ active: false, ...(info ? describe(info) : {}) });
  } catch (err) { unavailable(res, err); }
});

app.get('/api/recordings', (req, res) => {
  const prefix = `${safeName(cleanRoom(req.query.room))}-`;
  const files = fs.readdirSync(RECORDINGS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.mp4'))
    .map((f) => { const s = fs.statSync(path.join(RECORDINGS_DIR, f)); return { name: f, size: s.size, at: s.mtimeMs, url: `/recordings/${encodeURIComponent(f)}` }; })
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
  res.json(files);
});

app.listen(PORT, () => console.log(`Demo running at http://localhost:${PORT}`));
