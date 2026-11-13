// Info widgets (weather, news, stocks, ...) and their designs. The phone draws them (phone-app/src/info-widgets.tsx)
// and the PC checks the same lists (src-tauri/src/lib.rs info_styles, INFO_LEAGUES, INFO_DONE).

export type InfoOptions = { style?: string; city?: string; symbols?: string; league?: string; items?: string[]; done?: string };

/** Each face's designs: id, name, what it looks like. The first is the default. */
export const INFO_STYLES: Record<string, [string, string, string][]> = {
  weather: [['classic', 'Classic', 'Now plus the next days'], ['hero', 'Hero', 'One big temperature'], ['minimal', 'Minimal', 'Temperature and city on one line']],
  news: [['list', 'List', 'Headlines to scroll'], ['headline', 'Headline', 'One big story at a time'], ['compact', 'Compact', 'Short single-line headlines']],
  stocks: [['list', 'List', 'Rows of prices'], ['tiles', 'Tiles', 'A coloured card per symbol'], ['ticker', 'Ticker', 'One big price at a time']],
  sports: [['list', 'List', 'Rows of scores'], ['cards', 'Cards', 'One big game at a time'], ['compact', 'Compact', 'Scores only']],
  countdown: [['number', 'Number', 'Big day count'], ['units', 'Units', 'Days, hours and minutes'], ['minimal', 'Minimal', 'One line']],
  timer: [['classic', 'Classic', 'Big digits and presets'], ['ring', 'Ring', 'Digits inside a progress ring'], ['minimal', 'Minimal', 'Digits only, tap to start']],
  reminders: [['list', 'List', 'A tick-off list'], ['cards', 'Cards', 'Each reminder on a card'], ['compact', 'Compact', 'What is next and how many are left']],
  quote: [['classic', 'Classic', 'Centred quote'], ['bold', 'Bold', 'Large type with an accent bar'], ['minimal', 'Minimal', 'Small and quiet']],
};
export const infoStyles = (face?: string) => INFO_STYLES[face ?? 'quote'] ?? INFO_STYLES.quote;

export const INFO_CITIES = ['London', 'New York', 'San Francisco', 'Los Angeles', 'Toronto', 'Mexico City', 'São Paulo', 'Paris', 'Berlin', 'Madrid', 'Rome', 'Amsterdam', 'Stockholm', 'Istanbul', 'Dubai', 'Mumbai', 'Delhi', 'Bengaluru', 'Chennai', 'Singapore', 'Hong Kong', 'Shanghai', 'Seoul', 'Tokyo', 'Sydney', 'Auckland', 'Cairo', 'Lagos', 'Nairobi', 'Johannesburg'];

export const INFO_STOCK_PRESETS: [string, string][] = [
  ['Big tech', 'AAPL, MSFT, GOOGL, AMZN, NVDA'],
  ['Crypto', 'BTC-USD, ETH-USD, SOL-USD, XRP-USD'],
  ['US indices', '^GSPC, ^DJI, ^IXIC'],
  ['India', '^NSEI, ^BSESN, RELIANCE.NS, TCS.NS, INFY.NS'],
  ['Europe', '^FTSE, ^GDAXI, ^FCHI'],
  ['Asia', '^N225, ^HSI, 000001.SS'],
  ['Currencies', 'EURUSD=X, GBPUSD=X, USDJPY=X, USDINR=X'],
  ['Commodities', 'GC=F, SI=F, CL=F'],
];

export const INFO_LEAGUES: [string, string][] = [['nba', 'NBA'], ['nfl', 'NFL'], ['epl', 'Premier League'], ['laliga', 'La Liga'], ['ucl', 'Champions League'], ['mlb', 'MLB'], ['nhl', 'NHL']];
export const INFO_DONE: [string, string][] = [['show', 'Keep in place'], ['bottom', 'Move to the bottom'], ['hide', 'Hide']];
