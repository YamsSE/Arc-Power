// Arc Power - typed renderer wrapper over the preload bridge. The global is
// declared in arcpower.d.ts; this module is the single typed entry point.

import type { ArcPowerApi } from './arcpower.d.ts';

export const api: ArcPowerApi = window.arcPower;
