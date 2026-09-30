#!/usr/bin/env node
/**
 * TEST DOUBLE for llama-server (SIMULATED; no model). Parses the same flags, requires the API key, and
 * answers /health, /props and /v1/chat/completions. FAKE_LLAMA_MODE picks the behaviour:
 *   ok (default) | wrong_build | no_vision | bad_json | bad_answer | extra_key | length | crash_after_start | slow | exit_now
 * FAKE_LLAMA_ANSWER sets the answer for 'ok'. The last request body is written to FAKE_LLAMA_LOG if set.
 */
const http = require('http');
const fs = require('fs');
const a = process.argv.slice(2);
const arg = (k) => a[a.indexOf(k) + 1];
const mode = process.env.FAKE_LLAMA_MODE || 'ok';
if (mode === 'exit_now') process.exit(3);
const key = arg('--api-key');
const model = arg('-m');
const server = http.createServer((req, res) => {
  const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/health') return send(200, { status: 'ok' });
  if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { message: 'Invalid API Key' } });
  if (req.url === '/props') {
    return send(200, { build_info: mode === 'wrong_build' ? 'b1-0000000' : 'b1-eae11d2', model_path: model, modalities: { vision: mode !== 'no_vision', audio: false } });
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (process.env.FAKE_LLAMA_LOG) fs.writeFileSync(process.env.FAKE_LLAMA_LOG, body);
    const content = {
      ok: JSON.stringify({ answer: process.env.FAKE_LLAMA_ANSWER || 'yes', reason: 'SIMULATED reason' }),
      bad_json: 'yes, there is',
      bad_answer: JSON.stringify({ answer: 'maybe', reason: 'x' }),
      extra_key: JSON.stringify({ answer: 'yes', reason: 'x', score: 1 }),
      length: JSON.stringify({ answer: 'yes', reason: 'x' }),
      slow: JSON.stringify({ answer: 'no', reason: 'late' }),
    }[mode] || JSON.stringify({ answer: 'yes', reason: 'x' });
    const reply = () => send(200, { choices: [{ finish_reason: mode === 'length' ? 'length' : 'stop', message: { role: 'assistant', content } }] });
    if (mode === 'slow') setTimeout(reply, 400);
    else reply();
    if (mode === 'crash_after_start') setTimeout(() => process.exit(9), 10);
  });
});
server.listen(Number(arg('--port')), arg('--host'));
process.on('SIGTERM', () => process.exit(0));
