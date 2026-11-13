import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CheckCircle2, Circle as Unchecked, Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Pause, Play, RotateCcw, Settings2, Sun, Trash2 } from 'lucide-react-native';
import Storage from 'expo-sqlite/kv-store';
import Svg, { Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Pressable } from './motion';
import { haptic } from './prefs';
import { useStyles, useTheme, type Colors } from './theme';

// Glanceable deck tiles. Each reads its own data: weather, news, stocks and scores come straight from free,
// key-less public sources, so the PC does not need to be connected. What you type (city, symbols, ...) stays on this phone.

const store = {
  read<T>(key: string, fallback: T): T {
    try { const raw = Storage.getItemSync(`opendock.info.${key}`); return raw === null ? fallback : { ...fallback, ...JSON.parse(raw) } as T; } catch { return fallback; }
  },
  write(key: string, value: unknown) { try { Storage.setItemSync(`opendock.info.${key}`, JSON.stringify(value)); } catch { /* lasts until the app closes */ } },
};
function useSaved<T extends object>(key: string, fallback: T): [T, (patch: Partial<T>) => void] {
  const [value, setValue] = useState(() => store.read(key, fallback));
  return [value, (patch) => setValue((old) => { const next = { ...old, ...patch }; store.write(key, next); return next; })];
}

async function getText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (OpenDock)' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}
const getJson = async (url: string) => JSON.parse(await getText(url)) as Record<string, any>;  

/** Runs `load` now and every `every` ms while `on`; `key` restarts it when the question changes. */
function useRemote<T>(load: () => Promise<T>, key: string, every: number, on: boolean) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => {
    if (!on) return;
    let live = true;
    const run = () => loadRef.current().then((data) => { if (live) setState({ data }); }).catch((error: unknown) => { if (live) setState((old) => ({ data: old.data, error: error instanceof Error ? error.message : 'Failed' })); });
    run();
    const id = setInterval(run, every);
    return () => { live = false; clearInterval(id); };
  }, [key, on, tick, every]);
  return { ...state, retry: useCallback(() => { setState({}); setTick((value) => value + 1); }, []) };
}

/** Set on the PC: the design, and what weather, stocks, sports and reminders tiles show (over what was typed on the phone). */
export type InfoOptions = { style?: string; city?: string; symbols?: string; league?: string; items?: string[]; done?: string };
const NO_OPTIONS: InfoOptions = {};
const Options = createContext<InfoOptions>(NO_OPTIONS);

// The tile's size, so each face fits whatever size the tile is resized to.
const Size = createContext({ width: 240, height: 170 });
/** Font scale for the tile: 1 at a 2×2-ish tile, smaller or larger as it is resized. */
const useScale = () => { const { width, height } = useContext(Size); return Math.max(0.6, Math.min(2.4, width / 240, height / 170)); };

