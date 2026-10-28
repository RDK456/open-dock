// Run: node scripts/check-web-widgets.ts
// The phone draws clock and PC stats widgets in one web view. This checks the two halves of keeping it
// working: how the app drives the web view through page and profile switches (every case, including the
// ones that used to leave widgets blank), and that the page itself announces itself, acknowledges what it
// is sent, isolates a widget that fails, and uses only its embedded fonts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACK_MS, GIVE_UP_MS, IDLE_MS, MAX_RECOVERIES, READY_MS, initialState, step } from '../phone-app/src/web-widget-lifecycle.ts';
import type { Command, Props, State, TimerKind } from '../phone-app/src/web-widget-lifecycle.ts';
import { widgetPageHtml } from '../phone-app/src/web-widgets-page.ts';
import { CLOCK_FACES_SOURCE } from '../phone-app/src/clock-faces-source.ts';
import { PC_STATS_SOURCE } from '../phone-app/src/pc-stats-source.ts';
import { PET_SOURCE } from '../phone-app/src/pet-source.ts';
import { WEB_FONT_LOADS, WEB_FONTS_CSS } from '../phone-app/src/web-fonts-source.ts';

// --- The lifecycle ---------------------------------------------------------------------------------
type Send = Extract<Command, { type: 'send' }>;
class Sim {
  state: State = initialState();
  now = 1_000_000;
  timers = new Map<TimerKind, { token: number; ms: number }>();
  all: Command[] = [];
  dispatch(event: Parameters<typeof step>[1]) {
    const result = step(this.state, event, this.now);
    this.state = result.state;
    for (const command of result.commands) {
      if (command.type === 'schedule') this.timers.set(command.timer, { token: command.token, ms: command.ms });
      if (command.type === 'cancel') this.timers.delete(command.timer);
    }
    this.all.push(...result.commands);
    return result.commands;
  }
  // Time passes until the timer fires, as it would on the phone.
  fire(kind: TimerKind) {
    const timer = this.timers.get(kind);
    assert.ok(timer, `no ${kind} timer is waiting`);
    this.timers.delete(kind);
    this.now += timer.ms;
    return this.dispatch({ type: 'timer', kind, token: timer.token });
  }
  props(props: Partial<Props>) { return this.dispatch({ type: 'props', props: { ...this.state.props, ...props } }); }
  ready(instance = this.state.instance) { return this.dispatch({ type: 'ready', instance }); }
  ack(needs: string[] = ['cpu'], seq = this.state.seq, instance = this.state.instance) { return this.dispatch({ type: 'ack', instance, seq, needs }); }
}
const sends = (commands: Command[]) => commands.filter((command): command is Send => command.type === 'send');
const of = (commands: Command[], type: Command['type']) => commands.filter((command) => command.type === type);
const A = JSON.stringify([{ id: 'a' }]);
const B = JSON.stringify([{ id: 'b' }]);
// A page with widgets that has answered, ready for the cases below.
const running = (list = A) => {
  const sim = new Sim();
  sim.props({ list, hasWidgets: true });
  sim.ready();
  sim.ack();
  return sim;
};

{
  // First show: nothing is sent until the page announces itself, then the list, the pause state and its needs.
  const sim = new Sim();
  assert.deepEqual(sim.props({ list: A, hasWidgets: true }).map((command) => command.type), ['schedule'], 'a new web view only waits for its page');
  assert.equal(sim.state.mounted && sim.state.instance, 1);
  const onReady = sim.ready();
  assert.deepEqual(sends(onReady).map(({ list, seq }) => [list, seq]), [[A, 1]]);
  assert.deepEqual(of(onReady, 'pause'), [{ type: 'pause', paused: false }]);
  assert.deepEqual(of(onReady, 'cancel'), [{ type: 'cancel', timer: 'ready' }], 'the page answered, so its ready timer is cancelled');
  assert.deepEqual(of(sim.ack(['cpu', 'ram']), 'needs'), [{ type: 'needs', needs: ['cpu', 'ram'] }], 'what the stats widgets need goes to the PC');
}

