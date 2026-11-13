#!/usr/bin/env node
// StykAnimate's MCP server: lets an MCP client (Claude Code) make stick-figure animations in the app. It starts a
// developer launch of this checkout (or attaches to one) and drives it through the scripting library in
// page-runtime.js. See scripting/README.md for setup and scripting/API.md for the library.
//
//   claude mcp add stykanimate -- node /path/to/checkout/scripting/mcp-server.mjs
import {closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync} from 'node:fs';
import path from 'node:path';
import {createAppConnection} from './app-connection.mjs';
import {serveStdio} from './mcp-protocol.mjs';

const API = readFileSync(path.join(import.meta.dirname, 'API.md'), 'utf8');
const log = text => process.stderr.write(`[stykanimate-mcp] ${text}\n`);
const app = createAppConnection({log});
const CHUNK = 8 * 1024 * 1024;

const EXTENSIONS = {styk: 'styk', piv: 'piv', gif: 'gif', apng: 'png', mp4: 'mp4', webm: 'webm', png: 'png', svg: 'svg',
  'png-sequence': 'zip', 'jpeg-sequence': 'zip', 'svg-sequence': 'zip'};
const FORMAT_OF_EXTENSION = {styk: 'styk', piv: 'piv', gif: 'gif', mp4: 'mp4', webm: 'webm', png: 'png', svg: 'svg', zip: 'png-sequence'};

/** Runs a function of the scripting library in the page and returns its result. */
const call = (name, ...args) => app.evaluate(async ([name, args]) => window.stykScript[name](...args), [name, args]);

/** Writes a file the page made to `file`: chunks to a temporary file beside it, then a rename, so a failure leaves any existing file as it was. */
async function writeExport(format, file, options) {
  const target = path.resolve(file);
  mkdirSync(path.dirname(target), {recursive: true});
  const {id, size} = await call('exportBlob', format, options);
  const temporary = `${target}.${process.pid}.part`;
  const handle = openSync(temporary, 'w');
  try {
    for (let offset = 0; offset < size; offset += CHUNK) writeSync(handle, Buffer.from(await call('readBlob', id, offset, CHUNK), 'base64'));
    closeSync(handle);
    renameSync(temporary, target);
  } catch (error) {
    try { closeSync(handle); } catch { /* already closed */ }
    rmSync(temporary, {force: true});
    throw error;
  } finally {
    await call('releaseBlob', id).catch(() => {});
  }
  return {path: target, format, bytes: size};
}

const image = (base64, note) => ({content: [{type: 'image', data: base64, mimeType: 'image/png'}, ...(note ? [{type: 'text', text: note}] : [])]});

