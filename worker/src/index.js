/**
 * Worker entry: default export only. workerd treats every named export of the entry module as a handler
 * and fails to start on plain values, so all logic (and the test hooks) live in ./relay.js.
 */
import { handleRequest, handleScheduled } from './relay.js';

const log = (obj) => console.log(JSON.stringify(obj));

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env, {});
    } catch (e) {
      log({ level: 'error', msg: 'unhandled', error: String(e?.message ?? e) });
      return new Response('error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  },
  // Cron Triggers (wrangler.toml): dispatch the availability refresh; a failure is logged, the next tick retries.
  async scheduled(event, env, ctx) {
    const run = handleScheduled(event, env, {}).catch((e) => log({ level: 'error', msg: 'cron unhandled', error: String(e?.message ?? e) }));
    if (ctx?.waitUntil) ctx.waitUntil(run);
    else await run;
  },
};
