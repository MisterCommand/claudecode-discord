/**
 * Automated sign-in for Gemini Business accounts behind a Google Workforce
 * Identity Federation provider.
 *
 * Two steps can be driven without a human:
 *   1. `auth.cloud.google/signin` asks for a provider name, formatted
 *      `locations/<location>/workforcePools/<pool>/providers/<provider>`.
 *   2. That provider redirects to the IdP — Microsoft Entra ID here — which
 *      takes an email and a password.
 *
 * Anything past those (MFA, consent, tenant or account pickers) is not
 * scriptable in general, so rather than guessing, the module recognises the
 * prompt, reports it, and hands the window back to the user. It keeps polling,
 * so the run resumes by itself once the human clears the step.
 */

import type { Page } from 'puppeteer-core';
import { createHmac } from 'node:crypto';
import type { SsoOptions } from './types.js';

/** Google's sign-in broker, which hosts the provider-name prompt. */
const GOOGLE_SIGNIN_HOST = 'auth.cloud.google';

/** Where a completed sign-in lands. */
const APP_HOST = 'vertexaisearch.cloud.google';
const APP_ORIGIN = `https://${APP_HOST}`;

/** Provider-name prompt. */
const PROVIDER_INPUT = 'input[name="providerName"]';
const PROVIDER_SUBMIT = 'button[type="submit"]';

/** Microsoft Entra ID (`login.microsoftonline.com`) sign-in form. */
const ENTRA_EMAIL_INPUT = 'input[name="loginfmt"]';
const ENTRA_PASSWORD_INPUT = 'input[name="passwd"]';
const ENTRA_SUBMIT = '#idSIButton9';

/** Authenticator-app code prompt, shown when the tenant enforces MFA. */
const ENTRA_MFA_INPUT = '#idTxtBx_SAOTCC_OTC';
const ENTRA_MFA_SUBMIT = '#idSubmit_SAOTCC_Continue';

/** Tenant configured to front Gemini Business for this deployment. */
export const DEFAULT_SSO_PROVIDER =
  'locations/global/workforcePools/hkust-saml-pool/providers/entra-id-oidc';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;

// `Promise.withResolvers` is Node 22+; the supported floor is Node 18.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hostname of a URL string, or null when it cannot be parsed. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * RFC 6238 code for a base32 authenticator secret, at the current 30-second
 * step. The secret may arrive with spaces, padding or lowercase.
 */
