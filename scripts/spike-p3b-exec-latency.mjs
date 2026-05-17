import { execSync } from 'node:child_process';

const CTN = 'p3b-exec-test';
const IMAGE = process.env.P3B_IMAGE ?? 'python:3.13-slim';
const N = Number(process.env.P3B_N ?? 10);

console.log(`# P3.5: docker exec latency into long-running container`);
console.log(`# image: ${IMAGE}, container: ${CTN}, runs: ${N}\n`);

try {
  execSync(`docker rm -f ${CTN}`, { stdio: 'ignore' });
} catch {
  // ignore
}
execSync(`docker run -d --name ${CTN} ${IMAGE} sleep 3600`);

try {
  const times = [];
  for (let i = 0; i < N; i++) {
    const start = process.hrtime.bigint();
    execSync(`docker exec ${CTN} true`, { stdio: 'ignore' });
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    times.push(ms);
    process.stdout.write(`exec ${(i + 1).toString().padStart(2)}: ${ms.toFixed(0)}ms\n`);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((s, t) => s + t, 0);
  const p = (q) => times[Math.min(N - 1, Math.floor(N * q))].toFixed(0);
  console.log(`\nexec stats:`);
  console.log(`  min   : ${times[0].toFixed(0)}ms`);
  console.log(`  p50   : ${p(0.5)}ms`);
  console.log(`  p90   : ${p(0.9)}ms`);
  console.log(`  p99   : ${p(0.99)}ms`);
  console.log(`  max   : ${times[N - 1].toFixed(0)}ms`);
  console.log(`  avg   : ${(sum / N).toFixed(0)}ms`);
} finally {
  execSync(`docker rm -f ${CTN}`, { stdio: 'ignore' });
}
