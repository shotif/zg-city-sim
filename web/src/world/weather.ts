/**
 * The weather (M6b): DHMZ's hourly observations for Zagreb, copied every 15 minutes to the
 * repository's `live-data` branch (.github/workflows/live-data.yml), or the weather the
 * player picks; how each kind looks and how it changes driving (sim/src/weather.rs).
 */

export const LIVE_WEATHER_URL =
  import.meta.env.VITE_LIVE_WEATHER_URL ??
  'https://raw.githubusercontent.com/shotif/zg-city-sim/live-data/weather.json';

/** DHMZ asks to be named wherever its data is shown. */
export const WEATHER_CREDIT = {
  name: 'DHMZ, Državni hidrometeorološki zavod',
  text: 'Weather observations in Zagreb (vrijeme.hr, hourly), copied every 15 minutes. Otvorena dozvola.',
  url: 'https://meteo.hr',
};

export type WeatherKind =
  'clear' | 'cloudy' | 'overcast' | 'rain' | 'heavyRain' | 'storm' | 'snow' | 'heavySnow' | 'fog';

export interface WeatherLook {
  label: string;
  /** Cloud: 0 clear sky, 1 overcast (dims the sun, greys the sky). */
  cloud: number;
  /** What falls, and how much (0-1). */
  falling?: 'rain' | 'snow';
  amount: number;
  /** Haze at the point looked at (0 none, 1 hidden): rain, snow and fog fade the view to
   * the sky's colour, more the further away. */
  haze: number;
  /** Wet or snowy roads. */
  wet: boolean;
  /** Factors on driving (sim/src/weather.rs presets). */
  driving: { speed: number; headway: number; accel: number };
}

const CLEAR = { speed: 1, headway: 1, accel: 1 };
const RAIN = { speed: 0.95, headway: 1.1, accel: 0.95 };
const HEAVY_RAIN = { speed: 0.92, headway: 1.2, accel: 0.9 };
const SNOW = { speed: 0.87, headway: 1.15, accel: 0.85 };
const HEAVY_SNOW = { speed: 0.65, headway: 1.4, accel: 0.65 };
const FOG = { speed: 0.9, headway: 1.15, accel: 1 };

export const WEATHER: Record<WeatherKind, WeatherLook> = {
  clear: { label: 'Clear', cloud: 0, amount: 0, haze: 0, wet: false, driving: CLEAR },
  cloudy: { label: 'Partly cloudy', cloud: 0.4, amount: 0, haze: 0, wet: false, driving: CLEAR },
  overcast: { label: 'Overcast', cloud: 0.85, amount: 0, haze: 0.05, wet: false, driving: CLEAR },
  rain: { label: 'Rain', cloud: 0.9, falling: 'rain', amount: 0.5, haze: 0.12, wet: true, driving: RAIN },
  heavyRain: { label: 'Heavy rain', cloud: 1, falling: 'rain', amount: 1, haze: 0.25, wet: true, driving: HEAVY_RAIN },
  storm: { label: 'Thunderstorm', cloud: 1, falling: 'rain', amount: 1, haze: 0.25, wet: true, driving: HEAVY_RAIN },
  snow: { label: 'Snow', cloud: 0.9, falling: 'snow', amount: 0.5, haze: 0.2, wet: true, driving: SNOW },
  heavySnow: { label: 'Heavy snow', cloud: 1, falling: 'snow', amount: 1, haze: 0.4, wet: true, driving: HEAVY_SNOW },
  fog: { label: 'Fog', cloud: 0.9, amount: 0, haze: 0.55, wet: false, driving: FOG },
}; // prettier-ignore

/** The kind of weather DHMZ's words describe ("vedro", "pretežno oblačno", "slaba kiša",
 * "jak snijeg", "magla"…). */
export function classify(text: string): WeatherKind {
  const t = text.toLocaleLowerCase('hr');
  const strong = /\bjak|\bjaka|\bjaki|\bobiln/.test(t);
  if (/grmljavin|tuča|tuc/.test(t)) return 'storm';
  if (/snijeg|snije|susnježic|susnjezic/.test(t)) return strong ? 'heavySnow' : 'snow';
  if (/kiš|kis|pljus|rosulj|sipin/.test(t)) return strong ? 'heavyRain' : 'rain';
  if (/magl|nebo nevidljivo/.test(t)) return 'fog';
  if (/potpuno oblačno|potpuno oblacno|^oblačno|^oblacno/.test(t)) return 'overcast';
  if (/oblačno|oblacno/.test(t)) return 'cloudy';
  return 'clear';
}

export interface Station {
  name: string;
  temperature: number | null;
  wind: number | null;
  weather: string;
}

export interface WeatherFeed {
  source: string;
  fetched: string;
  /** "dd.mm.yyyy hh:00", Zagreb time. */
  observed: string;
  stations: Station[];
}

export interface LiveWeather {
  kind: WeatherKind;
  /** DHMZ's words, the station, its temperature (°C) and the hour observed. */
  text: string;
  station: string;
  temperature: number | null;
  observed: string;
}

/** The weather in the city centre (Zagreb-Grič, else the first Zagreb station). */
export function liveWeather(feed: WeatherFeed): LiveWeather | undefined {
  const station = feed.stations.find((s) => s.name === 'Zagreb-Grič') ?? feed.stations[0];
  if (!station) return undefined;
  return {
    kind: classify(station.weather),
    text: station.weather,
    station: station.name,
    temperature: station.temperature,
    observed: feed.observed,
  };
}

export async function loadWeather(url = LIVE_WEATHER_URL): Promise<WeatherFeed> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return (await response.json()) as WeatherFeed;
}

/** A colour (0xrrggbb) greyed towards its own brightness by `amount` (0-1). */
export function greyed(color: number, amount: number): number {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  const mix = (c: number) => Math.round(c + (y * 0.92 - c) * amount);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}
