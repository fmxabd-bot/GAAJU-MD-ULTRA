// Credits to Silent Wolf - Kenya
// Launcher + process manager + Web Pairing
'use strict';
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const express = require('express');

const BOT_DIR    = path.join(__dirname, 'bot');
const YT_DLP     = path.join(BOT_DIR, 'yt-dlp');
const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

// ── Web Server Setup ─────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let pendingPairRequest = null; // { phone, resolve, reject }
let lastPairingCode = null;

// HTML Page
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp Bot - Pairing</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: Arial, sans-serif; background: #111; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .container { background: #222; padding: 40px; border-radius: 12px; text-align: center; max-width: 400px; width: 90%; }
        h1 { color: #25D366; margin-bottom: 20px; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: none; border-radius: 6px; font-size: 16px; box-sizing: border-box; }
        button { background: #25D366; color: #000; border: none; padding: 12px 24px; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; }
        button:hover { background: #1ebe5a; }
        .code { font-size: 32px; letter-spacing: 8px; color: #25D366; margin: 20px 0; font-weight: bold; }
        .status { margin-top: 20px; padding: 12px; border-radius: 6px; }
        .success { background: #1b5e20; color: #a5d6a7; }
        .error { background: #b71c1c; color: #ef9a9a; }
        .info { background: #0d47a1; color: #90caf9; }
        #step2 { display: none; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Bot Pairing</h1>
        <div id="step1">
            <p>Apna WhatsApp number country code ke saath likhein</p>
            <input type="text" id="phone" placeholder="923001234567" />
            <button onclick="getCode()">Get Pairing Code</button>
        </div>
        <div id="step2">
            <div class="status info" id="statusMsg">Code generate ho raha hai...</div>
            <div class="code" id="codeDisplay"></div>
            <p style="font-size: 14px; color: #aaa;">WhatsApp > Linked Devices > Link with phone number mein yeh code enter karein</p>
        </div>
    </div>
    <script>
        async function getCode() {
            const phone = document.getElementById('phone').value.trim();
            if (!phone) { alert('Number likhein!'); return; }
            document.getElementById('step1').style.display = 'none';
            document.getElementById('step2').style.display = 'block';
            document.getElementById('statusMsg').textContent = 'Code generate ho raha hai...';
            try {
                const res = await fetch('/pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone })
                });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('codeDisplay').textContent = data.code;
                    document.getElementById('statusMsg').textContent = 'Code enter karein WhatsApp mein';
                    document.getElementById('statusMsg').className = 'status success';
                } else {
                    document.getElementById('statusMsg').textContent = data.error || 'Error aya';
                    document.getElementById('statusMsg').className = 'status error';
                }
            } catch (e) {
                document.getElementById('statusMsg').textContent = 'Network error';
                document.getElementById('statusMsg').className = 'status error';
            }
        }
    </script>
</body>
</html>
    `);
});

// Pairing endpoint — bot child ko number bhejta hai
app.post('/pair', (req, res) => {
    const { phone } = req.body;
    if (!phone || phone.length < 10) {
        return res.json({ success: false, error: 'Valid number likhein (country code ke saath)' });
    }
    if (!currentBot) {
        return res.json({ success: false, error: 'Bot abhi start ho raha hai, 5 second baad try karein' });
    }
    // Agar pehle se code hai toh wahi de dein
    if (lastPairingCode) {
        return res.json({ success: true, code: lastPairingCode });
    }
    // Bot ko number bhejein (stdin ke through)
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    try {
        currentBot.stdin.write(JSON.stringify({ type: 'pair', phone: cleanPhone }) + '\n');
    } catch (e) {
        return res.json({ success: false, error: 'Bot se connect nahi ho paya' });
    }
    // Response ka intezar karein
    const timeout = setTimeout(() => {
        if (pendingPairRequest === req) pendingPairRequest = null;
        res.json({ success: false, error: 'Timeout — code generate nahi hua, dobara try karein' });
    }, 30000);
    pendingPairRequest = { res, timeout };
});

app.get('/status', (req, res) => {
    res.json({ connected: !!currentBot, hasCode: !!lastPairingCode });
});

app.listen(PORT, () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});

// ── PID lock file ────────────────────────────────────────────────────────────
const LOCK_FILE = path.join(__dirname, '.launcher.pid');

function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try { process.kill(oldPid, 'SIGTERM'); } catch (e) {}
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try { process.kill(oldPid, 0); } catch { break; }
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
    console.log(`[launcher] Lock acquired (PID ${process.pid})`);
  } catch (e) {
    console.error('[launcher] Could not acquire lock:', e.message);
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stored = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (stored === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── Track current bot child ──────────────────────────────────────────────────
let currentBot = null;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[launcher] ${signal} received — stopping child bot...`);
  if (currentBot) {
    try {
      currentBot.kill('SIGTERM');
      setTimeout(() => { try { currentBot.kill('SIGKILL'); } catch {} }, 5000);
    } catch {}
  }
  releaseLock();
  setTimeout(() => process.exit(0), 6000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('exit',    () => releaseLock());

// ── yt-dlp download ──────────────────────────────────────────────────────────
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get  = (u) => https.get(u, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    get(url);
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(YT_DLP)) return;
  console.log('[launcher] yt-dlp missing — downloading latest...');
  await download(YT_DLP_URL, YT_DLP);
  fs.chmodSync(YT_DLP, '755');
  console.log('[launcher] yt-dlp ready.');
}

// ── Bot child manager ────────────────────────────────────────────────────────
function startBot() {
  if (shuttingDown) return;
  console.log('[launcher] Starting bot...');
  const bot = spawn(process.execPath, [path.join(__dirname, 'bot', 'index.js')], {
    stdio: ['pipe', 'inherit', 'inherit'], // stdin pipe (parent->child), stdout/stderr inherit
    env:   process.env,
    cwd:   BOT_DIR,
  });
  currentBot = bot;

  // Bot se aane wale messages (pairing code) sunain
  let buffer = '';
  bot.stdout.on('data', (data) => {
    buffer += data.toString();
    let lines = buffer.split('\n');
    buffer = lines.pop(); // last incomplete line ko rakh lein
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'pairing_code' && msg.code) {
          lastPairingCode = msg.code;
          if (pendingPairRequest) {
            clearTimeout(pendingPairRequest.timeout);
            pendingPairRequest.res.json({ success: true, code: msg.code });
            pendingPairRequest = null;
          }
        }
      } catch (e) {
        // JSON nahi hai, normal log hai — ignore
      }
    }
  });

  bot.on('exit', (code) => {
    currentBot = null;
    if (shuttingDown) return;
    if (code === 1) {
      console.log('[launcher] Bot exited with code 1 — restarting in 3s...');
      setTimeout(startBot, 3000);
    } else {
      console.log(`[launcher] Bot stopped (code ${code}). Launcher staying alive.`);
    }
  });
}

// ── Auto-install bot dependencies ────────────────────────────────────────────
function ensureDeps() {
  return new Promise((resolve) => {
    const nmDir = path.join(BOT_DIR, 'node_modules');
    const pkg   = path.join(BOT_DIR, 'package.json');
    const testMod = path.join(nmDir, 'dotenv');
    if (fs.existsSync(testMod)) return resolve();
    if (!fs.existsSync(pkg)) return resolve();
    console.log('[launcher] node_modules missing or incomplete — running npm install in bot/...');
    const { execSync } = require('child_process');
    try {
      execSync('npm install --omit=dev', { cwd: BOT_DIR, stdio: 'inherit', timeout: 180000 });
      console.log('[launcher] npm install complete.');
    } catch (e) {
      console.error('[launcher] npm install failed:', e.message);
    }
    resolve();
  });
}

// ── Entry point ──────────────────────────────────────────────────────────────
acquireLock();
ensureDeps()
  .then(() => ensureYtDlp().catch((err) => console.error('[launcher] yt-dlp download failed:', err.message)))
  .finally(startBot);

// Credits to Silent Wolf - Kenya
