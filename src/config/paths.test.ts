import { describe, expect, it } from 'vitest';
import { resolveConfigDir } from './paths.js';

describe('resolveConfigDir', () => {
  it('falls back to dirname of the config file when configDir not set', () => {
    expect(resolveConfigDir({}, '/Users/me/.config/ccanywhere/config.json')).toBe(
      '/Users/me/.config/ccanywhere',
    );
    expect(
      resolveConfigDir({}, '/Users/me/.config/ccanywhere-staging/config.json'),
    ).toBe('/Users/me/.config/ccanywhere-staging');
  });

  it('honors explicit absolute configDir', () => {
    expect(
      resolveConfigDir(
        { configDir: '/var/lib/ccanywhere-staging' },
        '/etc/ccanywhere/config.json',
      ),
    ).toBe('/var/lib/ccanywhere-staging');
  });

  it('resolves relative configDir against the config file dir', () => {
    expect(
      resolveConfigDir(
        { configDir: '../other-state' },
        '/Users/me/.config/ccanywhere/config.json',
      ),
    ).toBe('/Users/me/.config/other-state');
  });

  it('treats empty-string configDir as unset (uses dirname fallback)', () => {
    expect(
      resolveConfigDir({ configDir: '' }, '/some/where/config.json'),
    ).toBe('/some/where');
  });
});
