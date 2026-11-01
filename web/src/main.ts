import './styles.css';

import { startApp } from './app';
import { Cities, useCity } from './game/cities';
import { chooseCity } from './ui/citiesPanel';
import { installWebGpuCompat } from './webgpuCompat';

installWebGpuCompat();

/** The city to play (M19a): a link with edits opens them in Reality, apart from the
 * player's cities; else the city played last, or, on the first visit, one made now. */
async function start(container: HTMLElement): Promise<void> {
  const cities = new Cities();
  const fromLink = /[#&]edits=/.test(location.hash);
  const city = fromLink
    ? cities.linkCity()
    : (cities.current() ?? (await chooseCity(container, cities)));
  useCity(city.id);
  cities.touch(city.id);
  await startApp(container, { cities, city });
}

const container = document.getElementById('app');
if (container) void start(container);
