import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { BrowserAuth, containerArgs } from './browser-auth.js';

// Mock chrome-launcher
vi.mock('chrome-launcher', () => ({
  Launcher: {
    getInstallations: vi.fn(),
  },
}));

// Mock puppeteer-core (not used in findChrome tests, but needed for import)
vi.mock('puppeteer-core', () => ({
  default: { launch: vi.fn() },
}));

import * as ChromeLauncher from 'chrome-launcher';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(ChromeLauncher.Launcher.getInstallations).mockReset();
});

describe('BrowserAuth.findChrome()', () => {
  it('returns Chrome path when found', () => {
    vi.mocked(ChromeLauncher.Launcher.getInstallations).mockReturnValue([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);

    const auth = new BrowserAuth();
    const path = auth.findChrome();
    expect(path).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('throws a descriptive error when Chrome is not found', () => {
    vi.mocked(ChromeLauncher.Launcher.getInstallations).mockReturnValue([]);

    const auth = new BrowserAuth();
    expect(() => auth.findChrome()).toThrow('Google Chrome not found');
  });

  it('error message names the install link and the CHROME_PATH escape hatch', () => {
    vi.mocked(ChromeLauncher.Launcher.getInstallations).mockReturnValue([]);

    const auth = new BrowserAuth();
    expect(() => auth.findChrome()).toThrow('https://www.google.com/chrome/');
    expect(() => auth.findChrome()).toThrow('CHROME_PATH');
  });

  it('returns first installation when multiple found', () => {
    vi.mocked(ChromeLauncher.Launcher.getInstallations).mockReturnValue([
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
    ]);

    const auth = new BrowserAuth();
    expect(auth.findChrome()).toBe('/usr/bin/google-chrome');
  });

  it('prefers an explicit binary over a detected installation', () => {
    vi.mocked(ChromeLauncher.Launcher.getInstallations).mockReturnValue(['/usr/bin/google-chrome']);

    const auth = new BrowserAuth({ executablePath: '/opt/chrome/chrome' });
    expect(auth.findChrome()).toBe('/opt/chrome/chrome');
  });

  it('falls back to CHROME_PATH so a container can point at its own Chrome', () => {
    vi.mocked(ChromeLauncher.Launcher.getInstallations).mockReturnValue([]);
    vi.stubEnv('CHROME_PATH', '/usr/bin/chromium');

    const auth = new BrowserAuth();
    expect(auth.findChrome()).toBe('/usr/bin/chromium');
  });
});

describe('BrowserAuth constructor', () => {
  it('accepts custom timeout options', () => {
    const auth = new BrowserAuth({ timeout: 5000 });
    // Verify it constructs without error
    expect(auth).toBeInstanceOf(BrowserAuth);
  });

  it('accepts empty options', () => {
    const auth = new BrowserAuth();
    expect(auth).toBeInstanceOf(BrowserAuth);
  });
});

describe('containerArgs', () => {
  it('adds the sandbox and shm flags when a container is detected', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    expect(containerArgs()).toEqual(['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']);
  });

  it('leaves a desktop host with its sandbox intact', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    // A normal host cgroup names no container runtime.
    vi.spyOn(fs, 'readFileSync').mockReturnValue('0::/\n');

    expect(containerArgs()).toEqual([]);
  });

  it('detects a container even without /.dockerenv, as under Kubernetes', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('0::/kubepods/burstable/pod123\n');

    expect(containerArgs()).toContain('--no-sandbox');
  });
});
