import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const app = express();
const PORT = process.env.PORT || 3000;
const appBase = process.env.PUBLIC_BASE_URL || '';

app.set('trust proxy', 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' }
});
app.use('/api/', limiter);

const jobs = new Map();
const MAX_FILE_AGE_MS = 10 * 60 * 1000;

function isTikTokUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return ['tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'].includes(host) || host.endsWith('.tiktok.com');
  } catch { return false; }
}

function safeFilename(name = 'bluesave-video') {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || 'bluesave-video';
}

function runYtDlp(url, output) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--no-warnings', '--restrict-filenames',
      '-f', 'play_addr_h264/play_addr_bytevc1/play_addr/h264_540p/download_addr/bv*+ba/b',
      '--merge-output-format', 'mp4',
      '-o', output, url
    ];
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(new Error(`No se pudo ejecutar yt-dlp: ${err.message}`)));
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `yt-dlp terminó con código ${code}`));
    });
  });
}

function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > MAX_FILE_AGE_MS) {
      try { fs.rmSync(job.file, { force: true }); } catch {}
      jobs.delete(id);
    }
  }
}
setInterval(cleanup, 60_000).unref();

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'BlueSave API' }));

app.post('/api/download', async (req, res) => {
  const { url } = req.body || {};
  if (typeof url !== 'string' || !isTikTokUrl(url)) {
    return res.status(400).json({ error: 'Pega una URL válida de TikTok.' });
  }

  const id = crypto.randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluesave-'));
  const output = path.join(dir, '%(id)s.%(ext)s');
  jobs.set(id, { status: 'processing', createdAt: Date.now(), dir, file: null });

  try {
    await runYtDlp(url, output);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4'));
    if (!files.length) throw new Error('No se encontró un archivo de video descargable.');
    const file = path.join(dir, files[0]);
    jobs.set(id, { status: 'ready', createdAt: Date.now(), dir, file, name: safeFilename(path.basename(files[0])) });
    const base = appBase || `${req.protocol}://${req.get('host')}`;
    return res.json({ ok: true, id, downloadUrl: `${base}/api/file/${id}` });
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    jobs.delete(id);
    return res.status(422).json({ error: 'No fue posible procesar ese video. Comprueba que sea público y que el enlace sea correcto.' });
  }
});

app.get('/api/file/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'ready' || !fs.existsSync(job.file)) {
    return res.status(404).send('Archivo no disponible o expirado.');
  }
  res.download(job.file, job.name || 'bluesave-video.mp4', err => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

app.listen(PORT, () => console.log(`BlueSave API running on port ${PORT}`));
