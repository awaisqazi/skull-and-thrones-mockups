/**
 * Worker entry: default export only. workerd treats every named export of the entry module as a handler
 * and fails to start on plain values, so all logic (and the test hooks) live in ./relay.js.
 */
import { handleRequest } from './relay.js';

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
};
