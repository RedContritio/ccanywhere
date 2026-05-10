import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { DeviceStore } from '../devices/store.js';
import { ProjectStore } from '../projects/store.js';

export const INTERNAL_HOOK_TOKEN = 'h'.repeat(32);
export const CLI_TOKEN = 'c'.repeat(32);

export const baseConfig: Config = {
  port: 7878,
  bindHost: '127.0.0.1',
  claudeBin: 'sh',
  scrollbackBytes: 4096,
  deletedSessionTtlMs: 600_000,
  wsHeartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
  outputFps: 60,
  // Placeholder: each describe block creates a real tmp dir + ProjectStore;
  // buildServer reads from projectStore, not config.projectsRoot.
  projectsRoot: '/tmp/ccanywhere-test-placeholder',
  webOrigin: 'http://localhost:7878',
  cookieName: 'ccanywhere_session',
};

export interface TestProjectsEnv {
  projectsRoot: string;
  projectStore: ProjectStore;
  deviceStore: DeviceStore;
  demoCwd: string;
  /** Cookie header value pre-formatted for `headers.cookie`. */
  authCookie: string;
  /** sessionId extracted from authCookie. */
  sessionId: string;
  cleanup: () => void;
}

export function setupProjects(): TestProjectsEnv {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-projects-'));
  mkdirSync(join(projectsRoot, 'demo'));
  const statePath = join(projectsRoot, '.projects-state.json');
  const projectStore = new ProjectStore({ projectsRoot, statePath });
  const deviceStore = new DeviceStore({
    statePath: join(projectsRoot, '.devices.json'),
  });
  const { sessionId } = deviceStore.__seedActiveDevice('test-device');
  return {
    projectsRoot,
    projectStore,
    deviceStore,
    demoCwd: join(projectsRoot, 'demo'),
    authCookie: `ccanywhere_session=${sessionId}`,
    sessionId,
    cleanup: () => rmSync(projectsRoot, { recursive: true, force: true }),
  };
}
