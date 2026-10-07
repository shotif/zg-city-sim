import { describe, expect, it } from 'vitest';

import { WEATHER, classify, greyed, liveWeather } from '../src/world/weather';

describe('the weather', () => {
  it("reads DHMZ's words", () => {
    expect(classify('vedro')).toBe('clear');
    expect(classify('pretežno vedro')).toBe('clear');
    expect(classify('djelomično oblačno')).toBe('cloudy');
    expect(classify('pretežno oblačno')).toBe('cloudy');
    expect(classify('potpuno oblačno')).toBe('overcast');
    expect(classify('oblačno')).toBe('overcast');
    expect(classify('slaba kiša')).toBe('rain');
    expect(classify('rosulja')).toBe('rain');
    expect(classify('pljusak kiše')).toBe('rain');
    expect(classify('jaka kiša')).toBe('heavyRain');
    expect(classify('slab snijeg')).toBe('snow');
    expect(classify('susnježica')).toBe('snow');
    expect(classify('jak snijeg')).toBe('heavySnow');
    expect(classify('magla')).toBe('fog');
    expect(classify('nebo nevidljivo')).toBe('fog');
    expect(classify('grmljavina s kišom')).toBe('storm');
    expect(classify('')).toBe('clear');
  });

  it('takes the city centre’s station from the feed', () => {
    const feed = {
      source: 'DHMZ',
      fetched: '2026-10-07T07:11:36+00:00',
      observed: '07.10.2026 08:00',
      stations: [
        { name: 'Zagreb-Maksimir', temperature: 9.5, wind: 0.2, weather: 'magla' },
        { name: 'Zagreb-Grič', temperature: 11.6, wind: 1, weather: 'slaba kiša' },
      ],
    };
    expect(liveWeather(feed)).toEqual({
      kind: 'rain',
      text: 'slaba kiša',
      station: 'Zagreb-Grič',
      temperature: 11.6,
      observed: '07.10.2026 08:00',
    });
    expect(liveWeather({ ...feed, stations: [] })).toBeUndefined();
  });

  it('drives as the engine’s presets do, and greys the sky under cloud', () => {
    // sim/src/weather.rs: Weather::RAIN, Weather::HEAVY_SNOW.
    expect(WEATHER.rain.driving).toEqual({ speed: 0.95, headway: 1.1, accel: 0.95 });
    expect(WEATHER.heavySnow.driving).toEqual({ speed: 0.65, headway: 1.4, accel: 0.65 });
    expect(WEATHER.clear.driving).toEqual({ speed: 1, headway: 1, accel: 1 });
    expect(greyed(0xb9cfe0, 0)).toBe(0xb9cfe0);
    const grey = greyed(0xb9cfe0, 1);
    expect((grey >> 16) & 255).toBe(grey & 255);
  });
});
