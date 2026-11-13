// The running app, reached through Chromium's inspector protocol: a developer launch opens it when
// STYK_REMOTE_DEBUGGING_PORT is set (desktop/main.cjs), and scripts/styk-profile.mjs attaches the same way. Nothing in
// the app knows about scripting: the page-side library (page-runtime.js) is installed with `page.evaluate`.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
// Installed once per page and per version of the file: kept state (exported files waiting to be read) survives between calls.
const RUNTIME_SOURCE = readFileSync(path.join(import.meta.dirname, 'page-runtime.js'), 'utf8');
const RUNTIME_HASH = createHash('sha256').update(RUNTIME_SOURCE).digest('hex').slice(0, 16);
const PAGE_RUNTIME = `if (window.__stykScriptRuntime !== '${RUNTIME_HASH}') {\n${RUNTIME_SOURCE}\nwindow.__stykScriptRuntime = '${RUNTIME_HASH}';\n}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The data folder scripted sessions use: STYK_SCRIPTING_DATA, or a folder of its own under the user's data home. Never
 * the app's usual one, so a scripted window cannot touch the settings, library or recovery files of the app in use.
 */
export function scriptingDataFolder() {
  const dir = process.env.STYK_SCRIPTING_DATA || path.join(process.env.XDG_DATA_HOME || (process.platform === 'win32' ? process.env.LOCALAPPDATA || os.homedir() : path.join(os.homedir(), '.local', 'share')), 'StykAnimate-scripting');
  mkdirSync(path.join(dir, 'library'), {recursive: true});
  return dir;
}

/** The page whose `window.styk` is ready, among the browser's pages; null when none is yet. */
async function editorPage(browser) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    if (await page.evaluate(() => Boolean(window.styk?.ready && window.styk.editor)).catch(() => false)) return page;
  }
  return null;
}

async function attach(port, {child = null, timeoutMs = 60000} = {}) {
  const deadline = Date.now() + timeoutMs;
  let browser = null, page = null;
  while (!page && Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`The app exited (${child.exitCode}) before it was ready. Is the engine built (npm run engine:build)?`);
    try {
      browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = await editorPage(browser);
    } catch { browser = null; }
    if (!page) await sleep(300);
  }
  if (!page) { await browser?.close().catch(() => {}); throw new Error(`No StykAnimate editor answered on port ${port} within ${Math.round(timeoutMs / 1000)} s.`); }
  await page.evaluate(PAGE_RUNTIME);
  return {browser, page};
}

/**
 * One app session. `connect()` attaches to a developer launch on `port` (STYK_SCRIPTING_PORT, default 9229 + 100), or
 * starts one there with a window you can see. `evaluate(fn, arg)` runs in the page with the runtime installed again
 * after a reload.
 */
export function createAppConnection({port = Number(process.env.STYK_SCRIPTING_PORT) || 9329, log = () => {}} = {}) {
  let session = null, child = null;

  async function launch() {
    const data = scriptingDataFolder();
    const electron = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    log(`starting the app (port ${port}, data ${data})`);
    child = spawn(electron, ['.', '--styk-developer'], {cwd: root, stdio: 'ignore', detached: false, windowsHide: false, shell: process.platform === 'win32',
      env: {...process.env, STYK_USER_DATA_DIR: data, STYK_LIBRARY_DIR: path.join(data, 'library'), STYK_REMOTE_DEBUGGING_PORT: String(port), STYK_STARTUP_VIEW: 'editor'}});
    child.once('exit', () => { child = null; session = null; });
    // The window outlives the server (README: it keeps unsaved work), so the server does not wait for it to close.
    child.unref();
    return attach(port, {child, timeoutMs: 90000});
  }

  async function connect({start = true} = {}) {
    if (session && session.browser.isConnected() && !session.page.isClosed()) return session;
    session = null;
    try { session = await attach(port, {timeoutMs: 1500}); }
    catch (error) { if (!start) throw error; session = await launch(); }
    session.page.on('load', () => { session?.page.evaluate(PAGE_RUNTIME).catch(() => {}); });
    session.browser.on('disconnected', () => { session = null; });
    return session;
  }

  return {
    connect,
    get port() { return port; },
    get started() { return Boolean(child); },
    async evaluate(fn, arg) {
      const {page} = await connect();
      // A reload drops the runtime: install it again before every call (cheap: it returns at once when present).
      await page.evaluate(PAGE_RUNTIME);
      return page.evaluate(fn, arg);
    },
    async close({quit = false} = {}) {
      await session?.browser.close().catch(() => {});
      session = null;
      if (quit && child) child.kill();
    },
  };
}