{
  // The old bug: a page with no clock or stats widgets, then back. The web view stays and gets the list at once.
  const sim = running();
  const away = sim.props({ hasWidgets: false });
  assert.deepEqual(sends(away).map((send) => send.list), ['[]'], 'a page without widgets is sent an empty list');
  assert.deepEqual(of(away, 'needs'), [{ type: 'needs', needs: null }], 'its readings are no longer needed');
  assert.ok(sim.timers.has('idle') && sim.state.mounted, 'it waits to be freed, but is kept for now');
  sim.ack([]);
  const back = sim.props({ hasWidgets: true });
  assert.equal(sim.timers.has('idle'), false, 'coming back cancels the free-up');
  assert.deepEqual(sends(back).map((send) => send.list), [A], 'and sends the widgets straight away');
  assert.equal(sim.state.instance, 1, 'the same web view was kept');
}

{
  // Left alone for a minute the web view is freed; coming back creates one that must announce itself first.
  const sim = running();
  sim.props({ hasWidgets: false });
  sim.ack([]);
  sim.fire('idle');
  assert.equal(sim.timers.get('idle'), undefined);
  assert.equal(sim.state.mounted, false);
  assert.equal(sim.now - 1_000_000 >= IDLE_MS, true);
  const back = sim.props({ hasWidgets: true });
  assert.deepEqual(back.map((command) => command.type), ['schedule'], 'a new web view sends nothing yet');
  assert.equal(sim.state.instance, 2);
  // Events of the old web view arriving late are ignored.
  assert.deepEqual(sim.ready(1), [], 'an old page announcing itself is ignored');
  assert.deepEqual(sim.ack(['cpu'], 1, 1), [], 'an old page answering is ignored');
  assert.deepEqual(sends(sim.ready(2)).map((send) => send.list), [A], 'the new page gets the list the moment it announces itself');
}

{
  // Quick switching before the page is ready: only the latest list is sent, once.
  const sim = new Sim();
  sim.props({ list: A, hasWidgets: true });
  for (const list of [B, A, B]) assert.deepEqual(sends(sim.props({ list })), [], 'nothing is sent to a page that has not announced itself');
  assert.deepEqual(sends(sim.ready()).map((send) => send.list), [B]);
  // Switching right after, before it answers: each new list is sent at once and only the newest answer counts.
  assert.deepEqual(sends(sim.props({ list: A })).map((send) => [send.list, send.seq]), [[A, 2]]);
  assert.deepEqual(sim.ack(['cpu'], 1), [], 'the answer to the older list changes nothing');
  assert.ok(sim.timers.has('ack'), 'the newest list is still waiting for its answer');
  assert.deepEqual(of(sim.ack(['cpu'], 2), 'cancel'), [{ type: 'cancel', timer: 'ack' }]);
}

{
  // Nothing to show: nothing is created.
  const sim = new Sim();
  assert.deepEqual(sim.props({ hasWidgets: false }), []);
  assert.deepEqual(sim.dispatch({ type: 'focus', focused: true }), []);
  assert.equal(sim.state.mounted, false);
}

{
  // The page never answers: the list is sent once more, then the page is reloaded.
  const sim = new Sim();
  sim.props({ list: A, hasWidgets: true });
  sim.ready();
  const again = sim.fire('ack');
  assert.deepEqual(sends(again).map((send) => [send.list, send.seq]), [[A, 2]], 'sent once more');
  const reload = sim.fire('ack');
  assert.equal(sim.state.instance, 2, 'then a fresh web view');
  assert.equal(sim.state.ready, false);
  assert.deepEqual(sends(reload), []);
  assert.ok(sim.timers.has('ready'));
  assert.equal(sim.now - 1_000_000, 2 * ACK_MS);
  assert.deepEqual(sends(sim.ready()).map((send) => send.list), [A], 'which is sent the list when it is ready');
}

{
  // A page that never announces itself is reloaded; a page that keeps failing is left alone for a while.
  const sim = new Sim();
  sim.props({ list: A, hasWidgets: true });
  for (let reload = 1; reload <= MAX_RECOVERIES; reload++) {
    sim.fire('ready');
    assert.equal(sim.state.instance, 1 + reload, `reload ${reload}`);
    assert.equal(sim.state.mounted, true);
  }
  sim.fire('ready');
  assert.equal(sim.state.mounted, false, 'after repeated failures the layer stops');
  const stopped = sim.now;
  sim.props({ list: B });
  assert.equal(sim.state.mounted, false, 'switching pages does not restart a layer that is backing off');
  assert.ok(sim.timers.has('retry'), 'it will try again');
  sim.fire('retry');
  assert.equal(sim.state.mounted, true, 'and does, after the pause');
  assert.equal(sim.now - stopped, GIVE_UP_MS, 'after exactly the pause');
  assert.deepEqual(sends(sim.ready()).map((send) => send.list), [B]);
}

