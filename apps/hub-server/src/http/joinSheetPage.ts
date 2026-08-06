/** doc01 HUB-030 — printable Join Sheet: Wi-Fi QR, App QR, spectator scoreboard URL,
 * certificate click-through instructions for iOS/Android (HUB-024). */
import QRCode from 'qrcode';
import type { Config } from '../config.js';

export async function renderJoinSheetHtml(config: Config): Promise<string> {
  const wifiPayload = `WIFI:T:WPA;S:${config.wifiSsid};P:${config.wifiPsk};H:false;;`;
  const [wifiQr, appQr] = await Promise.all([
    QRCode.toDataURL(wifiPayload, { margin: 1, width: 300 }),
    QRCode.toDataURL(config.publicOrigin, { margin: 1, width: 300 }),
  ]);

  const scoreboardUrl = config.publicOrigin.replace(/^https:\/\//, 'http://').replace(/:\d+$/, `:${config.spectatorHttpPort}`) + '/scoreboard';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Foundry CTF — Join Sheet</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 32px; max-width: 900px; margin: 0 auto; }
  h1 { margin-bottom: 4px; }
  .row { display: flex; gap: 32px; margin: 24px 0; flex-wrap: wrap; }
  .card { border: 1px solid #ccc; border-radius: 12px; padding: 20px; text-align: center; }
  .card img { display: block; margin: 0 auto 12px; }
  .instructions { margin-top: 32px; font-size: 0.95rem; line-height: 1.6; }
  .instructions h2 { font-size: 1.1rem; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h1>Foundry CTF</h1>
  <p>Scan to join — no app install required.</p>

  <div class="row">
    <div class="card">
      <img src="${wifiQr}" width="300" height="300" alt="Wi-Fi QR" />
      <div><strong>1. Join Wi-Fi</strong></div>
      <div>SSID: <code>${config.wifiSsid}</code></div>
    </div>
    <div class="card">
      <img src="${appQr}" width="300" height="300" alt="App QR" />
      <div><strong>2. Open the Web App</strong></div>
      <div><code>${config.publicOrigin}</code></div>
    </div>
  </div>

  <p>Spectator scoreboard (no login, no camera, safe to leave on a venue TV):<br />
    <code>${scoreboardUrl}</code>
  </p>

  <div class="instructions">
    <h2>First-time certificate warning</h2>
    <p>This Hub uses a self-signed certificate — camera and location still work after you
    click through the warning once per device/browser.</p>
    <p><strong>iOS Safari:</strong> tap <em>Show Details</em> → <em>visit this website</em> → <em>Visit Website</em>.</p>
    <p><strong>Android Chrome:</strong> tap <em>Advanced</em> → <em>Proceed to site (unsafe)</em>.</p>
    <p>The certificate is also available for manual install at <code>${config.publicOrigin}/cert</code>.</p>
  </div>
</body>
</html>`;
}
