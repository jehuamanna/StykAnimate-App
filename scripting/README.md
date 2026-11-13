# Scripting and the MCP server

Make stick-figure animations from code, or from Claude Code through the Model Context Protocol. This folder is a
developer tool for a source checkout: it is not part of the packaged app or the browser build, and nothing in `src/` or
`desktop/` depends on it.

## Set up

1. Build the checkout once: `npm ci` and `npm run engine:build` (see `README.md` at the root).
2. Register the server with Claude Code, from the checkout's root:

   ```bash
   claude mcp add stykanimate -- node "$PWD/scripting/mcp-server.mjs"
   ```

3. Ask Claude Code for an animation ("make a 2-second GIF of a stick figure waving"). The first tool call opens a
   StykAnimate window; later calls reuse it. Edits show in that window as they happen, and Ctrl+Z undoes them.

`npm run mcp` starts the same server by hand (it speaks MCP on stdin and stdout).

## How it works

```
Claude Code ──MCP (stdio)──▶ mcp-server.mjs ──inspector protocol──▶ the app's page ──▶ window.stykScript ──▶ window.styk.editor
```

- `mcp-server.mjs`: the tools (`styk_status`, `styk_api`, `styk_run`, `styk_preview`, `styk_export`, `styk_open`).
- `mcp-protocol.mjs`: MCP over stdio (JSON-RPC, one message per line), with no dependency.
- `app-connection.mjs`: starts a developer launch of this checkout (`--styk-developer` with
  `STYK_REMOTE_DEBUGGING_PORT`, as `scripts/styk-profile.mjs` does) or attaches to one already listening. It connects
  with Playwright, which is already a development dependency, and installs `page-runtime.js` in the page.
- `page-runtime.js`: the scripting library, `window.stykScript`. It calls only the app's existing objects: the
  editor's session commands for edits (so every edit undoes and saves like one made by hand), and the export modules
  (`src/export-request.mjs`, `src/engine/engine-export.mjs`, `src/image-export.mjs`, `src/video-export.mjs`,
  `src/document-export.mjs`) for files, with an in-memory sink instead of a save dialog.
- `API.md`: the library's reference, which the `styk_api` tool returns to the model.

Files are written by the server, not by the app: the page makes the file in memory, the server reads it in 8 MiB
pieces, writes a temporary file beside the target and renames it, so a failed export leaves an existing file as it
was.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `STYK_SCRIPTING_PORT` | 9329 | The inspector port of the app the server starts or attaches to. |
| `STYK_SCRIPTING_DATA` | `~/.local/share/StykAnimate-scripting` (`%LOCALAPPDATA%` on Windows) | The scripted window's settings, library and recovery files. It is never the app's usual data folder, so a scripted window cannot change the app you use. |

## Limits

- The server only works with a developer launch from a source checkout: a packaged app opens no inspector port.
- `styk_run` runs any JavaScript in the app's page, with the access the page has. The inspector port listens on
  127.0.0.1 only, but any program of yours on this computer can reach it while the window is open.
- `styk_preview` with `stage: true` takes a screenshot of the window. When the window is off-screen, that picture
  can miss the canvas; the default preview renders the frame as the export does.
- The window stays open when the server stops, so unsaved work is not lost; close it as usual.

## Changing it

The library calls the app through `window.styk` (end of `src/app.mjs`), the editor's commands
(`src/engine/engine-commands.mjs`) and the export modules named above. When one of those changes, update
`page-runtime.js` and `API.md`. `tests/scripting-mcp.test.mjs` covers the protocol layer and parses the library.