{
  // The web view's process dies or the page fails to load.
  const sim = running();
  sim.dispatch({ type: 'failure', instance: 1, reason: 'render process gone' });
  assert.equal(sim.state.instance, 2);
  assert.equal(sim.state.ready, false);
  assert.deepEqual(sim.dispatch({ type: 'failure', instance: 1, reason: 'late news of the old page' }), [], 'failures of an old web view are ignored');
  assert.equal(sim.state.instance, 2);
  assert.deepEqual(sends(sim.ready()).map((send) => send.list), [A]);
  assert.equal(sim.state.paused, false);
}

{
  // A page that announces itself again has reloaded itself and lost every widget.
  const sim = running();
  assert.deepEqual(sends(sim.ready()).map((send) => send.list), [A]);
  assert.deepEqual(of(sim.ack(), 'cancel'), [{ type: 'cancel', timer: 'ack' }]);
}

{
  // Leaving the deck tab: the page pauses and the PC stops sampling; back quickly resumes and checks the page.
  const sim = running();
  const left = sim.dispatch({ type: 'focus', focused: false });
  assert.deepEqual(of(left, 'pause'), [{ type: 'pause', paused: true }]);
  assert.deepEqual(of(left, 'needs'), [{ type: 'needs', needs: null }]);
  assert.ok(sim.timers.has('idle'));
  assert.deepEqual(sends(left), [], 'the widgets stay in the page while hidden');
  const back = sim.dispatch({ type: 'focus', focused: true });
  assert.deepEqual(of(back, 'pause'), [{ type: 'pause', paused: false }]);
  assert.deepEqual(of(back, 'needs'), [{ type: 'needs', needs: ['cpu'] }]);
  assert.equal(sends(back).length, 1, 'the page is asked once more, to find out whether it survived');
  assert.equal(sim.timers.has('idle'), false);
  // Away for longer than the idle time: freed, and rebuilt on return.
  sim.ack();
  sim.dispatch({ type: 'focus', focused: false });
  sim.fire('idle');
  assert.equal(sim.state.mounted, false);
  sim.dispatch({ type: 'focus', focused: true });
  assert.equal(sim.state.mounted && sim.state.instance, 2);
}

{
  // The app in the background behaves the same way.
  const sim = running();
  const background = sim.dispatch({ type: 'app', active: false });
  assert.deepEqual(of(background, 'pause'), [{ type: 'pause', paused: true }]);
  assert.deepEqual(of(background, 'needs'), [{ type: 'needs', needs: null }]);
  sim.fire('idle');
  assert.equal(sim.state.mounted, false, 'a backgrounded app frees the web view');
  const foreground = sim.dispatch({ type: 'app', active: true });
  assert.equal(sim.state.mounted, true);
  assert.deepEqual(sends(foreground), [], 'sent nothing before the new page is ready');
}

{
  // A list that changes while the app is away reaches the paused page at once; coming back asks it once more.
  const sim = running();
  sim.dispatch({ type: 'app', active: false });
  assert.deepEqual(sends(sim.props({ list: B })).map((send) => send.list), [B]);
  sim.ack();
  const both = sim.dispatch({ type: 'app', active: true });
  assert.deepEqual(sends(both).map((send) => send.list), [B], 'one send on return, with the newest list');
}

{
  // A page nobody needs is not revived when it fails.
  const sim = running();
  sim.dispatch({ type: 'focus', focused: false });
  sim.dispatch({ type: 'failure', instance: 1, reason: 'render process gone' });
  assert.equal(sim.state.mounted, false);
  sim.dispatch({ type: 'focus', focused: true });
  assert.equal(sim.state.mounted, true);
}

{
  // The clock format changes with the same widgets.
  const sim = running();
  const changed = sim.props({ hour12: false });
  assert.deepEqual(sends(changed).map((send) => [send.list, send.hour12]), [[A, false]]);
}

