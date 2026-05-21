import { spawn as ptySpawn } from 'node-pty';
import { execSync } from 'node:child_process';

const CTN = 'p4-test-container';
const IMAGE = 'python:3.13-slim';

// preflight: clean any leftover
try {
  execSync(`docker rm -f ${CTN}`, { stdio: 'ignore' });
} catch {
  // ignore
}

console.log('# node-pty + docker exec TTY/resize prototype');
console.log(`# image: ${IMAGE}, container: ${CTN}\n`);

// 1. start long-running container
execSync(`docker run -d --name ${CTN} ${IMAGE} sleep 3600`);
console.log(`[1/5] container started`);

// 2. spawn pty wrapping docker exec
// -i: keep STDIN open (no docker-side tty allocation; node-pty's outer
// pty is what claude inside container sees as TTY when we add -t below)
// -t: allocate docker-side pseudo-tty so stty/tput see proper dims
const proc = ptySpawn('docker', ['exec', '-it', CTN, 'sh'], {
  name: 'xterm-color',
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: process.env,
});

let captured = '';
proc.onData((d) => {
  captured += d;
});

await new Promise((r) => setTimeout(r, 300));
console.log(`[2/5] pty spawned, ${captured.length}B initial`);

// 3. basic echo
proc.write('echo HELLO_FROM_PTY\n');
await new Promise((r) => setTimeout(r, 300));

// 4. stty size at initial cols/rows (100x30)
proc.write('stty size\n');
await new Promise((r) => setTimeout(r, 300));
console.log(`[3/5] initial stty checked`);

// 5. resize to 80x24 + verify
proc.resize(80, 24);
await new Promise((r) => setTimeout(r, 200));
proc.write('stty size\n');
await new Promise((r) => setTimeout(r, 300));
console.log(`[4/5] resize tested`);

// 6. color escape passthrough
proc.write('printf "\\033[31mRED\\033[0m\\n"\n');
await new Promise((r) => setTimeout(r, 300));

// cleanup
proc.kill();
await new Promise((r) => setTimeout(r, 100));
execSync(`docker rm -f ${CTN}`, { stdio: 'ignore' });
console.log(`[5/5] cleanup done\n`);

// analysis
console.log('=== CAPTURED OUTPUT ===');
console.log(captured);
console.log('=== ANALYSIS ===');
console.log('contains HELLO_FROM_PTY:', captured.includes('HELLO_FROM_PTY'));
const sttyMatches = captured.match(/\d+ \d+/g) ?? [];
console.log('stty size matches:', sttyMatches);
console.log('contains red escape:', captured.includes('\x1b[31m'));
console.log('contains "RED" text:', captured.includes('RED'));
console.log('total bytes:', captured.length);

process.exit(0);
