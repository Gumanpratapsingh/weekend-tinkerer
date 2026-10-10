// Web Push (works for home-screen web apps on iOS 16.4+ and Android). VAPID keys are generated once on
// the phone and kept in ~/cupboard/data/vapid.json; no paid push service is involved.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { DATA, all, run } from './db.mjs';

const KEYS = join(DATA, 'vapid.json');
if (!existsSync(KEYS)) writeFileSync(KEYS, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
const vapid = JSON.parse(readFileSync(KEYS, 'utf8'));
webpush.setVapidDetails('https://cupboard.gumanpratap.workers.dev', vapid.publicKey, vapid.privateKey);

export const publicKey = vapid.publicKey;

export function subscribe(userId, sub) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw Object.assign(new Error('Bad subscription'), { status: 400 });
  run(`INSERT INTO push_subs(endpoint, user_id, sub, created) VALUES(?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, sub = excluded.sub`, sub.endpoint, userId, JSON.stringify(sub), Date.now());
}
export const unsubscribe = (userId, endpoint) => run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', endpoint, userId);
export const hasPush = (userId) => all('SELECT 1 FROM push_subs WHERE user_id = ? LIMIT 1', userId).length > 0;

/** Send {title, body, url, tag} to every device of a user. Dead subscriptions are removed. */
export async function notify(userId, payload) {
  for (const row of all('SELECT * FROM push_subs WHERE user_id = ?', userId)) {
    try {
      await webpush.sendNotification(JSON.parse(row.sub), JSON.stringify(payload), { TTL: 24 * 3600, urgency: 'high' });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subs WHERE endpoint = ?', row.endpoint);
      else console.error(new Date().toISOString(), 'push', e.statusCode || '', e.message);
    }
  }
}
