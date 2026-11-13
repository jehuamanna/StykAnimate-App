'use strict';

// Chromium switches that decide whether the editor gets a hardware WebGPU
// adapter. Windows and macOS need none: Chromium enables WebGPU through D3D12
// and Metal. Electron's Chromium does not enable Linux WebGPU by default, so the
// engine would silently draw with its WebGL2 backend even on a capable GPU
// (or land on SwiftShader). Vulkan plus the WebGPU opt-in reaches the real
// device on Mesa and NVIDIA drivers.
//
// The engine keeps its own safety net: no WebGPU adapter selects its WebGL2
// backend, so a driver that cannot do WebGPU still edits and plays back
// correctly.
//
// STYK_GPU_UNSAFE=1 forces the opt-in on any platform; STYK_GPU_UNSAFE=0 leaves
// Chromium's own driver allowlist untouched everywhere (useful when diagnosing
// a driver problem).

const LINUX_FEATURES = ['Vulkan'];

// Chromium's Wayland surface cannot present Vulkan-backed content: with the
// Vulkan feature on it logs "'--ozone-platform=wayland' is not compatible with
// Vulkan", the canvas's shared textures fail to import, and its GPU device is
// lost again after every reconnect (the canvas flashes "The graphics device was
// reset"). So the app never turns Vulkan on where the window stays on native
// Wayland, and draws with the engine's WebGL2 backend there instead.
//
// A Wayland session runs through XWayland (X11), with Vulkan, unless the window
// is to stay on Wayland: a platform given on the command line, STYK_WAYLAND=1,
// the desktop's ELECTRON_OZONE_PLATFORM_HINT (Omarchy's Hyprland sets it for
// every Electron app, and XWayland would not follow each monitor's scaling
// there), or no XWayland to run on. Chromium chooses the platform before any
// application code runs, so it cannot be switched from inside the process:
// relaunchOnX11 starts the app again with the switch on the real command line.

/** The platform given on the command line (`--ozone-platform=x` or `--ozone-platform x`), or null. */
function chosenPlatform(argv) {
  const end = argv.indexOf('--');
  const args = argv.slice(1, end < 0 ? undefined : end);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--ozone-platform=')) return args[i].slice('--ozone-platform='.length);
    if (args[i] === '--ozone-platform') return args[i + 1] ?? '';
  }
  return null;
}

/** 'wayland' when the window will stay on native Wayland, 'x11' when this launch should move to XWayland, else null. */
function linuxDisplay(env, argv) {
  const chosen = chosenPlatform(argv);
  if (chosen !== null) return chosen === 'wayland' ? 'wayland' : null;
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  if (!wayland) return null;
  const hint = env.ELECTRON_OZONE_PLATFORM_HINT;
  if (hint === 'x11') return null;
  return env.STYK_WAYLAND === '1' || hint || !env.DISPLAY ? 'wayland' : 'x11';
}

function gpuSwitches({ platform = process.platform, env = process.env, argv = process.argv } = {}) {
  const forced = env.STYK_GPU_UNSAFE;
  if (forced === '0') return { switches: [], features: [], ozone: null };
  const display = platform === 'linux' ? linuxDisplay(env, argv) : null;
  // On native Wayland the opt-in alone could reach Chromium's software Vulkan adapter, slower than WebGL2 on the GPU.
  const vulkan = platform === 'linux' && display !== 'wayland';
  const enable = forced === '1' || vulkan;
  const features = vulkan ? [...LINUX_FEATURES] : [];
  return {
    switches: enable ? ['enable-unsafe-webgpu'] : [],
    features,
    ozone: display === 'x11' ? 'x11' : null,
  };
}

// `commandLine` is Electron's app.commandLine. A --enable-features the user
// passed on the command line is merged, never replaced.
function applyGpuSwitches(commandLine, options) {
  const { switches, features, ozone } = gpuSwitches(options);
  for (const name of switches) commandLine.appendSwitch(name);
  if (features.length) {
    const existing = commandLine.hasSwitch('enable-features') ? commandLine.getSwitchValue('enable-features').split(',') : [];
    const merged = [...new Set([...existing, ...features].filter(Boolean))];
    commandLine.appendSwitch('enable-features', merged.join(','));
  }
  return { switches, features, ozone };
}

// Returns true when this process handed over to a copy started with
// --ozone-platform=x11; the caller must then do nothing else (main.cjs returns).
// The parent stays as a thin supervisor so the terminal, exit codes and signals
// behave as if the app had started directly.
function relaunchOnX11(app, { platform = process.platform, env = process.env, argv = process.argv, execPath = process.execPath,
  spawn = require('node:child_process').spawn, exit = (code) => process.exit(code), proc = process } = {}) {
  // Electron inserts its auto-selected platform into app.commandLine before
  // main runs. Only an original argv flag represents the user's choice.
  if (chosenPlatform(argv) !== null || env.STYK_DISPLAY_RELAUNCHED === '1') return false;
  if (!gpuSwitches({ platform, env, argv }).ozone) return false;
  console.log('[stykanimate] Wayland cannot show WebGPU content; restarting under XWayland (STYK_WAYLAND=1 keeps Wayland).');
  const child = spawn(execPath, ['--ozone-platform=x11', ...argv.slice(1)], { stdio: 'inherit', env: { ...env, STYK_DISPLAY_RELAUNCHED: '1' } });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) proc.on(signal, () => child.kill(signal));
  child.on('error', () => exit(1));
  child.on('exit', (code, signal) => exit(code ?? (signal ? 1 : 0)));
  return true;
}

module.exports = { gpuSwitches, applyGpuSwitches, relaunchOnX11 };