function Shell({ title, onEdit, editing, children }: { title: string; onEdit?: () => void; editing?: boolean; children: React.ReactNode }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { height } = useContext(Size);
  return <View style={styles.shell}>
    {height < 80 ? null : <View style={styles.head}>
      <Text style={styles.title} numberOfLines={1}>{title}</Text>
      {onEdit ? <Pressable style={[styles.gear, editing && { backgroundColor: colors.pressed }]} onPress={() => { haptic.select(); onEdit(); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Edit ${title}`}><Settings2 size={14} color={colors.muted} /></Pressable> : null}
    </View>}
    <View style={styles.body}>{children}</View>
  </View>;
}

function Field({ label, value, placeholder, onSave, keyboard }: { label: string; value: string; placeholder: string; onSave: (value: string) => void; keyboard?: 'default' | 'numbers-and-punctuation' }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [text, setText] = useState(value);
  return <TextInput value={text} onChangeText={setText} onSubmitEditing={() => onSave(text.trim())} onEndEditing={() => onSave(text.trim())} placeholder={placeholder} placeholderTextColor={colors.faint} style={styles.input} autoCapitalize="none" autoCorrect={false} returnKeyType="done" keyboardType={keyboard ?? 'default'} accessibilityLabel={label} />;
}

function Status({ error, retry, hint }: { error?: string; retry: () => void; hint?: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  if (!error) return <View style={styles.center}><ActivityIndicator color={colors.muted} /></View>;
  return <View style={styles.center}>
    <Text style={styles.muted}>{hint ?? 'Can’t reach the internet'}</Text>
    <Pressable style={styles.chip} onPress={retry} accessibilityRole="button"><Text style={styles.chipText}>Retry</Text></Pressable>
  </View>;
}

function Chips({ options, value, onPick }: { options: string[]; value: number; onPick: (index: number) => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  if (useContext(Size).height < 120) return null;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled style={styles.chipScroll} contentContainerStyle={styles.chips}>{options.map((name, index) => <Pressable key={name} style={[styles.chip, index === value && { backgroundColor: colors.pressed }]} onPress={() => { haptic.select(); onPick(index); }} accessibilityRole="button" accessibilityState={{ selected: index === value }}>
    <Text style={[styles.chipText, index === value && { color: colors.text }]}>{name}</Text>
  </Pressable>)}</ScrollView>;
}

// --- Weather -------------------------------------------------------------------------------------------------

const WEATHER: [number, string, typeof Sun][] = [[0, 'Clear', Sun], [2, 'Partly cloudy', CloudSun], [3, 'Cloudy', Cloud], [48, 'Fog', CloudFog], [57, 'Drizzle', CloudRain], [67, 'Rain', CloudRain], [77, 'Snow', CloudSnow], [82, 'Showers', CloudRain], [86, 'Snow showers', CloudSnow], [99, 'Thunderstorm', CloudLightning]];
const weatherOf = (code: number) => WEATHER.find(([max]) => code <= max) ?? WEATHER[2];
type Forecast = { place: string; now: number; feels: number; code: number; wind: number; days: { day: string; code: number; high: number; low: number }[] };

async function loadWeather(city: string): Promise<Forecast> {
  const place = (await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)).results?.[0];
  if (!place) throw new Error('city');
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5`);
  return {
    place: place.name, now: Math.round(data.current.temperature_2m), feels: Math.round(data.current.apparent_temperature), code: data.current.weather_code, wind: Math.round(data.current.wind_speed_10m),
    days: (data.daily.time as string[]).map((date, index) => ({ day: new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }), code: data.daily.weather_code[index], high: Math.round(data.daily.temperature_2m_max[index]), low: Math.round(data.daily.temperature_2m_min[index]) })),
  };
}

/** Shows one of `count` items at a time: a tap moves on, and it moves on by itself every `every` ms. */
function usePage(count: number, every = 7000): [number, () => void] {
  const [index, setIndex] = useState(0);
  useEffect(() => { if (count < 2) return; const id = setInterval(() => setIndex((value) => (value + 1) % count), every); return () => clearInterval(id); }, [count, every]);
  return [count ? index % count : 0, () => setIndex((value) => (value + 1) % Math.max(1, count))];
}

function Weather({ on }: { on: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const options = useContext(Options);
  const [config, save] = useSaved('weather', { city: '' });
  const city = options.city ?? config.city;
  const [editing, setEditing] = useState(!city);
  const scale = useScale();
  const { height } = useContext(Size);
  const style = options.style ?? 'classic';
  const { data, error, retry } = useRemote(() => loadWeather(city), city, 15 * 60_000, on && !!city);
  const body = (editing && !options.city) || !city
    ? <View style={styles.center}><Text style={styles.muted}>Your city</Text><Field label="City" value={config.city} placeholder="e.g. London" onSave={(value) => { save({ city: value }); if (value) setEditing(false); }} /></View>
    : error === 'city' ? <View style={styles.center}><Text style={styles.muted}>No city called “{city}”</Text></View>
    : !data ? <Status error={error} retry={retry} />
    : (() => {
      const [, label, Icon] = weatherOf(data.code);
      if (style === 'hero') return <View style={styles.center}>
        <Icon size={Math.round(36 * scale)} color={colors.muted} />
        <Text style={[styles.huge, { fontSize: Math.round(64 * scale), lineHeight: Math.round(70 * scale) }]}>{data.now}°</Text>
        <Text style={styles.muted} numberOfLines={1}>{label} · H {data.days[0]?.high}° L {data.days[0]?.low}°</Text>
      </View>;
      if (style === 'minimal') return <View style={[styles.center, styles.row]}>
        <Icon size={Math.round(28 * scale)} color={colors.text} />
        <Text style={[styles.big, { fontSize: Math.round(36 * scale) }]}>{data.now}°</Text>
        <Text style={styles.small} numberOfLines={1}>{data.place}</Text>
      </View>;
      return <View style={styles.fill}>
        <View style={styles.row}><Icon size={Math.round(44 * scale)} color={colors.text} /><View style={styles.grow}><Text style={[styles.big, { fontSize: Math.round(34 * scale) }]}>{data.now}°</Text><Text style={styles.muted} numberOfLines={1}>{label} · feels {data.feels}° · {data.wind} km/h</Text></View></View>
        {height < 150 ? null : <View style={styles.days}>{data.days.map((day, index) => { const DayIcon = weatherOf(day.code)[2]; return <View key={day.day} style={[styles.day, index === 0 && styles.today]}><Text style={styles.faint}>{day.day}</Text><DayIcon size={18} color={colors.muted} /><Text style={styles.small}>{day.high}°</Text><Text style={styles.faint}>{day.low}°</Text></View>; })}</View>}
      </View>;
    })();
  const title = style === 'minimal' ? '' : data && !editing ? data.place : 'Weather';
  return <Shell title={title} onEdit={options.city ? undefined : () => setEditing(!editing)} editing={editing}>{body}</Shell>;
}

// --- News ----------------------------------------------------------------------------------------------------

const FEEDS: [string, string][] = [['BBC', 'https://feeds.bbci.co.uk/news/rss.xml'], ['Hacker News', 'https://hnrss.org/frontpage'], ['The Verge', 'https://www.theverge.com/rss/index.xml'], ['NASA', 'https://www.nasa.gov/feed/']];
const decode = (text: string) => text.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))).trim();
type Story = { title: string; link: string };
async function loadNews(url: string): Promise<Story[]> {
  const xml = await getText(url);
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? [];
  return blocks.slice(0, 20).flatMap((block): Story[] => {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1];
    const link = /<link[^>]*href="([^"]+)"/.exec(block)?.[1] ?? /<link[^>]*>([\s\S]*?)<\/link>/.exec(block)?.[1];
    return title && link ? [{ title: decode(title), link: decode(link) }] : [];
  });
}
const openLink = (link: string) => { haptic.select(); if (/^https?:\/\//.test(link)) Linking.openURL(link).catch(() => undefined); };

function News({ on }: { on: boolean }) {
  const styles = useStyles(makeStyles);
  const scale = useScale();
  const style = useContext(Options).style ?? 'list';
  const [config, save] = useSaved('news', { feed: 0 });
  const feed = Math.min(config.feed, FEEDS.length - 1);
  const { data, error, retry } = useRemote(() => loadNews(FEEDS[feed][1]), String(feed), 10 * 60_000, on);
  const [page, next] = usePage(data?.length ?? 0, 8000);
  const story = data?.[page];
  return <Shell title={style === 'headline' ? FEEDS[feed][0] : 'News'}>
    {style === 'headline' ? null : <Chips options={FEEDS.map(([name]) => name)} value={feed} onPick={(index) => save({ feed: index })} />}
    {!data ? <Status error={error} retry={retry} />
      : style === 'headline' ? <Pressable style={styles.pageArea} onPress={next} onLongPress={() => { if (story) openLink(story.link); }} accessibilityRole="button" accessibilityHint="Tap for the next story, hold to read">
        <Text style={[styles.headline, { fontSize: Math.round(18 * scale), lineHeight: Math.round(24 * scale) }]} numberOfLines={5}>{story?.title}</Text>
        <Text style={styles.faint}>{page + 1} / {data.length} · hold to read</Text>
      </Pressable>
      : <ScrollView style={styles.fill} showsVerticalScrollIndicator={false} nestedScrollEnabled>
        {data.map((item, index) => <Pressable key={`${index}-${item.link}`} style={style === 'compact' ? styles.storyCompact : styles.story} onPress={() => openLink(item.link)} accessibilityRole="link">
          <Text style={style === 'compact' ? styles.small : styles.storyText} numberOfLines={style === 'compact' ? 1 : 2}>{item.title}</Text>
        </Pressable>)}
      </ScrollView>}
  </Shell>;
}

// --- Stocks & crypto -----------------------------------------------------------------------------------------

type Quote = { symbol: string; price: number; change: number; currency: string };
async function loadQuotes(symbols: string[]): Promise<Quote[]> {
  return Promise.all(symbols.map(async (symbol): Promise<Quote> => {
    const meta = (await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`)).chart?.result?.[0]?.meta;
    if (!meta) return { symbol, price: NaN, change: 0, currency: '' };
    const previous = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice;
    return { symbol, price: meta.regularMarketPrice, change: previous ? ((meta.regularMarketPrice - previous) / previous) * 100 : 0, currency: meta.currency ?? '' };
  }));
}
const UP = '#1f9d57';
const price = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 4 : 2 });
const percent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

function Stocks({ on }: { on: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const scale = useScale();
  const options = useContext(Options);
  const style = options.style ?? 'list';
  const [config, save] = useSaved('stocks', { symbols: 'AAPL, MSFT, BTC-USD' });
  const [editing, setEditing] = useState(false);
  const symbols = (options.symbols ?? config.symbols).split(/[,\s]+/).map((symbol) => symbol.toUpperCase()).filter((symbol) => /^[A-Z0-9.=^-]{1,12}$/.test(symbol)).slice(0, 8);
  const { data, error, retry } = useRemote(() => loadQuotes(symbols), symbols.join(), 60_000, on && symbols.length > 0);
  const [page, next] = usePage(data?.length ?? 0);
  const tone = (quote: Quote) => (quote.change >= 0 ? UP : colors.red);
  let body;
  if (editing && !options.symbols) body = <View style={styles.center}><Text style={styles.muted}>Symbols, comma separated (AAPL, BTC-USD, ^GSPC)</Text><Field label="Symbols" value={config.symbols} placeholder="AAPL, MSFT, BTC-USD" onSave={(value) => { save({ symbols: value }); }} /></View>;
  else if (!data) body = <Status error={error} retry={retry} />;
  else if (style === 'ticker') {
    const quote = data[page];
    body = quote ? <Pressable style={styles.pageArea} onPress={next} accessibilityRole="button" accessibilityHint="Tap for the next symbol">
      <Text style={styles.symbol}>{quote.symbol}</Text>
      <Text style={[styles.huge, { fontSize: Math.round(40 * scale) }]} numberOfLines={1} adjustsFontSizeToFit>{Number.isFinite(quote.price) ? price(quote.price) : '—'}</Text>
      <Text style={[styles.change, { color: tone(quote), fontSize: Math.round(14 * scale) }]}>{quote.change >= 0 ? '▲' : '▼'} {percent(quote.change)}</Text>
      <Text style={styles.faint}>{page + 1} / {data.length}</Text>
    </Pressable> : null;
  } else if (style === 'tiles') body = <ScrollView style={styles.fill} contentContainerStyle={styles.tiles} showsVerticalScrollIndicator={false} nestedScrollEnabled>
    {data.map((quote) => <View key={quote.symbol} style={[styles.tile, { backgroundColor: quote.change >= 0 ? 'rgba(31,157,87,0.16)' : 'rgba(214,69,69,0.16)' }]}>
      <Text style={styles.symbol} numberOfLines={1}>{quote.symbol}</Text>
      <Text style={[styles.small, { fontSize: Math.round(15 * scale) }]} numberOfLines={1}>{Number.isFinite(quote.price) ? price(quote.price) : 'Unknown'}</Text>
      <Text style={[styles.change, { color: tone(quote) }]}>{percent(quote.change)}</Text>
    </View>)}
  </ScrollView>;
  else body = <ScrollView style={styles.fill} showsVerticalScrollIndicator={false} nestedScrollEnabled>{data.map((quote) => <View key={quote.symbol} style={styles.quoteRow}>
    <Text style={styles.symbol}>{quote.symbol}</Text>
    {Number.isFinite(quote.price) ? <><Text style={[styles.small, styles.grow, { textAlign: 'right' }]}>{price(quote.price)}</Text><Text style={[styles.change, styles.pill, { color: tone(quote), backgroundColor: quote.change >= 0 ? 'rgba(31,157,87,0.16)' : 'rgba(214,69,69,0.16)' }]}>{percent(quote.change)}</Text></> : <Text style={styles.faint}>Unknown symbol</Text>}
  </View>)}</ScrollView>;
  return <Shell title="Markets" onEdit={options.symbols ? undefined : () => setEditing(!editing)} editing={editing}>{body}</Shell>;
}

// --- Sports --------------------------------------------------------------------------------------------------

const LEAGUES: [string, string, string][] = [['nba', 'NBA', 'basketball/nba'], ['nfl', 'NFL', 'football/nfl'], ['epl', 'Premier League', 'soccer/eng.1'], ['laliga', 'La Liga', 'soccer/esp.1'], ['ucl', 'Champions League', 'soccer/uefa.champions'], ['mlb', 'MLB', 'baseball/mlb'], ['nhl', 'NHL', 'hockey/nhl']];
type Game = { id: string; home: string; away: string; homeScore: string; awayScore: string; status: string };
async function loadGames(path: string): Promise<Game[]> {
  const data = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
  return ((data.events ?? []) as Record<string, any>[]).slice(0, 12).flatMap((event): Game[] => {  
    const teams = event.competitions?.[0]?.competitors as Record<string, any>[] | undefined;  
    const home = teams?.find((team) => team.homeAway === 'home'), away = teams?.find((team) => team.homeAway === 'away');
    return home && away ? [{ id: String(event.id), home: home.team?.abbreviation ?? '?', away: away.team?.abbreviation ?? '?', homeScore: home.score ?? '', awayScore: away.score ?? '', status: event.status?.type?.shortDetail ?? '' }] : [];
  });
}

function Sports({ on }: { on: boolean }) {
  const styles = useStyles(makeStyles);
  const scale = useScale();
  const options = useContext(Options);
  const style = options.style ?? 'list';
  const [config, save] = useSaved('sports', { leagueId: 'nba' });
  const league = LEAGUES.find(([id]) => id === (options.league ?? config.leagueId)) ?? LEAGUES[0];
  const { data, error, retry } = useRemote(() => loadGames(league[2]), league[0], 60_000, on);
  const [page, next] = usePage(data?.length ?? 0);
  const game = data?.[page];
  const fixed = Boolean(options.league) || style !== 'list';
  return <Shell title={fixed ? league[1] : 'Scores'}>
    {fixed ? null : <Chips options={LEAGUES.map(([, name]) => name)} value={LEAGUES.indexOf(league)} onPick={(index) => save({ leagueId: LEAGUES[index][0] })} />}
    {!data ? <Status error={error} retry={retry} /> : data.length === 0 ? <View style={styles.center}><Text style={styles.muted}>No games today</Text></View>
      : style === 'cards' && game ? <Pressable style={styles.pageArea} onPress={next} accessibilityRole="button" accessibilityHint="Tap for the next game">
        <View style={[styles.row, { gap: 18 * scale }]}>
          <View style={styles.team}><Text style={styles.muted}>{game.away}</Text><Text style={[styles.huge, { fontSize: Math.round(40 * scale) }]}>{game.awayScore || '–'}</Text></View>
          <Text style={styles.faint}>at</Text>
          <View style={styles.team}><Text style={styles.muted}>{game.home}</Text><Text style={[styles.huge, { fontSize: Math.round(40 * scale) }]}>{game.homeScore || '–'}</Text></View>
        </View>
        <Text style={styles.faint} numberOfLines={1}>{game.status} · {page + 1} / {data.length}</Text>
      </Pressable>
      : <ScrollView style={styles.fill} showsVerticalScrollIndicator={false} nestedScrollEnabled>{data.map((item) => style === 'compact'
        ? <View key={item.id} style={styles.compactRow}><Text style={styles.small}>{item.away} {item.awayScore}</Text><Text style={styles.small}>{item.home} {item.homeScore}</Text></View>
        : <View key={item.id} style={styles.quoteRow}>
          <Text style={styles.symbol}>{item.away} {item.awayScore}</Text><Text style={styles.faint}>at</Text><Text style={styles.symbol}>{item.home} {item.homeScore}</Text><Text style={styles.faint} numberOfLines={1}>{item.status}</Text>
        </View>)}</ScrollView>}
  </Shell>;
}

// --- Countdown -----------------------------------------------------------------------------------------------

function Countdown() {
  const styles = useStyles(makeStyles);
  const scale = useScale();
  const style = useContext(Options).style ?? 'number';
  const [config, save] = useSaved('countdown', { title: '', date: '' });
  const [editing, setEditing] = useState(!config.date);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  const target = /^\d{4}-\d{2}-\d{2}$/.test(config.date) ? new Date(`${config.date}T00:00:00`).getTime() : NaN;
  const today = new Date(now).setHours(0, 0, 0, 0);
  const days = Number.isNaN(target) ? null : Math.round((target - today) / 86_400_000);
  const name = config.title || 'Countdown';
  const words = days === null ? '' : days === 0 ? 'Today' : days > 0 ? (days === 1 ? 'day to go' : 'days to go') : (days === -1 ? 'day ago' : 'days ago');
  let body;
  if (editing || days === null) body = <View style={styles.center}>
    <Field label="Event name" value={config.title} placeholder="Event name" onSave={(title) => save({ title })} />
    <Field label="Date" value={config.date} placeholder="YYYY-MM-DD" keyboard="numbers-and-punctuation" onSave={(date) => { save({ date }); if (/^\d{4}-\d{2}-\d{2}$/.test(date)) setEditing(false); }} />
  </View>;
  else if (style === 'units') {
    const left = Math.max(0, target - now);
    const parts: [number, string][] = [[Math.floor(left / 86_400_000), 'days'], [Math.floor((left % 86_400_000) / 3_600_000), 'hrs'], [Math.floor((left % 3_600_000) / 60_000), 'min']];
    body = <View style={[styles.center, styles.row, { gap: 16 * scale }]}>{parts.map(([value, unit]) => <View key={unit} style={styles.team}>
      <Text style={[styles.huge, { fontSize: Math.round(36 * scale) }]}>{String(value).padStart(unit === 'days' ? 1 : 2, '0')}</Text><Text style={styles.faint}>{unit}</Text>
    </View>)}</View>;
  } else if (style === 'minimal') body = <View style={styles.center}><Text style={[styles.small, { fontSize: Math.round(15 * scale) }]} numberOfLines={2}><Text style={{ fontWeight: '700' }}>{Math.abs(days)} {words}</Text> · {name}</Text></View>;
  else body = <View style={styles.center}>
    <Text style={[styles.huge, { fontSize: Math.round(48 * scale) }]}>{Math.abs(days)}</Text>
    <Text style={styles.muted}>{words}</Text>
  </View>;
  return <Shell title={style === 'minimal' && !editing ? '' : name} onEdit={() => setEditing(!editing)} editing={editing}>{body}</Shell>;
}

// --- Timer ---------------------------------------------------------------------------------------------------

const clock = (ms: number) => { const total = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`; };
const PRESETS = [1, 5, 10, 25, 60];
function Timer() {
  const styles = useStyles(makeStyles);
  const scale = useScale();
  const { colors } = useTheme();
  const { width, height } = useContext(Size);
  const style = useContext(Options).style ?? 'classic';
  const [minutes, setMinutes] = useState(5);
  const [run, setRun] = useState<{ endsAt: number | null; left: number }>({ endsAt: null, left: 5 * 60_000 });
  const [now, setNow] = useState(() => Date.now());
  const running = run.endsAt !== null;
  useEffect(() => {
    if (run.endsAt === null) return;
    const end = run.endsAt;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= end) { haptic.impact(Haptics.ImpactFeedbackStyle.Heavy); setRun({ endsAt: null, left: minutes * 60_000 }); }
    }, 250);
    return () => clearInterval(id);
  }, [run.endsAt, minutes]);
  const left = run.endsAt === null ? run.left : Math.max(0, run.endsAt - now);
  const toggle = () => { haptic.select(); const t = Date.now(); setNow(t); setRun(running ? { endsAt: null, left } : { endsAt: t + (left > 0 ? left : minutes * 60_000), left: 0 }); };
  const reset = () => { haptic.select(); setRun({ endsAt: null, left: minutes * 60_000 }); };
  const choose = (value: number) => { setMinutes(value); setRun({ endsAt: null, left: value * 60_000 }); };
  const digits = (size: number) => <Text style={[styles.huge, { fontSize: Math.round(size * scale) }]} numberOfLines={1} adjustsFontSizeToFit>{clock(left)}</Text>;
  if (style === 'minimal') return <Shell title="">
    <Pressable style={styles.pageArea} onPress={toggle} onLongPress={reset} accessibilityRole="button" accessibilityLabel={running ? 'Pause timer' : 'Start timer'} accessibilityHint="Hold to reset">
      {digits(56)}<Text style={styles.faint}>{running ? 'tap to pause · hold to reset' : 'tap to start · hold to reset'}</Text>
    </Pressable>
  </Shell>;
  if (style === 'ring') {
    const size = Math.max(60, Math.min(width, height - 40) - 8);
    const stroke = Math.max(4, size / 16), radius = (size - stroke) / 2, around = 2 * Math.PI * radius;
    const done = 1 - left / (minutes * 60_000);
    return <Shell title="Timer">
      <View style={styles.center}>
        <Pressable onPress={toggle} onLongPress={reset} accessibilityRole="button" accessibilityLabel={running ? 'Pause timer' : 'Start timer'} accessibilityHint="Hold to reset" style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
            <Circle cx={size / 2} cy={size / 2} r={radius} stroke={colors.border} strokeWidth={stroke} fill="none" />
            <Circle cx={size / 2} cy={size / 2} r={radius} stroke={colors.accent} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${around} ${around}`} strokeDashoffset={around * (1 - Math.min(1, Math.max(0, done)))} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
          </Svg>
          <Text style={[styles.huge, { fontSize: Math.round(size / 4.5) }]} numberOfLines={1} adjustsFontSizeToFit>{clock(left)}</Text>
          <Text style={styles.faint}>{minutes} min</Text>
        </Pressable>
      </View>
    </Shell>;
  }
  return <Shell title="Timer">
    <Chips options={PRESETS.map(String)} value={PRESETS.indexOf(minutes)} onPick={(index) => choose(PRESETS[index])} />
    <View style={styles.center}>
      {digits(44)}
      <View style={styles.row}>
        <Pressable style={styles.round} onPress={toggle} accessibilityRole="button" accessibilityLabel={running ? 'Pause' : 'Start'}>{running ? <Pause size={18} color={colors.text} /> : <Play size={18} color={colors.text} />}</Pressable>
        <Pressable style={styles.round} onPress={reset} accessibilityRole="button" accessibilityLabel="Reset"><RotateCcw size={18} color={colors.text} /></Pressable>
      </View>
    </View>
  </Shell>;
}

// --- Reminders -----------------------------------------------------------------------------------------------

type Reminder = { id: string; text: string; done: boolean };
function Reminders() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const scale = useScale();
  const options = useContext(Options);
  const style = options.style ?? 'list';
  // Reminders typed here are kept on the phone; ones set on the PC come with the deck, and only their ticks are kept here.
  const [config, save] = useSaved<{ items: Reminder[]; ticked: string[] }>('reminders', { items: [], ticked: [] });
  const [text, setText] = useState('');
  const fromPc: Reminder[] = (options.items ?? []).map((item) => ({ id: `pc:${item}`, text: item, done: config.ticked.includes(`pc:${item}`) }));
  const all = [...fromPc, ...config.items];
  const shown = options.done === 'hide' ? all.filter((item) => !item.done) : options.done === 'bottom' ? [...all.filter((item) => !item.done), ...all.filter((item) => item.done)] : all;
  const toggle = (item: Reminder) => {
    haptic.select();
    if (item.id.startsWith('pc:')) save({ ticked: item.done ? config.ticked.filter((id) => id !== item.id) : [...config.ticked, item.id].slice(-50) });
    else save({ items: config.items.map((entry) => entry.id === item.id ? { ...entry, done: !entry.done } : entry) });
  };
  const add = () => { const value = text.trim().slice(0, 80); if (!value) return; save({ items: [{ id: String(Date.now()), text: value, done: false }, ...config.items].slice(0, 50) }); setText(''); };
  const remove = (item: Reminder) => { haptic.select(); save({ items: config.items.filter((entry) => entry.id !== item.id) }); };
  if (style === 'compact') {
    const open = all.filter((item) => !item.done);
    return <Shell title="Reminders">
      <Pressable style={styles.pageArea} onPress={() => { if (open[0]) toggle(open[0]); }} accessibilityRole="button" accessibilityHint="Tap to tick off the next reminder">
        <Text style={[styles.huge, { fontSize: Math.round(44 * scale) }]}>{open.length}</Text>
        <Text style={styles.muted} numberOfLines={2}>{open.length ? `left · next: ${open[0].text}` : 'All done'}</Text>
      </Pressable>
    </Shell>;
  }
  return <Shell title="Reminders">
    <TextInput value={text} onChangeText={setText} onSubmitEditing={add} placeholder="Add a reminder" placeholderTextColor={colors.faint} style={styles.input} returnKeyType="done" accessibilityLabel="Add a reminder" />
    <ScrollView style={styles.fill} contentContainerStyle={style === 'cards' ? { gap: 6 } : undefined} showsVerticalScrollIndicator={false} nestedScrollEnabled keyboardShouldPersistTaps="handled">
      {shown.length === 0 ? <Text style={styles.muted}>Nothing to do</Text> : shown.map((item) => <View key={item.id} style={style === 'cards' ? styles.reminderCard : styles.quoteRow}>
        <Pressable style={[styles.grow, styles.row, { gap: 8 }]} onPress={() => toggle(item)} accessibilityRole="checkbox" accessibilityState={{ checked: item.done }}>
          {item.done ? <CheckCircle2 size={16} color={colors.accent} /> : <Unchecked size={16} color={colors.faint} />}
          <Text style={[styles.storyText, styles.grow, item.done && { textDecorationLine: 'line-through', color: colors.faint }]} numberOfLines={2}>{item.text}</Text>
        </Pressable>
        {item.id.startsWith('pc:') ? null : <Pressable style={styles.gear} onPress={() => remove(item)} accessibilityRole="button" accessibilityLabel={`Delete ${item.text}`}><Trash2 size={14} color={colors.muted} /></Pressable>}
      </View>)}
    </ScrollView>
  </Shell>;
}

// --- Quote ---------------------------------------------------------------------------------------------------

const QUOTES: [string, string][] = [
  ['The best way out is always through.', 'Robert Frost'], ['What we think, we become.', 'Buddha'], ['Well begun is half done.', 'Aristotle'],
  ['Simplicity is the ultimate sophistication.', 'Leonardo da Vinci'], ['Stay hungry, stay foolish.', 'Stewart Brand'], ['Do or do not. There is no try.', 'Yoda'],
  ['It always seems impossible until it is done.', 'Nelson Mandela'], ['Make it work, make it right, make it fast.', 'Kent Beck'], ['Premature optimization is the root of all evil.', 'Donald Knuth'],
  ['Programs must be written for people to read.', 'Harold Abelson'], ['The only way to do great work is to love what you do.', 'Steve Jobs'], ['Fall seven times, stand up eight.', 'Japanese proverb'],
  ['Action is the foundational key to all success.', 'Pablo Picasso'], ['Quality is not an act, it is a habit.', 'Will Durant'], ['A journey of a thousand miles begins with a single step.', 'Lao Tzu'],
  ['Done is better than perfect.', 'Sheryl Sandberg'], ['Small deeds done are better than great deeds planned.', 'Peter Marshall'], ['Discipline is choosing between what you want now and what you want most.', 'Abraham Lincoln'],
  ['The details are not the details. They make the design.', 'Charles Eames'], ['Energy and persistence conquer all things.', 'Benjamin Franklin'], ['Not all those who wander are lost.', 'J. R. R. Tolkien'],
  ['If you want to go fast, go alone. If you want to go far, go together.', 'African proverb'], ['Perfection is achieved when there is nothing left to take away.', 'Antoine de Saint-Exupéry'], ['Move fast and fix things.', 'Anonymous'],
  ['First, solve the problem. Then, write the code.', 'John Johnson'], ['Whether you think you can or you think you can’t, you’re right.', 'Henry Ford'], ['You miss 100% of the shots you don’t take.', 'Wayne Gretzky'],
  ['Everything should be made as simple as possible, but no simpler.', 'Albert Einstein'], ['The future depends on what you do today.', 'Mahatma Gandhi'], ['Courage is grace under pressure.', 'Ernest Hemingway'], ['Nothing great was ever achieved without enthusiasm.', 'Ralph Waldo Emerson'],
];
function QuoteTile() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const scale = useScale();
  const style = useContext(Options).style ?? 'classic';
  const [day] = useState(() => Math.floor(Date.now() / 86_400_000));
  const [text, who] = QUOTES[day % QUOTES.length];
  if (style === 'bold') return <Shell title=""><View style={[styles.boldQuote, { borderLeftColor: colors.accent }]}>
    <Text style={[styles.quoteBold, { fontSize: Math.round(22 * scale), lineHeight: Math.round(27 * scale) }]} adjustsFontSizeToFit numberOfLines={6}>{text}</Text>
    <Text style={styles.muted}>{who}</Text>
  </View></Shell>;
  if (style === 'minimal') return <Shell title=""><View style={styles.center}>
    <Text style={[styles.quote, { fontSize: Math.round(12 * scale), lineHeight: Math.round(17 * scale), fontStyle: 'italic', color: colors.muted }]} adjustsFontSizeToFit numberOfLines={5}>“{text}”</Text>
    <Text style={styles.faint}>{who}</Text>
  </View></Shell>;
  return <Shell title="Quote of the day"><View style={styles.center}><Text style={[styles.quote, { fontSize: Math.round(16 * scale), lineHeight: Math.round(22 * scale) }]} adjustsFontSizeToFit numberOfLines={6}>“{text}”</Text><Text style={styles.muted}>{who}</Text></View></Shell>;
}

// --- The widget ----------------------------------------------------------------------------------------------

/** One deck tile; `face` says which (weather, news, stocks, sports, countdown, timer, reminders or quote) and `info` its design and options. */
export function InfoWidget({ face, info, focused }: { face?: string; info?: InfoOptions; focused: boolean }) {
  const [size, setSize] = useState({ width: 240, height: 170 });
  return <View style={{ flex: 1, width: '100%' }} onLayout={(event) => { const { width, height } = event.nativeEvent.layout; setSize({ width, height }); }}>
    <Size.Provider value={size}><Options.Provider value={info ?? NO_OPTIONS}><InfoFace face={face} focused={focused} /></Options.Provider></Size.Provider>
  </View>;
}

function InfoFace({ face, focused }: { face?: string; focused: boolean }) {
  switch (face) {
    case 'weather': return <Weather on={focused} />;
    case 'news': return <News on={focused} />;
    case 'stocks': return <Stocks on={focused} />;
    case 'sports': return <Sports on={focused} />;
    case 'countdown': return <Countdown />;
    case 'timer': return <Timer />;
    case 'reminders': return <Reminders />;
    case 'quote': return <QuoteTile />;
    default: return <QuoteTile />;
  }
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  shell: { flex: 1, width: '100%' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 30 },
  title: { flex: 1, color: colors.muted, fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' },
  gear: { width: 30, height: 30, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  pill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  today: { borderRadius: 6, backgroundColor: colors.bg },
  body: { flex: 1, gap: 6 },
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  big: { color: colors.text, fontSize: 34, fontWeight: '300', fontVariant: ['tabular-nums'] },
  huge: { color: colors.text, fontSize: 44, fontWeight: '300', fontVariant: ['tabular-nums'] },
  small: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  muted: { color: colors.muted, fontSize: 12 },
  faint: { color: colors.faint, fontSize: 11 },
  days: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  day: { alignItems: 'center', gap: 3, flex: 1 },
  chipScroll: { flexGrow: 0 },
  chips: { flexDirection: 'row', gap: 4 },
  chip: { minHeight: 28, paddingHorizontal: 9, borderRadius: 5, justifyContent: 'center', backgroundColor: colors.bg },
  chipText: { color: colors.muted, fontSize: 11 },
  input: { minHeight: 36, minWidth: 160, paddingHorizontal: 10, borderRadius: 5, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, color: colors.text, fontSize: 13 },
  story: { paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  storyText: { color: colors.text, fontSize: 13, lineHeight: 17 },
  quoteRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 34, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  symbol: { color: colors.text, fontSize: 13, fontWeight: '600' },
  change: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  pageArea: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  headline: { color: colors.text, fontWeight: '600', textAlign: 'center', paddingHorizontal: 6 },
  storyCompact: { paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tile: { flexGrow: 1, flexBasis: '45%', minWidth: 0, borderRadius: 8, padding: 8, gap: 2 },
  team: { alignItems: 'center' },
  compactRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  reminderCard: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 38, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.bg },
  boldQuote: { flex: 1, justifyContent: 'center', gap: 6, borderLeftWidth: 4, paddingLeft: 12 },
  quoteBold: { color: colors.text, fontWeight: '700' },
  quote: { color: colors.text, fontSize: 16, lineHeight: 22, textAlign: 'center', paddingHorizontal: 8 },
});
