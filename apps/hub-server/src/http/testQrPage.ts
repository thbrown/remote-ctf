/** Dev/testing aid, not part of doc01's normative surface: a standalone page with sample
 * `pl` (player) and `rp` (respawn location) QR codes to scan against a running Hub
 * without needing real players registered or real hardware.
 *
 * The `pl` codes use synthetic tokens that don't belong to any real player - scanning one
 * will hit GameEngine.handleScan → attemptTag and get rejected (no matching player), which
 * is itself a useful signal that the camera/QR-decode/scan pipeline works end to end.
 *
 * The `rp` codes use fixed IDs (`test-respawn-1..3`). Respawn locations normally get a
 * server-generated UUID, so these only resolve once you create matching locations via the
 * Admin app's "Custom ID" field (added alongside this page) using the exact same IDs. */
import QRCode from 'qrcode';
import { encodePlQr, encodeRpQr } from '@foundry-ctf/shared';

const TEST_PLAYER_TOKENS = ['TESTPLAYERTOKEN01', 'TESTPLAYERTOKEN02', 'TESTPLAYERTOKEN03'];
const TEST_RESPAWN_IDS = ['test-respawn-1', 'test-respawn-2', 'test-respawn-3'];

export async function renderTestQrHtml(): Promise<string> {
  const playerQrs = await Promise.all(
    TEST_PLAYER_TOKENS.map((token) => QRCode.toDataURL(encodePlQr(token), { margin: 1, width: 260 })),
  );
  const respawnQrs = await Promise.all(
    TEST_RESPAWN_IDS.map((id) => QRCode.toDataURL(encodeRpQr(id), { margin: 1, width: 260 })),
  );

  const playerCards = TEST_PLAYER_TOKENS.map(
    (token, i) => `
    <div class="card">
      <img src="${playerQrs[i]}" width="260" height="260" alt="Test player QR ${i + 1}" />
      <div><strong>Test player ${i + 1}</strong></div>
      <div><code>${encodePlQr(token)}</code></div>
    </div>`,
  ).join('');

  const respawnCards = TEST_RESPAWN_IDS.map(
    (id, i) => `
    <div class="card">
      <img src="${respawnQrs[i]}" width="260" height="260" alt="Test respawn QR ${i + 1}" />
      <div><strong>Test respawn ${i + 1}</strong></div>
      <div><code>${encodeRpQr(id)}</code></div>
      <div class="hint">Admin → Respawn Locations → Custom ID: <code>${id}</code></div>
    </div>`,
  ).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Foundry CTF — Test QR Codes</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 32px; max-width: 1000px; margin: 0 auto; }
  h1 { margin-bottom: 4px; }
  h2 { margin-top: 40px; }
  .row { display: flex; gap: 24px; margin: 24px 0; flex-wrap: wrap; }
  .card { border: 1px solid #ccc; border-radius: 12px; padding: 16px; text-align: center; max-width: 280px; }
  .card img { display: block; margin: 0 auto 12px; background: white; }
  .hint { margin-top: 8px; font-size: 0.85rem; color: #555; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
  .instructions { margin-top: 8px; font-size: 0.95rem; line-height: 1.6; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h1>Foundry CTF — Test QR Codes</h1>
  <p>For manual testing without real hardware or registered players. Not linked from the
  join sheet — bookmark <code>/test-qr</code> directly.</p>

  <h2>Player (tag) test codes</h2>
  <p class="instructions">These use made-up tokens, not a real player's. Scanning one in
  the Player app's camera confirms the scan/decode pipeline works, but the Hub will reject
  the tag with "unknown player" since no one actually holds this token. To test a real tag,
  scan another real player's own code from their <em>OwnQrScreen</em>/profile instead.</p>
  <div class="row">${playerCards}</div>

  <h2>Respawn location test codes</h2>
  <p class="instructions">Respawn locations normally get a random ID when created in Admin.
  To make these fixed codes resolve, open Admin → Respawn Locations and create a location
  for each, entering the matching Custom ID shown below (any lat/long works for testing).</p>
  <div class="row">${respawnCards}</div>
</body>
</html>`;
}
