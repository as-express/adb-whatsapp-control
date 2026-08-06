import express from 'express';
import { sendMessage, preflight, normalizePhone, WhatsAppError } from './lib/whatsapp.js';
import { SerialQueue } from './lib/queue.js';
import { setIme, ADB_IME } from './lib/adb.js';
import { provision, restoreNativeIme } from './lib/provision.js';

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN || '';

app.use(express.json({ limit: '256kb' }));

const queue = new SerialQueue();

app.use((req, res, next) => {
  if (!TOKEN || req.path === '/health') return next();
  const auth = req.get('authorization') || '';
  if (auth !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ ok: false, error: 'invalid token', code: 'UNAUTHORIZED' });
  }
  next();
});

app.get('/health', async (_req, res) => {
  try {
    const info = await preflight();
    res.json({ ok: true, ...info, queue: queue.stats });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false, error: err.message, code: err.code || 'UNKNOWN', queue: queue.stats,
    });
  }
});


app.post('/send', async (req, res) => {
  const { phone, message, send = false, app: waApp } = req.body ?? {};

  try {
    normalizePhone(phone);
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, error: err.message, code: err.code });
  }

  try {
    const result = await queue.add(() =>
      sendMessage({ phone, message, send: Boolean(send), app: waApp }));
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof WhatsAppError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, code: err.code || 'UNKNOWN' });
  }
});


app.post('/bulk', async (req, res) => {
  const { items, send = false, app: waApp } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: 'items need be have an value', code: 'BAD_ITEMS' });
  }

  const results = [];
  for (const [i, item] of items.entries()) {
    try {
      const r = await queue.add(() => sendMessage({
        phone: item.phone, message: item.message,
        send: Boolean(send), app: item.app ?? waApp,
      }));
      results.push({ index: i, phone: item.phone, ok: true, ...r });
    } catch (err) {
      results.push({ index: i, phone: item.phone, ok: false, error: err.message, code: err.code || 'UNKNOWN' });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  res.json({ ok: failed === 0, total: results.length, failed, results });
});


app.post('/setup', async (_req, res) => {
  try {
    const result = await queue.add(() => provision({ activate: true }));
    res.status(result.ok ? 200 : 503).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'SETUP_FAILED' });
  }
});

app.post('/ime', async (req, res) => {
  const { mode } = req.body ?? {};
  if (!['adb', 'native'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'mode must be "adb" or "native"', code: 'BAD_MODE' });
  }
  try {
    if (mode === 'adb') {
      await setIme(ADB_IME);
      return res.json({ ok: true, mode, ime: ADB_IME });
    }
    const result = await restoreNativeIme();
    res.status(result.ok ? 200 : 503).json({ ...result, mode });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'IME_FAILED' });
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }));

app.listen(PORT, () => {
  console.log(`WhatsApp ADB API listen port :${PORT}`);
});
