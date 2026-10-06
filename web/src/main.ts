import './styles.css';

import { startApp } from './app';

const container = document.getElementById('app');
if (container) void startApp(container);
