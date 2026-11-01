import { afterEach, describe, expect, it } from 'vitest';

import { Cities, FIRST_CITY, LINK_CITY, cityKey, cleanName, useCity } from '../src/game/cities';

function memory(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    clear: () => store.clear(),
  } as Storage;
}

afterEach(() => useCity(FIRST_CITY));

describe('cities kept in the browser', () => {
  it('asks on the first visit, and keeps the city kept before as the first, in Sandbox', () => {
    expect(new Cities(memory()).current()).toBeUndefined();
    const storage = memory();
    storage.setItem('zg-city-sim:edits', '{"version":1,"edits":[]}');
    const cities = new Cities(storage);
    expect(cities.list()).toMatchObject([{ id: FIRST_CITY, name: 'Zagreb', mode: 'sandbox' }]);
    expect(cities.current()?.id).toBe(FIRST_CITY);
    // Its parts stay under the old keys.
    expect(cityKey('edits', FIRST_CITY)).toBe('zg-city-sim:edits');
    expect(cityKey('budget')).toBe('zg-city-sim:budget');
  });

  it('keeps each city apart, and plays the one chosen', () => {
    const storage = memory();
    const cities = new Cities(storage);
    const a = cities.create('  Novi   Zagreb ', 'career');
    const b = cities.create('', 'reality');
    expect([a.name, b.name]).toEqual(['Novi Zagreb', 'Zagreb']);
    expect(cityKey('edits', a.id)).toBe(`zg-city-sim:city:${a.id}:edits`);
    cities.setCurrent(b.id);
    expect(new Cities(storage).current()?.id).toBe(b.id);
    useCity(a.id);
    expect(cityKey('zoning')).toBe(`zg-city-sim:city:${a.id}:zoning`);
    storage.setItem(cityKey('zoning'), 'strokes');
    cities.rename(a.id, 'Sesvete');
    expect(cities.get(a.id)?.name).toBe('Sesvete');
    // Deleted with everything it kept.
    cities.remove(a.id);
    expect(cities.get(a.id)).toBeUndefined();
    expect(storage.getItem(`zg-city-sim:city:${a.id}:zoning`)).toBeNull();
    // A city played and since deleted: the question again.
    cities.setCurrent(a.id);
    expect(cities.current()).toBeUndefined();
  });

  it('counts the simulated days a city has reached from its budget', () => {
    const storage = memory();
    const cities = new Cities(storage);
    const city = cities.create('Zagreb', 'career');
    expect(cities.day(city.id)).toBe(1);
    storage.setItem(
      cityKey('budget', city.id),
      JSON.stringify({
        version: 1,
        balance: 0,
        spent: 0,
        history: [
          [0, 1],
          [2.4, 3],
        ],
      }),
    );
    expect(cities.day(city.id)).toBe(3);
  });

  it('saves a city to a file and loads it again as a new one', () => {
    const storage = memory();
    const cities = new Cities(storage);
    const city = cities.create('Dubrava', 'career');
    storage.setItem(cityKey('edits', city.id), 'edits');
    storage.setItem(cityKey('growth', city.id), '[]');
    const text = cities.exportCity(city.id);
    const copy = cities.importCity(text);
    expect(copy).toMatchObject({ name: 'Dubrava (2)', mode: 'career', created: city.created });
    expect(copy.id).not.toBe(city.id);
    expect(storage.getItem(cityKey('edits', copy.id))).toBe('edits');
    expect(storage.getItem(cityKey('zoning', copy.id))).toBeNull();
    expect(() => cities.importCity('{"format":"something else"}')).toThrow();
    expect(() => cities.importCity('not json')).toThrow();
  });

  it('opens a link in a Reality city of its own, started afresh each time', () => {
    const storage = memory();
    const cities = new Cities(storage);
    const mine = cities.create('Zagreb', 'career');
    cities.setCurrent(mine.id);
    storage.setItem(cityKey('edits', LINK_CITY), 'old edits');
    const link = cities.linkCity();
    expect(link).toMatchObject({ id: LINK_CITY, mode: 'reality' });
    expect(storage.getItem(cityKey('edits', LINK_CITY))).toBeNull();
    expect(cities.current()?.id).toBe(mine.id);
    expect(cities.list().filter((c) => c.id === LINK_CITY)).toHaveLength(1);
  });

  it('lasts the visit where storage is blocked', () => {
    const cities = new Cities(undefined);
    const city = cities.create('Zagreb', 'sandbox');
    expect(cities.list()).toEqual([city]);
    expect(cities.current()).toEqual(city);
    expect(cleanName('x'.repeat(60))).toHaveLength(40);
  });
});
