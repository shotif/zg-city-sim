import './styles.css';

import { startApp } from './app';
import { installWebGpuCompat } from './webgpuCompat';

installWebGpuCompat();

const container = document.getElementById('app');
if (container) void startApp(container);
