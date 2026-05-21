import { execSync } from 'node:child_process';

const IMAGE = process.env.P3_IMAGE ?? 'python:3.13-slim';
const N = Number(process.env.P3_N ?? 10);
const CMD = `docker run --rm ${IMAGE} true`;

console.log(`# cold start prototype`);
console.log(`# image: ${IMAGE}`);
console.log(`# cmd:   ${CMD}`);
console.log(`# runs:  ${N}\n`);

const times = [];
for (let i = 0; i < N; i++) {
  const start = process.hrtime.bigint();
  execSync(CMD, { stdio: 'ignore' });
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;
  times.push(ms);
  process.stdout.write(`run ${(i + 1).toString().padStart(2)}: ${ms.toFixed(0)}ms\n`);
}

times.sort((a, b) => a - b);
const sum = times.reduce((s, t) => s + t, 0);
const p = (q) => times[Math.min(N - 1, Math.floor(N * q))].toFixed(0);

console.log(`\nstats:`);
console.log(`  min   : ${times[0].toFixed(0)}ms`);
console.log(`  p50   : ${p(0.5)}ms`);
console.log(`  p90   : ${p(0.9)}ms`);
console.log(`  p99   : ${p(0.99)}ms`);
console.log(`  max   : ${times[N - 1].toFixed(0)}ms`);
console.log(`  avg   : ${(sum / N).toFixed(0)}ms`);
console.log(`  range : ${(times[N - 1] - times[0]).toFixed(0)}ms`);
