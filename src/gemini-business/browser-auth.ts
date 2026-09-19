/**
 * Browser-based credential capture for Gemini Business accounts.
 *
 * Launches system Chrome via puppeteer-core, lets the user authenticate,
 * then extracts cookies and intercepts network requests to capture
 * csesidx and team_id automatically.
 */

import fs from 'node:fs';
import puppeteer, { type Page, type HTTPRequest, type Cookie } from 'puppeteer-core';
import * as ChromeLauncher from 'chrome-launcher';
import { BrowserAuthOptions, CapturedCredentials } from './types.js';
import { SsoAuthenticator } from './sso-auth.js';

const GEMINI_BUSINESS_URL = 'https://vertexaisearch.cloud.google';

/**
 * Extra flags Chrome needs inside a container, and nowhere else.
 *
 * A container has no usable user-namespace sandbox (and frequently a small
 * `/dev/shm`), so Chrome exits before painting unless both are relaxed. A
 * desktop host keeps its sandbox: the extra flags are applied only when a
 * container is actually detected, never merely because the process is root.
 */
export function containerArgs(): string[] {
  const inContainer = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  const cgroup = readFileIfPresent('/proc/1/cgroup');
  const detected = inContainer || /(?:docker|containerd|kubepods|podman|lxc)/.test(cgroup);
  return detected ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : [];
}