{
  // An unanswered second send, or an answer from long ago, do not confuse the counters.
  const sim = running();
  sim.props({ list: B });
  sim.fire('ack');
  assert.equal(sim.state.attempts, 1);
  sim.ack(['cpu'], sim.state.seq);
  assert.equal(sim.state.attempts, 0);
  assert.equal(sim.timers.has('ack'), false);
}

{
  // The screen goes away: nothing keeps running and the PC is told nothing is needed.
  const sim = running();
  const gone = sim.dispatch({ type: 'unmount' });
  assert.deepEqual(of(gone, 'needs'), [{ type: 'needs', needs: null }]);
  assert.equal(sim.state.mounted, false);
  assert.equal(sim.timers.size, 0, 'every timer was cancelled');
}

// --- The page --------------------------------------------------------------------------------------
const html = widgetPageHtml({ wakeCounterJs: '', background: '#111113', clockFaces: CLOCK_FACES_SOURCE, pcStats: PC_STATS_SOURCE, pet: PET_SOURCE, fontsCss: WEB_FONTS_CSS, fontLoads: WEB_FONT_LOADS });
assert.ok(!/fonts\.(googleapis|gstatic)\.com|<link/i.test(html), 'the widget page must not load anything from the network');
assert.ok(html.includes("font-family:'Bricolage Grotesque'") && html.includes('data:font/woff2;base64,'), 'the fonts are embedded');