function totp(secret: string, at = Date.now()): string {
  const normalized = secret.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  // Base32 -> bytes, most-significant bit first.
  let bits = '';
  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base32 character in TOTP secret: ${char}`);
    }
    bits += index.toString(2).padStart(5, '0');
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) {
    key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));

  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 1_000_000).padStart(6, '0');
}

/** Visible on-page text, used to recognise prompts that have no stable selector. */
async function visibleText(page: Page): Promise<string> {
  try {
    return (await page.evaluate('document.body ? document.body.innerText : ""')) as string;
  } catch {
    // Navigation can tear the document down mid-evaluate.
    return '';
  }
}

/**
 * Decide what a puppeteer failure means for the run: `closed` when the window
 * is gone for good, `transient` when a navigation merely invalidated the page
 * handle (Microsoft reloads its sign-in page once), null when it is a real
 * error worth reporting.
 */
function classifyBrowserError(error: unknown): 'closed' | 'transient' | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/detached|Target closed|Session closed|Browser closed/i.test(message)) {
    return 'closed';
  }
  if (
    /Execution context was destroyed|Navigating frame|Cannot find context|No node found|No element found for selector/i.test(
      message,
    )
  ) {
    return 'transient';
  }
  return null;
}

/** Types into a field the way a person would, so framework handlers fire. */
async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  await page.click(selector);
  await page.evaluate(
    '(selector) => { const el = document.querySelector(selector); if (el) el.value = ""; }',
    selector,
  );
  await page.type(selector, value, { delay: 20 });
}

export class SsoAuthenticator {
  private readonly provider: string;
  private readonly email?: string;
  private readonly password?: string;
  private readonly totpSecret?: string;
  private readonly teamId?: string;
  private readonly timeout: number;

  constructor(options: SsoOptions = {}) {
    this.provider = options.provider || DEFAULT_SSO_PROVIDER;
    this.email = options.email || process.env.GEMINI_SSO_EMAIL;
    this.password = options.password || process.env.GEMINI_SSO_PASSWORD;
    this.totpSecret = options.totpSecret || process.env.GEMINI_SSO_TOTP_SECRET;
    this.teamId = options.teamId || process.env.GEMINI_SSO_TEAM_ID;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /** Credentials the automation cannot supply by itself. */
  private missingCredentials(): string[] {
    const missing: string[] = [];
    if (!this.email) missing.push('GEMINI_SSO_EMAIL');
    if (!this.password) missing.push('GEMINI_SSO_PASSWORD');
    if (!this.totpSecret) missing.push('GEMINI_SSO_TOTP_SECRET');
    return missing;
  }

  /**
   * Drive the sign-in until the browser leaves the broker, or the timeout
   * expires. Resolves once the account page is reached.
   */
  async authenticate(page: Page, log: (message: string) => void): Promise<void> {
    const deadline = Date.now() + this.timeout;
    let providerSubmitted = false;
    let emailSubmitted = false;
    let passwordSubmitted = false;
    let codeSubmitted = false;
    let announcedHandoff = false;
    let lastUrl = '';

    while (Date.now() < deadline) {
      let url: string;
      try {
        url = page.url();
      } catch {
        throw new Error('Browser closed before sign-in completed.');
      }

      if (url !== lastUrl) {
        lastUrl = url;
        log(`   → ${url}`);
      }

      const host = hostOf(url);

      // Back on the account host and past the broker: sign-in is done. The
      // provider must have been submitted first — the app host is also where
      // the browser starts, before it redirects to the sign-in broker.
      if (providerSubmitted && host === APP_HOST) {
        log('✅ Signed in.');
        await this.openWorkspace(page, log);
        return;
      }

      const error = await this.readError(page);
      if (error) {
        throw new Error(`Sign-in was rejected: ${error}`);
      }

      try {
        if (host === GOOGLE_SIGNIN_HOST && !providerSubmitted) {
          await page.waitForSelector(PROVIDER_INPUT, { visible: true, timeout: 30_000 });
          await typeInto(page, PROVIDER_INPUT, this.provider);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
            page.click(PROVIDER_SUBMIT),
          ]);
          providerSubmitted = true;
          log(`   Submitted provider ${this.provider}`);
          continue;
        }

        if (host === 'login.microsoftonline.com' || host === 'login.microsoft.com') {
          if (!emailSubmitted && (await this.hasSelector(page, ENTRA_EMAIL_INPUT))) {
            if (this.email) {
              await typeInto(page, ENTRA_EMAIL_INPUT, this.email);
              await page.click(ENTRA_SUBMIT);
              emailSubmitted = true;
              log(`   Typed email ${this.email}`);
            } else {
              announcedHandoff = this.handoff(log, announcedHandoff, 'email');
            }
            await sleep(POLL_INTERVAL_MS);
            continue;
          }

          if (!passwordSubmitted && (await this.hasSelector(page, ENTRA_PASSWORD_INPUT))) {
            if (this.password) {
              await typeInto(page, ENTRA_PASSWORD_INPUT, this.password);
              await page.click(ENTRA_SUBMIT);
              passwordSubmitted = true;
              log('   Typed password');
            } else {
              announcedHandoff = this.handoff(log, announcedHandoff, 'password');
            }
            await sleep(POLL_INTERVAL_MS);
            continue;
          }

          // Authenticator-app code, when the tenant enforces MFA.
          if (!codeSubmitted && (await this.hasSelector(page, ENTRA_MFA_INPUT))) {
            if (this.totpSecret) {
              const code = totp(this.totpSecret);
              await typeInto(page, ENTRA_MFA_INPUT, code);
              await page.click(ENTRA_MFA_SUBMIT);
              codeSubmitted = true;
              log('   Typed authenticator code');
            } else {
              announcedHandoff = this.handoff(log, announcedHandoff, 'MFA code');
            }
            await sleep(POLL_INTERVAL_MS);
            continue;
          }

          // MFA, consent or "stay signed in": clear what can be cleared,
          // otherwise leave the rest to the user.
          if (!(await this.answerPrompt(page, log))) {
            announcedHandoff = this.handoff(log, announcedHandoff, 'additional verification');
          }
        }
      } catch (error) {
        const kind = classifyBrowserError(error);
        if (kind === 'closed') {
          throw new Error('Browser closed before sign-in completed.');
        }
        if (kind === null) {
          throw error;
        }
        // Transient: the page navigated out from under the command. Re-read the
        // URL next iteration; the step that failed is simply not yet recorded
        // as submitted, so it is retried against the new document.
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const missing = this.missingCredentials();
    throw new Error(
      'Timed out waiting for sign-in to finish.' +
        (missing.length > 0 ? ` Missing credentials: ${missing.join(', ')}.` : ''),
    );
  }

  /**
   * Clear prompts that need only a click. Returns false when the prompt needs
   * a human, so the caller stops insisting on it.
   */
  private async answerPrompt(page: Page, log: (message: string) => void): Promise<boolean> {
    const text = await visibleText(page);

    if (/stay signed in\?/i.test(text) && (await this.hasSelector(page, ENTRA_SUBMIT))) {
      // "Yes" keeps the session alive inside the throwaway profile.
      await page.click(ENTRA_SUBMIT);
      log('   Answered "Stay signed in?"');
      await sleep(POLL_INTERVAL_MS);
      return true;
    }

    const accept = 'input[type="submit"][value*="Accept" i], button[type="submit"], #idSIButton9';
    if (/(permissions requested|requesting permissions|needs your consent)/i.test(text)) {
      if (await this.hasSelector(page, accept)) {
        await page.click(accept);
        log('   Accepted the consent prompt');
        await sleep(POLL_INTERVAL_MS);
        return true;
      }
    }

    return false;
  }

  /**
   * Open the workspace so the app issues its first `configId`-bearing call.
   * The app root 404s once the broker is done, so without a workspace id the
   * caller would sit waiting for a request the page never makes.
   */
  private async openWorkspace(page: Page, log: (message: string) => void): Promise<void> {
    if (!this.teamId) {
      log('   Workspace id unknown; set GEMINI_SSO_TEAM_ID to open the app automatically.');
      return;
    }

    const target = `${APP_ORIGIN}/home/cid/${this.teamId}`;
    log(`   Opening workspace ${this.teamId}`);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(async (error) => {
      if (classifyBrowserError(error) !== 'transient') {
        log(`   Could not open the workspace: ${error instanceof Error ? error.message : error}`);
      }
    });
  }

  /** Surface a sign-in rejection instead of polling until the timeout. */
  private async readError(page: Page): Promise<string | null> {
    try {
      return (await page.evaluate(`(() => {
        const selectors = ['#usernameError', '#passwordError', '[role=alert]', '.alert-error'];
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            const text = (el.textContent || '').trim();
            if (text) return text.slice(0, 300);
          }
        }
        const body = document.body ? document.body.innerText : '';
        const aadsts = body.match(/AADSTS\\d+[^\\n]*/);
        if (aadsts) return aadsts[0].slice(0, 300);
        if (/couldn't sign you in|invalid credentials|account is locked/i.test(body)) {
          return body.slice(0, 300);
        }
        return null;
      })()`)) as string | null;
    } catch {
      return null;
    }
  }

  private async hasSelector(page: Page, selector: string): Promise<boolean> {
    try {
      return (await page.evaluate(
        `(selector) => {
          const el = document.querySelector(selector);
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }`,
        selector,
      )) as boolean;
    } catch {
      return false;
    }
  }

  /** Report a handoff once, then stay quiet so the log is not spammed. */
  private handoff(log: (message: string) => void, announced: boolean, step: string): boolean {
    if (announced) {
      return true;
    }
    log(`👤 Complete the ${step} step in the browser window.`);
    const missing = this.missingCredentials();
    if (missing.length > 0) {
      log(`   Credentials not provided (${missing.join(', ')}); set them to automate this step.`);
    }
    return true;
  }
}