const tools = [
  {
    name: 'styk_status',
    description: 'Connects to StykAnimate (starting the app in a window if it is not running) and returns the open document: canvas size, fps, frame count, playhead, layers and the figures on the current frame.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    run: () => call('info'),
  },
  {
    name: 'styk_api',
    description: 'The scripting reference: the stykScript functions styk_run can call (new document, add figures, pose joints by name in degrees, keyframes, easing, export), the coordinate conventions and the standard figure\'s joints. Read it before the first styk_run.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    run: () => API,
  },
  {
    name: 'styk_run',
    description: 'Runs JavaScript in the app as the body of an async function and returns what it returns (as JSON). In scope: `api` (the scripting library, see styk_api), `styk` (the app object) and `editor` (the live editor). Every edit is undoable in the app. Use loops to generate motion, e.g. a walk cycle over many frames.',
    inputSchema: {type: 'object', properties: {code: {type: 'string', description: 'The function body, e.g. "const f = await api.addFigure({x: 300}); api.pose(f, 0, {\'Left thigh\': 20}); return api.info();"'}},
      required: ['code'], additionalProperties: false},
    run: async ({code}) => {
      const result = await app.evaluate(async source => {
        const body = new Function('api', 'styk', 'editor', `return (async () => {\n${source}\n})();`);
        try { return {ok: true, value: await body(window.stykScript, window.styk, window.styk.editor)}; }
        catch (error) { return {ok: false, error: String(error?.stack ?? error).split('\n').slice(0, 6).join('\n')}; }
      }, code);
      if (!result.ok) throw new Error(`The script failed:\n${result.error}`);
      return result.value === undefined ? 'Done (the script returned nothing).' : result.value;
    },
  },
  {
    name: 'styk_preview',
    description: 'Shows a picture: by default frame `frame` (default: the playhead) as the export renders it; with `stage: true`, the editor\'s canvas as it is on screen (with selection and handles).',
    inputSchema: {type: 'object', properties: {frame: {type: 'integer', minimum: 0}, width: {type: 'integer', minimum: 16}, stage: {type: 'boolean'}}, additionalProperties: false},
    run: async ({frame, width, stage = false}) => {
      // The window as it is on screen: a WebGPU canvas read back from the page comes out blank.
      if (stage) {
        await call('settle');
        const {page} = await app.connect();
        return image((await page.screenshot({type: 'png'})).toString('base64'));
      }
      const info = await call('info');
      const at = frame ?? info.tick;
      const size = width ? {width, height: Math.round(width * info.height / info.width)} : {};
      const {id} = await call('exportBlob', 'png', {frame: at, ...size});
      try { return image(await call('readBlob', id, 0, 64 * 1024 * 1024), `Frame ${at} of ${info.frames}.`); }
      finally { await call('releaseBlob', id).catch(() => {}); }
    },
  },
  {
    name: 'styk_export',
    description: 'Writes the animation or project to a file without a dialog. The format follows the extension unless given: .styk (StykAnimate project), .piv, .gif, .mp4, .webm, .png (one frame), .svg (one frame), .zip (PNG frames). Options: from/to (1-based frames), width/height, frame (0-based, for .png/.svg).',
    inputSchema: {type: 'object', properties: {
      path: {type: 'string', description: 'Where to write; a relative path is relative to the MCP server\'s working directory.'},
      format: {type: 'string', enum: Object.keys(EXTENSIONS)},
      from: {type: 'integer', minimum: 1}, to: {type: 'integer', minimum: 1}, width: {type: 'integer', minimum: 1}, height: {type: 'integer', minimum: 1}, frame: {type: 'integer', minimum: 0},
    }, required: ['path'], additionalProperties: false},
    run: async ({path: file, format, ...options}) => {
      const extension = path.extname(file).slice(1).toLowerCase();
      const chosen = format ?? FORMAT_OF_EXTENSION[extension] ?? fail(`Name the format: the extension .${extension} does not say one.`);
      return writeExport(chosen, file, options);
    },
  },
  {
    name: 'styk_open',
    description: 'Opens an animation or figure file (.styk, .piv, .stk, .stkz, .stykmov, …) in the app, as if it was dropped on the window.',
    inputSchema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path'], additionalProperties: false},
    run: async ({path: file}) => {
      const resolved = path.resolve(file);
      return call('openBytes', path.basename(resolved), readFileSync(resolved).toString('base64'));
    },
  },
];

function fail(message) { throw new Error(message); }

const instructions = `Makes stick-figure animations in StykAnimate. Read styk_api once, then use styk_run with short scripts:
api.newDocument({width, height, fps, frames}) → api.addFigure({x, y}) → api.animate(uid, [{tick, pose: {'Left thigh': 30, ...}, x, y}, ...]) → styk_preview a few frames → styk_export to .gif/.mp4/.styk.
Angles are degrees relative to the parent bone (0 = right, 90 = down, -90 = up). Every edit is undoable in the app.`;

process.on('SIGTERM', () => app.close().finally(() => process.exit(0)));
await serveStdio({name: 'stykanimate', version: '1.0.0', instructions, tools});
await app.close();
