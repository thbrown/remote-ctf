/**
 * Shared browser-side map code, injected as a <script> into both the live spectator
 * scoreboard and the post-game replay page.
 *
 * There are no map tiles and there never can be: the Hub is an offline AP with no route to
 * the internet, and HUB-152's no-CDN rule applies regardless. So this draws bare geometry —
 * control points, respawn points and players — on a local equirectangular projection, with
 * a scale bar so the picture is actually interpretable without a basemap under it.
 *
 * The projection is deliberately the simple one: over a playing field (hundreds of metres,
 * not hundreds of kilometres) equirectangular with a cos(lat) correction on longitude is
 * accurate to well under the GPS error itself, and it keeps the code readable. Anything
 * fancier would be false precision.
 *
 * Exported as a string rather than a module because both consumers are server-rendered HTML
 * pages with inline scripts, not a bundled app.
 */
export const MAP_VIEW_SCRIPT = `
// Metres per degree of latitude, near enough for any single venue.
const M_PER_DEG_LAT = 111320;

function metresPerDegLong(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/**
 * Builds a projection fitting every supplied {lat,long} point into a w x h box.
 * Returns null when there is nothing to draw, or when every point is at the same spot and
 * no meaningful extent exists yet.
 */
function makeProjection(points, w, h, padPx) {
  const valid = points.filter((p) => typeof p.lat === 'number' && typeof p.long === 'number' && !Number.isNaN(p.lat));
  if (valid.length === 0) return null;

  const lats = valid.map((p) => p.lat);
  const longs = valid.map((p) => p.long);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const mPerLong = metresPerDegLong(midLat);

  // Work in metres relative to the south-west corner so x and y share one scale - otherwise
  // the field is stretched horizontally by roughly 1/cos(lat) and distances read wrong.
  const originLat = Math.min(...lats);
  const originLong = Math.min(...longs);
  const toM = (p) => ({
    x: (p.long - originLong) * mPerLong,
    y: (p.lat - originLat) * M_PER_DEG_LAT,
  });

  const ms = valid.map(toM);
  const spanX = Math.max(...ms.map((m) => m.x));
  const spanY = Math.max(...ms.map((m) => m.y));

  // A floor on the span keeps a single point (or a tight cluster) from being scaled to
  // absurdity - with one player and one control point 2 m apart you want to see a small
  // field, not a 100x zoom into GPS noise.
  const MIN_SPAN_M = 40;
  const usableW = w - padPx * 2;
  const usableH = h - padPx * 2;
  const scale = Math.min(usableW / Math.max(spanX, MIN_SPAN_M), usableH / Math.max(spanY, MIN_SPAN_M));

  // Centre whatever we have inside the box.
  const offsetX = padPx + (usableW - spanX * scale) / 2;
  const offsetY = padPx + (usableH - spanY * scale) / 2;

  return {
    scale, // px per metre
    project(p) {
      const m = toM(p);
      // SVG y grows downward; latitude grows north/up. Flip it.
      return { x: offsetX + m.x * scale, y: h - (offsetY + m.y * scale) };
    },
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** A scale bar snapped to a round number of metres that fits in ~a quarter of the width. */
function scaleBarSvg(projection, w, h) {
  if (!projection) return '';
  const targetPx = w / 4;
  const rawM = targetPx / projection.scale;
  const pow = Math.pow(10, Math.floor(Math.log10(rawM)));
  const niceM = [1, 2, 5, 10].map((f) => f * pow).reduce((best, v) => (Math.abs(v - rawM) < Math.abs(best - rawM) ? v : best));
  const barPx = niceM * projection.scale;
  const x = 12;
  const y = h - 14;
  return (
    '<line x1="' + x + '" y1="' + y + '" x2="' + (x + barPx) + '" y2="' + y + '" stroke="#8a90a0" stroke-width="2" />' +
    '<line x1="' + x + '" y1="' + (y - 4) + '" x2="' + x + '" y2="' + (y + 4) + '" stroke="#8a90a0" stroke-width="2" />' +
    '<line x1="' + (x + barPx) + '" y1="' + (y - 4) + '" x2="' + (x + barPx) + '" y2="' + (y + 4) + '" stroke="#8a90a0" stroke-width="2" />' +
    '<text x="' + (x + barPx + 8) + '" y="' + (y + 4) + '" fill="#8a90a0" font-size="12">' + niceM + ' m</text>'
  );
}

/**
 * Renders the whole scene to SVG markup.
 *
 * entities: { controlPoints, respawnLocations, players, teamById }
 * Players carry an optional atMs so a stale fix can be drawn hollow - a frozen dot and a
 * genuinely stationary player look identical otherwise, and the difference matters a lot
 * when you're trying to work out whether someone's phone died.
 */
function renderMapSvg(el, entities, opts) {
  const w = el.clientWidth || 800;
  const h = opts && opts.height ? opts.height : 420;
  const STALE_MS = 30000;
  const nowMs = (opts && opts.nowMs) || Date.now();

  const cps = (entities.controlPoints || []).filter((c) => typeof c.locationLat === 'number');
  const rps = (entities.respawnLocations || []).filter((r) => typeof r.locationLat === 'number');
  const players = (entities.players || []).filter((p) => typeof p.locationLat === 'number');

  const all = []
    .concat(cps.map((c) => ({ lat: c.locationLat, long: c.locationLong })))
    .concat(rps.map((r) => ({ lat: r.locationLat, long: r.locationLong })))
    .concat(players.map((p) => ({ lat: p.locationLat, long: p.locationLong })));

  const projection = makeProjection(all, w, h, 28);
  if (!projection) {
    el.innerHTML =
      '<div class="map-empty">No positions yet — an admin needs to set control point / respawn point ' +
      'coordinates, and players need a GPS fix.</div>';
    return;
  }

  let svg = '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Live player map">';

  // Respawn points: outlined diamonds, drawn first so they sit under everything.
  for (const r of rps) {
    const p = projection.project({ lat: r.locationLat, long: r.locationLong });
    svg +=
      '<polygon points="' +
      [ [p.x, p.y - 7], [p.x + 7, p.y], [p.x, p.y + 7], [p.x - 7, p.y] ].map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ') +
      '" fill="none" stroke="#7d86a0" stroke-width="2" />';
  }

  // Control points: squares in the owning team's colour.
  for (const c of cps) {
    const p = projection.project({ lat: c.locationLat, long: c.locationLong });
    const team = c.currentOwnerTeamId ? entities.teamById(c.currentOwnerTeamId) : null;
    const color = team ? team.hexColor : '#8a90a0';
    svg +=
      '<rect x="' + (p.x - 8).toFixed(1) + '" y="' + (p.y - 8).toFixed(1) + '" width="16" height="16" rx="3" ' +
      'fill="' + color + '" fill-opacity="0.85" stroke="#0b0d12" stroke-width="2" />' +
      '<text x="' + p.x.toFixed(1) + '" y="' + (p.y - 13).toFixed(1) + '" fill="#c9cedb" font-size="12" text-anchor="middle">' +
      escapeHtml(c.controlPointName) + '</text>';
  }

  // Players: dot + accuracy halo + name.
  for (const pl of players) {
    const p = projection.project({ lat: pl.locationLat, long: pl.locationLong });
    const team = pl.teamId ? entities.teamById(pl.teamId) : null;
    const color = team ? team.hexColor : '#8a90a0';
    const stale = pl.atMs != null && nowMs - pl.atMs > STALE_MS;
    const taggedOut = pl.playerStatus === 'tagged_out';
    const opacity = taggedOut ? 0.35 : 1;

    if (typeof pl.locationAccuracyM === 'number' && pl.locationAccuracyM > 0) {
      const rPx = Math.min(pl.locationAccuracyM * projection.scale, Math.max(w, h));
      svg +=
        '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + rPx.toFixed(1) + '" ' +
        'fill="' + color + '" fill-opacity="0.10" stroke="' + color + '" stroke-opacity="0.25" stroke-width="1" />';
    }
    svg +=
      '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="6" ' +
      (stale ? 'fill="none" stroke-dasharray="3 2" ' : 'fill="' + color + '" ') +
      'stroke="' + color + '" stroke-width="2" opacity="' + opacity + '" />' +
      '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + 20).toFixed(1) + '" fill="#e8ebf2" font-size="12" ' +
      'text-anchor="middle" opacity="' + opacity + '">' + escapeHtml(pl.playerName) + (stale ? ' (stale)' : '') + '</text>';
  }

  svg += scaleBarSvg(projection, w, h);
  svg += '</svg>';
  el.innerHTML = svg;
}
`;

/** Styles for the map container, shared by both pages. */
export const MAP_VIEW_CSS = `
  #map-wrap { background: #12151c; border-radius: 10px; margin-bottom: 32px; padding: 4px; }
  .map-empty { padding: 40px 16px; text-align: center; opacity: 0.6; font-size: 1rem; }
  .map-note { font-size: 0.85rem; opacity: 0.55; margin: 6px 2px 0; }
`;