const browser = process.env.BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);
if (!browser) {
  console.log('web widgets: no Chromium browser found, skipping the page check (set BROWSER to enable)');
} else {
  const harness = `<script>
window.__messages = [];
window.ReactNativeWebView = { postMessage: function (message) { window.__messages.push(JSON.parse(message)); } };
</script>`;
  const driver = `<script>
(async function () {
  var failures = [], messages = window.__messages;
  var check = function (ok, text) { if (!ok) failures.push(text); };
  var sleep = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); };
  var hosts = function () { return [].slice.call(document.body.children).filter(function (node) { return node.tagName === 'DIV'; }); };
  var W = function (id, kind, extra) { return Object.assign({ id: id, kind: kind, x: 0, y: 0, width: 100, height: 100 }, extra); };
  OpenDockStats.setHistory([{ cpu: 23, cputemp: 64, clock: 3.6, cores: [20, 30, 10, 40], ram: 51.4, ramUsed: 8, ramTotal: 16, disk: 70, diskUsed: 170, diskTotal: 237, diskio: 0.35, diskRead: 0.3, diskWrite: 0.05, net: 1.2, netUp: 0.024, gpus: [] }]);

  // The page announces itself once, and answers only the newest of several requests sent before its fonts are in.
  check(messages.filter(function (m) { return m.ready; }).length === 1 && messages[0].ready === 1, 'the page announces itself exactly once');
  var list = [W('a', 'clock', { face: 'digital' }), W('s', 'stats', { face: 'ring', metric: 'cpu', columns: 1, rows: 1, x: 110 })];
  window.openDockWidgets([], true, false, 1);
  window.openDockWidgets(list.slice(0, 1), true, false, 2);
  window.openDockWidgets(list, true, false, 3);
  await sleep(400);
  var acks = messages.filter(function (m) { return 'ack' in m; });
  check(acks.length === 1 && acks[0].ack === 3, 'only the newest request sent before the fonts loaded is answered: ' + JSON.stringify(acks));
  check(acks[0] && acks[0].shown === 2 && acks[0].needs.indexOf('cpu') >= 0 && acks[0].errors.length === 0, 'the answer says what is shown and needed: ' + JSON.stringify(acks[0]));
  check(hosts().length === 2 && hosts().every(function (host) { return host.querySelector('canvas,svg') || host.textContent.length > 0; }), 'both widgets are drawn');

  // Later requests are answered at once, change only what changed, and an empty list clears the page.
  messages.length = 0;
  var before = hosts();
  window.openDockWidgets(list, true, false, 4);
  check(messages.length === 1 && messages[0].ack === 4 && messages[0].shown === 2, 'an unchanged list is answered');
  check(hosts().every(function (host, i) { return host === before[i]; }), 'an unchanged list redraws nothing');
  messages.length = 0;
  window.openDockWidgets(list.slice(0, 1), true, false, 5);
  check(messages[0].shown === 1 && hosts().length === 1 && messages[0].needs.length === 0, 'removing a widget removes its tile and its needs');
  messages.length = 0;
  window.openDockWidgets([], true, false, 6);
  check(messages[0].ack === 6 && messages[0].shown === 0 && hosts().length === 0, 'an empty list clears the page');

  // The page follows the app's look: widgets on screen change in place, and a scene face (a Nixie tube) stays dark.
  var rootOf = function (host) { return host.querySelector('.fc-root, .ps-root'); };
  var token = function (host, name) { return getComputedStyle(rootOf(host)).getPropertyValue(name).trim(); };
  messages.length = 0;
  window.openDockWidgets([W('t1', 'clock', { face: 'analog' }), W('t2', 'clock', { face: 'nixie', x: 110 }), W('t3', 'stats', { face: 'ring', metric: 'cpu', columns: 1, rows: 1, x: 220 })], true, true, 8);
  check(messages[0].shown === 3 && messages[0].errors.length === 0, 'the theme widgets are drawn: ' + JSON.stringify(messages[0]));
  check(token(hosts()[0], '--fg') === '#ececef' && token(hosts()[2], '--fg') === '#ececef', 'widgets are drawn dark until told otherwise');
  window.openDockTheme('light', '#fafafa');
  check(token(hosts()[0], '--fg') === '#18181b', 'a clock face is redrawn in the light palette: ' + token(hosts()[0], '--fg'));
  check(token(hosts()[1], '--fg') === '#ececef', 'a scene face stays dark');
  check(token(hosts()[2], '--fg') === '#18181b' && /250/.test(rootOf(hosts()[2]).style.background), 'a stats widget takes the light palette and the new tile color');
  check(document.documentElement.style.colorScheme === 'light', 'the page color scheme follows the theme');
  window.openDockWidgets([W('t4', 'clock', { face: 'analog' })], true, false, 9);
  check(token(hosts()[0], '--fg') === '#18181b', 'a widget drawn later uses the current theme');
  window.openDockTheme('dark', '#111113');
  check(token(hosts()[0], '--fg') === '#ececef', 'and back to dark');

  // One widget that cannot be drawn is reported, and the others are still drawn.
  var mount = OpenDockClock.mount;
  OpenDockClock.mount = function (host, options) { if (options.face === 'boom') throw new Error('boom'); return mount.call(OpenDockClock, host, options); };
  messages.length = 0;
  window.openDockWidgets([W('g1', 'clock', { face: 'digital' }), W('bad', 'clock', { face: 'boom', x: 110 }), W('g2', 'clock', { face: 'digital', x: 220 })], true, false, 7);
  OpenDockClock.mount = mount;
  check(messages[0].shown === 2 && messages[0].errors.length === 1 && messages[0].errors[0].id === 'bad', 'a failing widget is reported and skipped: ' + JSON.stringify(messages[0]));
  check(hosts().length === 2, 'a failing widget leaves no empty tile behind');

  // The fonts come with the page.
  check(document.fonts.check('600 16px "Bricolage Grotesque"') && document.fonts.check('500 16px "IBM Plex Mono"') && document.fonts.check('400 16px "IBM Plex Sans"') && document.fonts.check('600 16px "Barlow Condensed"'), 'the embedded fonts are loaded');
  check(performance.getEntriesByType('resource').every(function (entry) { return entry.name.indexOf('http') !== 0; }), 'the page requested nothing from the network');
  document.getElementById('result').textContent = JSON.stringify({ failures: failures });
})();
</script>`;
  const dir = mkdtempSync(join(tmpdir(), 'open-dock-web-widgets-'));
  // The headless Edge profile is ~400 MB; remove it however the run ends.
  process.on('exit', () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = join(dir, 'page.html');
  writeFileSync(file, html.replace('<body>', '<body><pre id="result">running</pre>' + harness).replace('</body>', driver + '</body>'));
  const dom = execFileSync(browser, [...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=30000', '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] });
  const raw = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(raw && raw !== 'running', 'the widget page check did not finish');
  const result = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')) as { failures: string[] };
  assert.deepEqual(result.failures, [], `widget page problems:\n${result.failures.join('\n')}`);
  console.log('web widgets: the page announces itself, answers requests, isolates a failing widget and needs no network');
}
console.log(`web widgets: lifecycle cases ok (idle ${IDLE_MS / 1000} s, answer within ${ACK_MS / 1000} s, page ready within ${READY_MS / 1000} s)`);
