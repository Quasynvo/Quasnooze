/** One location policy for setup and runtime. Resolution never writes state. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { normalizeBrandEnv } from './brand-config.js';

export function resolveStatePaths({ root, env = process.env, platform = process.platform,
  home = homedir(), clone = existsSync(join(root, '.git')) } = {}) {
  env = normalizeBrandEnv(env);
  const path = platform === 'win32' ? win32 : posix;
  const absolute = (value) => value && path.isAbsolute(value);
  let stateHome = env.PINCH_STATE_HOME;
  if (stateHome && !absolute(stateHome)) throw new Error('STATE_HOME must be an absolute path');
  if (!stateHome && clone) stateHome = root;
  if (!stateHome) {
    const base = platform === 'win32'
      ? (absolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(home, 'AppData', 'Local'))
      : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
        : (absolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state'));
    stateHome = path.join(base, 'quasnooze');
  }
  return Object.freeze({ stateHome, envPath: (stateHome === root ? join : path.join)(stateHome, '.env'),
    dataDir: env.PINCH_DATA || (stateHome === root ? join : path.join)(stateHome, 'data') });
}

export function assertNoLegacyState(root, paths) {
  if (existsSync(join(paths.stateHome, '.migration-in-progress'))) {
    throw new Error('State migration incomplete; originals preserved. Stop all instances and inspect the destination.');
  }
  if (paths.stateHome !== root && !existsSync(paths.envPath) && !existsSync(join(paths.stateHome, "data")) &&
      (existsSync(join(root, '.env')) || existsSync(join(root, 'data')))) {
    throw new Error('Legacy package state found. Stop Quasnooze and run quasnooze migrate-state to preview migration.');
  }
}
