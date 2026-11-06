// Test helper: raw HTTP requests with a chosen Host header.
import { request } from 'node:http';

/** One request with a Host header of our choosing (fetch does not let a page, or us, set it). host '' sends none. */
export function raw(port, path, { host, method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, setHost: host === undefined, headers: { ...headers, ...(host ? { host } : {}) } }, (res) => {
      if (String(res.headers['content-type']).startsWith('text/event-stream')) { res.destroy(); return done({ status: res.statusCode }); }
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => done({ status: res.statusCode, text }));
    });
    req.on('error', fail);
    req.end(body);
  });
}
