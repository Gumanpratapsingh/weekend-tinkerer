// Phone health for the hub header: battery, temperature, uptime. Reads the file the phone's
// status script already writes every minute (phone-server/status.sh); owner-only like every hub route.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from '../core.mjs';

const FILE = join(HOME, 'live', 'status.json');

export default {
  routes: {
    'GET /api/status': () => {
      if (!existsSync(FILE)) return { online: true };
      const s = JSON.parse(readFileSync(FILE, 'utf8'));
      return { online: true, battery: s.battery, charging: s.batteryStatus !== 'Discharging',
        tempC: s.cpuTempC ?? s.batteryTempC, upSince: s.upSince * 1000, updated: s.updated * 1000 };
    },
  },
};
