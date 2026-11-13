# StykAnimate scripting API

`styk_run` runs your code as the body of an async function, with these names in scope:

- `api`: the scripting library below. Start here.
- `styk`: the app object (`window.styk`): `editor`, `actions`, `state`, `ui.commands`.
- `editor`: the live editor, with every editing command (`src/engine/engine-commands.mjs`). Use it only for what
  `api` does not cover, and only through its methods: never assign to its records.

`return` a value to see it. Each `api` call is one undo step in the app (Ctrl+Z works on it).

## Conventions

- **Frames** are 0-based ticks: frame 0 is the first. `api.info().frames` is the length.
- **Positions** are canvas pixels, x right, y down. `{x, y}` of a figure is its root point (the hips of the standard figure).
- **Angles** are degrees in screen coordinates: 0 points right, 90 points down, -90 points up, ±180 points left.
  A joint's angle is **relative to its parent bone** (the bone it hangs from): 0 means it carries straight on from the
  parent. A root bone (no parent) takes its world direction. Pass `{world: true}` to give world directions instead.
- **Joints** are named (case-insensitive) or given by segment id. `api.joints(uid)` lists a figure's joints with their
  current angles, so read it before posing.
- **Keys and easing.** Posing or moving a figure on a frame keys that frame on the figure's layer. Between keys, the
  key's easing decides the in-betweens: `constant` holds the pose (new projects start that way), `linear` and `auto`
  interpolate. `api.animate` sets the easing for you (linear by default).
- Rotations interpolate the short way round: to turn more than 180° between two keys, add a key in between.

## Document

| Call | Does |
| --- | --- |
| `await api.newDocument({width = 960, height = 540, fps = 24, frames = 24, keepFigure = false})` | Opens a new, empty project (in a new tab if the open one has unsaved work) and returns `info()`. |
| `api.setProject({width, height, fps, frames})` | Changes the canvas, the frame rate or the length (any of them). |
| `api.info()` | `{name, width, height, fps, frames, tick, layers, figureTypes, figures, dirty, undo}` |
| `api.setLength(frames)` | Lengthens (extending each layer's last frame) or shortens the timeline. |
| `api.seek(tick)` | Moves the playhead. |
| `api.undo()`, `api.redo()` | As Ctrl+Z and Ctrl+Y. |

## Figures

| Call | Does |
| --- | --- |
| `await api.addFigure({x, y, scale, type, tick})` | Adds the standard stick figure (or one of `type`, an id or name from `info().figureTypes`) and returns its **uid**. |
| `api.removeFigure(uid)` | Deletes it. |
| `api.figures(tick?)` | `[{uid, figure, layer, x, y, scale, joints}]` on that frame. |
| `api.joints(uid, tick?)` | `[{name, id, parent, length, angle, world, end: {x, y}}]`: `angle` relative to the parent, `world` its direction. |

## Animation

| Call | Does |
| --- | --- |
| `api.pose(uid, tick, {joint: degrees, ...}, {world = false})` | Sets joint angles on that frame (keying it). Returns `joints()`. |
| `api.place(uid, tick, {x, y, scale, opacity})` | Moves, scales or fades the figure on that frame (keying it). |
| `api.animate(uid, [{tick, pose?, x?, y?, scale?, opacity?}, ...], {easing = 'linear', world = false})` | All the keys of a figure in one step, then the easing between the first and the last. |
| `api.key(tick, {layers})` | Keys a frame as it shows now (all layers by default). |
| `api.keys()` | `{layer: [{tick, easing}]}` |
| `api.ease(easing, {from = 0, to = last, layers})` | `linear`, `auto`, `ease-in`, `ease-out`, `constant` between those frames. |
| `api.duplicateFrame(tick?)` | Copies a frame into a new frame after it (all layers), shifting the rest. |

## Files

Use the `styk_export` and `styk_open` tools: they write and read files on disk without a dialog. `styk_preview`
shows a frame as a picture, which is the quickest way to check a pose.

## The standard figure

`api.addFigure()` adds the app's standard figure. Its joints, with their angles when added (relative, world):

| Joint | Parent | Length | Angle | World |
| --- | --- | --- | --- | --- |
| Torso | (root, at the hips) | 78 | -90 | -90 |
| Head | Torso | 44 | 0 | -90 |
| Left upper arm | Torso | 53 | 150 | 60 |
| Left forearm | Left upper arm | 48 | 15 | 76 |
| Right upper arm | Torso | 53 | -150 | 120 |
| Right forearm | Right upper arm | 48 | -15 | 104 |
| Left thigh | (root) | 66 | 64 | 64 |
| Left lower leg | Left thigh | 63 | 23 | 87 |
| Right thigh | (root) | 66 | 116 | 116 |
| Right lower leg | Right thigh | 63 | -23 | 93 |

The figure faces the viewer: its left side is on the right of the screen (world angles near 60), its right side on
the left (near 120). The arms and the head hang from the top of the torso; the thighs start at the root.

Its hands and feet have IK targets in the app; setting their angles with `api.pose` still works.

## Example: a wave

World angles are often easier to think in: the right arm up and to the left, the forearm swinging between
up-left and straight up.

```js
await api.newDocument({frames: 24});
const f = await api.addFigure({x: 480, y: 300});
api.animate(f, [
  {tick: 0,  pose: {'Right upper arm': -120, 'Right forearm': -150}},
  {tick: 6,  pose: {'Right forearm': -90}},
  {tick: 12, pose: {'Right forearm': -150}},
  {tick: 18, pose: {'Right forearm': -90}},
  {tick: 23, pose: {'Right forearm': -150}},
], {world: true});
return api.keys();
```

Then `styk_preview` with `frame: 6` to look, and `styk_export` with `path: "wave.gif"`.

## Example: generated motion

Scripts are JavaScript, so motion can be computed. A figure walking right with swinging legs:

```js
await api.newDocument({frames: 48});
const f = await api.addFigure({x: 150, y: 300});
const keys = [];
for (let t = 0; t <= 47; t += 4) {
  const s = Math.sin(t / 48 * 4 * Math.PI) * 25;
  keys.push({tick: t, x: 150 + t * 12, pose: {
    'Left thigh': 90 - s, 'Right thigh': 90 + s, 'Left lower leg': 100 - s, 'Right lower leg': 100 + s,
    'Left upper arm': 90 + s, 'Right upper arm': 90 - s}});
}
api.animate(f, keys, {world: true, easing: 'auto'});
```

`{world: true}` applies to every joint in the call, children included: a shin's angle is its own direction, not a bend from the thigh.
