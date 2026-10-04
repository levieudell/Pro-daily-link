'use strict';

const { performance } = require('node:perf_hooks');
const http=require('node:http');
const https=require('node:https');

const urlArgument=process.argv.find(value=>value.startsWith('--url='));
const target = String(process.env.PDL_LOAD_TARGET || (urlArgument&&urlArgument.slice(6)) || process.argv[2] || 'http://127.0.0.1:4173').replace(/\/$/, '');
const requests = Math.max(1, Math.min(5000, Number(process.env.PDL_LOAD_REQUESTS || 200)));
const concurrency = Math.max(1, Math.min(100, Number(process.env.PDL_LOAD_CONCURRENCY || 20)));
const paths = ['/landing.html', '/login.html', '/api/health'];
const timings = [];
let next = 0;
let failures = 0;

function request(url){return new Promise((resolve,reject)=>{const client=url.startsWith('https:')?https:http,req=client.get(url,{timeout:15_000,headers:{'user-agent':'pdl-reliability-load-test/1.0'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode||0))});req.on('timeout',()=>req.destroy(new Error('Request timed out')));req.on('error',reject)})}

async function worker() {
  while (next < requests) {
    const index = next++;
    const started = performance.now();
    try {
      const status = await request(`${target}${paths[index % paths.length]}`);
      if (status >= 500 || status === 0) failures += 1;
    } catch (error) {
      failures += 1;
    } finally {
      timings.push(performance.now() - started);
    }
  }
}

(async () => {
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  timings.sort((a, b) => a - b);
  const percentile = value => timings[Math.min(timings.length - 1, Math.floor(timings.length * value))] || 0;
  const elapsed = performance.now() - started;
  const result = { target, requests, concurrency, failures, errorRate: failures / requests, requestsPerSecond: Math.round(requests / (elapsed / 1000) * 10) / 10, p50Ms: Math.round(percentile(0.5)), p95Ms: Math.round(percentile(0.95)), p99Ms: Math.round(percentile(0.99)) };
  console.log(JSON.stringify(result, null, 2));
  if (result.errorRate > 0.01 || result.p95Ms > 3000) process.exitCode = 1;
})();
