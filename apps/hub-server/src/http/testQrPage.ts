/** Dev/testing aid, not part of doc01's normative surface: a standalone page with sample
 * `pl` (player badge) and `rp` (respawn location) QR codes to scan against a running Hub
 * without needing real printed badges or real hardware.
 *
 * The `pl` codes are exactly what a real pre-printed player badge looks like: a fixed
 * `qrctf:1:pl:<token>` code, unclaimed until a player scans it during onboarding
 * (ClaimBadgeScreen → `player:claimQr`), at which point that token becomes their
 * qrCodeToken. Print/screenshot these 3 and use them as test badges - the first player to
 * scan one claims it; scanning the same one again from a different player is rejected
 * ("already_claimed").
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
      <div class="qr-wrap">
        <img src="${playerQrs[i]}" width="260" height="260" alt="Test player badge ${i + 1}" />
        <div class="qr-veil">hover to reveal</div>
      </div>
      <div><strong>Test badge ${i + 1}</strong></div>
      <div><code>${encodePlQr(token)}</code></div>
    </div>`,
  ).join('');

  const respawnCards = TEST_RESPAWN_IDS.map(
    (id, i) => `
    <div class="card">
      <div class="qr-wrap">
        <img src="${respawnQrs[i]}" width="260" height="260" alt="Test respawn QR ${i + 1}" />
        <div class="qr-veil">hover to reveal</div>
      </div>
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
  .card img { display: block; background: white; }
  .hint { margin-top: 8px; font-size: 0.85rem; color: #555; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
  .instructions { margin-top: 8px; font-size: 0.95rem; line-height: 1.6; }

  /* Blurred by default so a phone camera aimed at the screen can't pick up neighboring
     codes - hover the one you want to scan to reveal it. */
  .qr-wrap { position: relative; width: 260px; height: 260px; margin: 0 auto 12px; }
  .qr-wrap img { width: 100%; height: 100%; filter: blur(14px); transition: filter 0.15s ease; }
  .qr-veil {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.55); border-radius: 8px; font-size: 0.85rem; color: #333;
    transition: opacity 0.15s ease; pointer-events: none;
  }
  .qr-wrap:hover img { filter: none; }
  .qr-wrap:hover .qr-veil { opacity: 0; }
  @media print {
    body { padding: 0; }
    .qr-wrap img { filter: none; }
    .qr-veil { display: none; }
  }
</style>
</head>
<body>
  <h1>Foundry CTF — Test QR Codes</h1>
  <p>For manual testing without real printed badges or real hardware. Not linked from the
  join sheet — bookmark <code>/test-qr</code> directly.</p>

  <h2>Player badge test codes</h2>
  <p class="instructions">These are real, claimable test badges. During onboarding
  (registration → "Claim your badge"), scan one with the Player app's camera to claim it -
  that token becomes your qrCodeToken, the same code other players scan on this badge to
  tag you. Only the first player to scan a given badge gets it; anyone else scanning the
  same one is rejected ("already claimed") - use badges 1/2/3 for separate test players.</p>
  <div class="row">${playerCards}</div>

  <h2>Respawn location test codes</h2>
  <p class="instructions">Respawn locations normally get a random ID when created in Admin.
  To make these fixed codes resolve, open Admin → Respawn Locations and create a location
  for each, entering the matching Custom ID shown below (any lat/long works for testing).</p>
  <div class="row">${respawnCards}</div>
</body>
</html>`;
}