function readFileIfPresent(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const DEFAULT_OPTIONS: Required<BrowserAuthOptions> = {
  timeout: 10 * 60 * 1000,       // 10 minutes
  reminderDelay: 5 * 60 * 1000,  // 5 minutes
  pollInterval: 2000,             // 2 seconds
  name: '',
  sso: {},
  headless: false,
  executablePath: '',
  disableSso: false,
};

export class BrowserAuth {
  private options: Required<BrowserAuthOptions>;

  constructor(options?: BrowserAuthOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      // `CHROME_PATH` lets a container point at a binary chrome-launcher cannot discover.
      executablePath: options?.executablePath || process.env.CHROME_PATH || '',
    };
  }

  /**
   * Find system Chrome/Chromium installation.
   * Throws a descriptive error if not found.
   */
  findChrome(): string {
    if (this.options.executablePath) {
      return this.options.executablePath;
    }

    const installations = ChromeLauncher.Launcher.getInstallations();

    if (installations.length === 0) {
      throw new Error(
        '❌ Google Chrome not found on this system.\n\n' +
        '  Install Chrome: https://www.google.com/chrome/\n\n' +
        '  Or point CHROME_PATH at an existing Chrome/Chromium binary.'
      );
    }

    return installations[0];
  }

  /**
   * Launch Chrome with a temporary profile and navigate to Gemini Business.
   *
   * Headless is the default for servers: the sign-in flow is driven entirely
   * through the SSO authenticator, so no window has to be visible. Set
   * `headless: false` to watch or to clear a step the automation cannot.
   */
  private async launchBrowser(chromePath: string) {
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: this.options.headless,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        ...containerArgs(),
      ],
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.goto(GEMINI_BUSINESS_URL, { waitUntil: 'networkidle2' });

    return { browser, page };
  }

  /**
   * Poll cookies until login is detected.
   * Returns captured cookies, null on timeout, or the sign-in failure that made
   * waiting pointless.
   */
  private waitForCookies(
    page: Page,
    signal: AbortSignal,
    failure: () => Error | undefined,
  ): Promise<{ secure_c_ses: string; host_c_oses: string } | null | { failure: Error }> {
    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        // Checked before the signal so a rejection is reported, not a timeout.
        const rejected = failure();
        if (rejected) {
          clearInterval(interval);
          resolve({ failure: rejected });
          return;
        }

        if (signal.aborted) {
          clearInterval(interval);
          resolve(null);
          return;
        }

        try {
          const cookies = await page.cookies(GEMINI_BUSINESS_URL);
          const secureCses = cookies.find((c: Cookie) => c.name === '__Secure-C_SES');
          const hostCoses = cookies.find((c: Cookie) => c.name === '__Host-C_OSES');

          if (secureCses && hostCoses) {
            clearInterval(interval);
            resolve({
              secure_c_ses: secureCses.value,
              host_c_oses: hostCoses.value,
            });
          }
        } catch {
          // Page may have been closed
          clearInterval(interval);
          resolve(null);
        }
      }, this.options.pollInterval);
    });
  }

  /**
   * Set up request interception to capture csesidx and team_id.
   */
  private setupRequestInterception(page: Page): {
    getCaptured: () => { csesidx: string | null; team_id: string | null };
  } {
    let csesidx: string | null = null;
    let team_id: string | null = null;

    page.on('request', (request: HTTPRequest) => {
      const url = request.url();

      // Capture csesidx from getoxsrf request
      if (url.includes('getoxsrf') && !csesidx) {
        try {
          const parsed = new URL(url);
          const value = parsed.searchParams.get('csesidx');
          if (value) {
            csesidx = value;
          }
        } catch {
          // Ignore URL parse errors
        }
      }

      // Capture team_id (configId). The widget API exposes it in the body of
      // every workspace call, not only widgetCreateSession — and the app fires
      // widgetGetSession/widgetListSessions on load without ever creating one.
      if (url.includes('discoveryengine.googleapis.com') && !team_id) {
        try {
          const postData = request.postData();
          if (postData) {
            const body = JSON.parse(postData);
            if (typeof body.configId === 'string' && body.configId) {
              team_id = body.configId;
            }
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
    });

    return {
      getCaptured: () => ({ csesidx, team_id }),
    };
  }

  /**
   * Main orchestrator: launch browser, wait for login, capture credentials.
   */
  async captureCredentials(
    onStatus?: (message: string) => void,
  ): Promise<CapturedCredentials> {
    const log = onStatus || (() => {});

    // Find Chrome
    const chromePath = this.findChrome();
    log('🚀 Launching Chrome...');

    // Launch browser
    const { browser, page } = await this.launchBrowser(chromePath);

    // Capture User-Agent
    const userAgent = await page.evaluate('navigator.userAgent') as string;

    // Set up request interception
    const { getCaptured } = this.setupRequestInterception(page);

    // Drive the Workforce Identity Federation sign-in when requested: the
    // broker asks for a provider name before the IdP form ever appears.
    //
    // A rejected sign-in (bad password, unknown account, failed MFA) can never
    // succeed by waiting, so it aborts the whole capture instead of burning the
    // timeout — at startup that timeout is paid per account.
    let ssoFailure: Error | undefined;
    if (!this.options.disableSso) {
      const sso = new SsoAuthenticator({ ...this.options.sso, timeout: this.options.timeout });
      void sso.authenticate(page, log).catch((error) => {
        ssoFailure = error instanceof Error ? error : new Error(String(error));
        log(`\n${ssoFailure.message}`);
      });
    }

    // Set up abort controller for timeout
    const controller = new AbortController();
    const { signal } = controller;

    // Overall timeout
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.options.timeout);

    // Handle browser close
    let browserClosed = false;
    browser.on('disconnected', () => {
      browserClosed = true;
      controller.abort();
    });

    try {
      log('🔑 Waiting for login... Please sign in to Gemini Business in the browser window.');

      // Phase 1: Wait for cookies (login detection)
      const outcome = await this.waitForCookies(page, signal, () => ssoFailure);

      if (outcome && 'failure' in outcome) {
        // A rejected sign-in cannot be fixed by waiting, so report it now.
        throw outcome.failure;
      }

      if (!outcome) {
        if (browserClosed) {
          throw new Error('Browser closed before login completed.');
        }
        throw new Error('Timeout — login not detected within the time limit. Check GEMINI_SSO_EMAIL and GEMINI_SSO_PASSWORD, or run `npm run gemini -- login --no-sso` to sign in by hand.');
      }

      const cookies = outcome;
      log('✅ Logged in! Waiting for the workspace id...');

      // Phase 2: Wait for a request carrying configId (team_id).
      const reminderTimeout = setTimeout(() => {
        log('⏳ Still waiting... open the Gemini Business chat so the workspace id can be read.');
      }, this.options.reminderDelay);

      const networkResult = await new Promise<{ csesidx: string; team_id: string }>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          const rejected = ssoFailure;
          if (rejected) {
            clearInterval(checkInterval);
            clearTimeout(reminderTimeout);
            reject(rejected);
            return;
          }

          if (signal.aborted) {
            clearInterval(checkInterval);
            clearTimeout(reminderTimeout);
            if (browserClosed) {
              reject(new Error('Browser closed before all credentials were captured.'));
            } else {
              reject(new Error('Timeout — could not capture all credentials. Run `npm run gemini -- login --no-sso` to sign in by hand.'));
            }
            return;
          }

          const captured = getCaptured();
          if (captured.csesidx && captured.team_id) {
            clearInterval(checkInterval);
            clearTimeout(reminderTimeout);
            resolve({ csesidx: captured.csesidx, team_id: captured.team_id });
          }
        }, this.options.pollInterval);
      });

      // Close browser
      clearTimeout(timeoutId);
      await browser.close();

      return {
        cookies,
        csesidx: networkResult.csesidx,
        team_id: networkResult.team_id,
        user_agent: userAgent,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      try {
        await browser.close();
      } catch {
        // Browser may already be closed
      }
      throw error;
    }
  }
}
