// The page that draws the phone's clock and PC stats widgets. It is plain strings, with no React Native
// imports, so scripts/check-web-widgets.ts can load the page the phone loads. See web-widgets.tsx for the
// app side and web-widget-lifecycle.ts for how the two talk.
//
// Messages the page posts to the app (JSON):
//   { ready: 1 }                                  the page's scripts have run and it accepts widgets
//   { ack, needs, shown, errors }                 the widgets of request number `ack` are drawn: the
//                                                 readings they need, how many are on screen, and any
//                                                 widget that failed to draw (the others still draw)
// The app calls window.openDockTheme(scheme, tile) when the page is ready and on every theme change, then
// window.openDockWidgets(list, hour12, force, seq) and OpenDockClock.setPaused(paused).

/** Version of the messages above; the page announces it in { ready }. */
export const PAGE_PROTOCOL = 1;

// Clock faces and PC stats widgets are shared web code (pc-companion/src/clock-faces, src/pc-stats).
// One WebView per widget area draws all of them, each in its tile's rectangle, so a page runs one web
// engine, loads the code and fonts once and shares one frame loop. Tiles stay native underneath and
// keep every touch: this layer ignores them. The fonts are embedded (web-fonts-source.ts), so the page
// never waits on a network request. The sources are parameters so scripts can build the page without the app.
export type PageSources = {
  wakeCounterJs: string;
  background: string;
  clockFaces: string;
  pcStats: string;
  fontsCss: string;
  fontLoads: string[];
};
export function widgetPageHtml({ wakeCounterJs, background, clockFaces, pcStats, fontsCss, fontLoads }: PageSources): string {
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="color-scheme" content="light dark">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}html{color-scheme:dark}</style>
<style>${fontsCss}</style>
</head><body><script>
${wakeCounterJs}
${clockFaces.replace(/<\/script/gi, '<\\/script')}
${pcStats.replace(/<\/script/gi, '<\\/script')}
OpenDockClock.setFrameRate(30);
var shown = {}, pending = null, fontsReady = false, panel = ${JSON.stringify(background)};
function post(message) {
  try { window.ReactNativeWebView.postMessage(JSON.stringify(message)); return true; } catch (error) { return false; }
}
function mountOne(w, hour12) {
  var host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:' + w.x + 'px;top:' + w.y + 'px;width:' + w.width + 'px;height:' + w.height + 'px;border-radius:6px;overflow:hidden';
  document.body.appendChild(host);
  try {
    var handle = w.kind === 'clock'
      ? OpenDockClock.mount(host, { face: w.face || 'digital', color: w.color || null, width: w.width, height: w.height, hour12: hour12 })
      : OpenDockStats.mount(host, { style: w.face || 'ring', metric: w.metric || 'cpu', color: w.color || null, gpu: w.gpu || 'auto', background: panel, still: true, width: w.width, height: w.height, columns: w.columns, rows: w.rows });
    return { host: host, handle: handle };
  } catch (error) {
    host.remove();
    throw error;
  }
}
function destroy(item) {
  try { item.handle.destroy(); } catch (error) { /* already gone */ }
  try { item.host.remove(); } catch (error) { /* already gone */ }
}
// Shows exactly request.list: widgets whose options or rectangle changed are re-mounted, others kept. A widget
// that fails to draw is reported and skipped, so one bad widget never blanks the rest.
function show(request) {
  var keep = {}, needs = {}, errors = [];
  (request.list || []).forEach(function (w) {
    try {
      keep[w.id] = true;
      if (w.kind === 'stats') OpenDockStats.needs(w.face || 'ring', w.metric || 'cpu', w.columns, w.rows).forEach(function (n) { needs[n] = true; });
      var key = JSON.stringify(w) + request.hour12;
      var item = shown[w.id];
      if (item && item.key === key && !request.force) return;
      if (item) { destroy(item); delete shown[w.id]; }
      shown[w.id] = mountOne(w, request.hour12);
      shown[w.id].key = key;
    } catch (error) {
      errors.push({ id: w && w.id, message: String(error && error.message || error) });
    }
  });
  Object.keys(shown).forEach(function (id) { if (!keep[id]) { destroy(shown[id]); delete shown[id]; } });
  post({ ack: request.seq, needs: Object.keys(needs).sort(), shown: Object.keys(shown).length, errors: errors });
}
// The app's look, sent before the first widgets and again whenever it changes. Widgets on screen are updated in place.
window.openDockTheme = function (scheme, tile) {
  panel = tile;
  document.documentElement.style.colorScheme = scheme;
  OpenDockClock.setTheme(scheme);
  OpenDockStats.setTheme(scheme, tile);
};
window.openDockWidgets = function (list, hour12, force, seq) {
  var request = { list: list, hour12: hour12, force: !!force, seq: seq };
  // Until the fonts are in, only the newest request is kept: stats widgets size their text by measuring it.
  if (!fontsReady) { pending = request; return; }
  show(request);
};
function fontsDone() {
  if (fontsReady) return;
  fontsReady = true;
  if (pending) { var request = pending; pending = null; show(request); }
}
// The fonts are embedded, so they decode in milliseconds; the timeout only keeps a failure from holding widgets back.
var gate = (document.fonts && document.fonts.load)
  ? Promise.all(${JSON.stringify(fontLoads)}.map(function (font) { return document.fonts.load(font, 'Aa0'); }))
  : Promise.resolve();
Promise.race([gate, new Promise(function (resolve) { setTimeout(resolve, 1500); })]).then(fontsDone, fontsDone);
// Tells the app the page can take widgets, retrying until the native bridge exists.
var announced = 0;
function announce() {
  if (post({ ready: ${PAGE_PROTOCOL} })) return;
  if (++announced < 100) setTimeout(announce, 50);
}
announce();
</script></body></html>`;
}
