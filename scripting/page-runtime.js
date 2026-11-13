// The scripting library, installed into the app's page by app-connection.mjs (`page.evaluate` of this file's text).
// It defines `window.stykScript`, a small API over the app's own objects (`window.styk`, set up at the end of
// src/app.mjs): every edit is one of the editor's session commands, so it reaches the engine, saves, and undoes like
// an edit made by hand. Nothing here writes the document directly.
//
// Angles are degrees. A joint's angle is relative to its parent bone (a root bone's is its world direction), measured in
// screen coordinates: 0 points right, 90 points down, -90 points up. Positions are canvas pixels, y down. Frames are
// 0-based ticks of the timeline.
(() => {
  const DEG = 180 / Math.PI;
  const app = () => window.styk ?? fail('The app is not loaded.');
  const ed = () => app().editor ?? fail('The editor is not ready.');
  function fail(message) { throw new Error(message); }
  const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
  const wrap = degrees => { let d = ((degrees + 180) % 360 + 360) % 360 - 180; return d === -180 ? 180 : d; };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

  /** The layers every frame command takes (scene and camera rows, then each layer), as the app's own frame actions pass them. */
  const allRows = () => ['scene', 'camera', ...ed().report._styk.layers.order];
  const fps = () => { const r = ed().report; return r.frame_delay_ms ? 1000 / r.frame_delay_ms : r.fps; };

  function objectAt(uid) {
    const e = ed();
    const object = e.evaluatedFrame?.objects?.find(o => o.unique_id === uid);
    return object ?? fail(`No figure ${uid} on frame ${e.tick}. figures() lists them.`);
  }
  function definitionOf(object) {
    return ed().report.figure_types.find(type => type.figure_type_id === object.figure_type_id) ?? fail(`Figure ${object.unique_id} has no definition.`);
  }
  /** A joint of a figure by name (case-insensitive), segment id, or index into the definition's segments. */
  function jointIndex(definition, joint) {
    const segments = definition.segments;
    if (typeof joint === 'number') {
      const byId = segments.findIndex(s => s.segment_id === joint);
      if (byId >= 0) return byId;
    }
    const name = String(joint).trim().toLowerCase();
    const index = segments.findIndex(s => (s.name ?? '').toLowerCase() === name);
    if (index >= 0) return index;
    fail(`No joint ${JSON.stringify(joint)} in ${definition.name}. Its joints: ${segments.map(s => s.name ?? s.segment_id).join(', ')}.`);
  }
  const parentIndex = (definition, index) => definition.segments.findIndex(s => s.segment_id === definition.segments[index].parent_id);

  function layerOf(uid) { return ed().layerForUid?.(uid) ?? ed().report._styk.layers.order[0]; }
  /** Puts a key on the figure's layer at `tick` (once), and moves the playhead there, so an edit lands on that frame. */
  function keyAt(uid, tick) {
    const e = ed();
    if (!Number.isInteger(tick) || tick < 0) fail(`A frame is a whole number from 0 (got ${tick}).`);
    if (tick >= e.totalTicks) setLength(tick + 1);
    const layer = layerOf(uid);
    if (!e.layerFrameKeys(layer).some(key => key.tick === tick)) e.sheetInsertKey([layer], tick);
    e.seek(tick);
  }

  function setLength(frames) {
    const e = ed();
    if (!Number.isInteger(frames) || frames < 1) fail('The length is a whole number of frames, at least 1.');
    const total = e.totalTicks;
    if (frames > total) {
      // Each layer's last exposure grows to the new end, as dragging the end of the timeline does.
      for (const layer of e.report._styk.layers.order) {
        const keys = e.layerFrameKeys(layer);
        const last = keys.length ? keys.at(-1).tick : 0;
        e.sheetSetDuration(frames - last, layer, last);
      }
    } else if (frames < total) {
      e.sheetRemoveFrames(allRows(), frames, total - 1);
    }
    return e.totalTicks;
  }

  function figureSummary(object) {
    const definition = definitionOf(object);
    return {uid: object.unique_id, figure: definition.name, layer: layerOf(object.unique_id), x: round(object.root_x), y: round(object.root_y), scale: round(object.scale ?? 1, 3),
      joints: definition.segments.length};
  }

  const api = {
    /** The open document: size, rate, length, playhead, layers and the figures on the current frame. */
    info() {
      const e = ed(), r = e.report;
      return {name: e.name, width: r.canvas_width, height: r.canvas_height, fps: round(fps(), 3), frames: e.totalTicks, tick: e.tick,
        layers: r._styk.layers.order, figureTypes: r.figure_types.map(t => ({id: t.figure_type_id, name: t.name, joints: t.segments.length})),
        figures: (e.evaluatedFrame?.objects ?? []).map(figureSummary), dirty: Boolean(e.dirty), undo: e.undoLabel ?? null};
    },

    /**
     * Opens a new project (beside the open one when that one has unsaved work) and sets it up:
     * `{width = 960, height = 540, fps = 24, frames = 24, keepFigure = false}`. The startup figure is removed unless
     * `keepFigure`.
     */
    async newDocument({width = 960, height = 540, fps: rate = 24, frames = 24, keepFigure = false} = {}) {
      const before = app().editor?.report;
      // Each new project opens beside one with unsaved work, up to the app's limit of open projects.
      if (app().projects?.canOpen?.() === false) fail('Too many projects are open: export what you need, then close some (each new document opens in its own tab while the open one has unsaved changes).');
      await app().actions.new();
      if (app().editor.report === before) fail('A new project could not be opened (is a dialog open?).');
      const e = ed();
      e.movieclipBatch('Set up project', () => {
        e.updateProject({canvas_width: width, canvas_height: height, fps: rate});
        if (!keepFigure) for (const object of [...(e.evaluatedFrame?.objects ?? [])]) { e.select(object.unique_id); e.deleteFigure(); }
        setLength(frames);
      });
      e.seek(0);
      app().fit?.();
      return api.info();
    },

    /** Changes the canvas size, frame rate or length: `{width, height, fps, frames}`, any of them. One undo step. */
    setProject({width, height, fps: rate, frames} = {}) {
      const e = ed(), patch = {};
      if (width != null) patch.canvas_width = width;
      if (height != null) patch.canvas_height = height;
      if (rate != null) patch.fps = rate;
      e.movieclipBatch('Project settings', () => {
        if (Object.keys(patch).length) e.updateProject(patch);
        if (frames != null) setLength(frames);
      });
      return api.info();
    },

    /** The figures on frame `tick` (default: the playhead). */
    figures(tick) {
      if (tick != null) ed().seek(tick);
      return (ed().evaluatedFrame?.objects ?? []).map(figureSummary);
    },

    /** A figure's joints on frame `tick`: name, id, parent, length, angle (relative to the parent) and world angle, end point. */
    joints(uid, tick) {
      const e = ed();
      if (tick != null) e.seek(tick);
      const object = objectAt(uid), definition = definitionOf(object);
      const slot = e.evaluatedFrame.objects.indexOf(object), group = e.geometry?.objects?.get?.(slot);
      return definition.segments.map((segment, index) => {
        const parent = parentIndex(definition, index), world = object.angles[index] * DEG;
        const end = group?.joints?.get?.(segment.segment_id);
        return {name: segment.name ?? null, id: segment.segment_id, parent: parent >= 0 ? (definition.segments[parent].name ?? definition.segments[parent].segment_id) : null,
          length: round(object.lengths?.[index] ?? segment.length), angle: round(parent >= 0 ? wrap(world - object.angles[parent] * DEG) : wrap(world)), world: round(wrap(world)),
          end: end ? {x: round(end.x), y: round(end.y)} : undefined};
      });
    },

    /**
     * Adds a stick figure at `{x, y}` (default: the canvas centre) on frame `tick`: a new figure of type `type` (id or
     * name) when given, else the app's standard figure ("Blue"). Returns its uid.
     */
    async addFigure({x, y, scale, type, tick} = {}) {
      const e = ed();
      // The standard figure is imported once; later ones are more of the same type.
      if (type == null) type = e.report.figure_types.find(t => t.name === 'Blue')?.figure_type_id;
      const standard = type == null ? (await import('/src/startup-blue-data.mjs')).createBlueStartupPose().figure : null;
      let uid;
      e.movieclipBatch('Add figure', () => {
        if (tick != null) e.seek(tick);
        let object;
        if (standard) object = e.importFigure(standard);
        else {
          const found = e.report.figure_types.find(t => t.figure_type_id === type || t.name?.toLowerCase() === String(type).toLowerCase());
          object = e.addFigure(found?.figure_type_id ?? fail(`No figure type ${JSON.stringify(type)}. info().figureTypes lists them.`));
        }
        uid = object?.unique_id ?? e.selectedUid;
        const patch = {};
        if (x != null) patch.root_x = x;
        if (y != null) patch.root_y = y;
        if (scale != null) patch.scale = scale;
        if (Object.keys(patch).length) { e.select(uid); e.updateObject(patch); }
      });
      return uid;
    },

    /** Removes a figure from the document. */
    removeFigure(uid) { const e = ed(); objectAt(uid); e.select(uid); e.deleteFigure(); },

    /**
     * Poses a figure on frame `tick`: `angles` maps joint names (or ids) to degrees. Relative to the parent bone by
     * default; `{world: true}` takes world directions. Keys that frame on the figure's layer first. One undo step.
     */
    pose(uid, tick, angles, {world = false} = {}) {
      const e = ed();
      e.movieclipBatch('Pose figure', () => {
        keyAt(uid, tick);
        const definition = definitionOf(objectAt(uid));
        // Parents first: a parent's turn carries its children, which then take their own angle.
        const entries = Object.entries(angles).map(([joint, degrees]) => [jointIndex(definition, isNaN(joint) ? joint : Number(joint)), degrees])
          .sort((a, b) => depth(definition, a[0]) - depth(definition, b[0]));
        for (const [index, degrees] of entries) {
          if (!Number.isFinite(degrees)) fail(`The angle of ${definition.segments[index].name ?? index} is not a number.`);
          const object = objectAt(uid), parent = parentIndex(definition, index);
          const target = world || parent < 0 ? degrees / DEG : object.angles[parent] + degrees / DEG;
          e.select(uid, index);
          e.updateSegment({angle_rad: target});
        }
      });
      return api.joints(uid, tick);
    },

    /** Moves, scales or fades a figure on frame `tick`: `{x, y, scale, opacity}`. Keys that frame first. */
    place(uid, tick, {x, y, scale, opacity} = {}) {
      const e = ed();
      e.movieclipBatch('Move figure', () => {
        keyAt(uid, tick);
        const patch = {};
        if (x != null) patch.root_x = x;
        if (y != null) patch.root_y = y;
        if (scale != null) patch.scale = scale;
        if (opacity != null) patch.opacity = opacity;
        e.select(uid);
        e.updateObject(patch);
      });
      return figureSummary(objectAt(uid));
    },

    /**
     * Animates a figure through keyframes in one undo step: `[{tick, pose?: {joint: degrees}, x?, y?, scale?, opacity?}]`,
     * then sets the easing between them (`easing`: linear, auto, ease-in, ease-out, constant; default linear).
     */
    animate(uid, keys, {easing = 'linear', world = false} = {}) {
      if (!Array.isArray(keys) || !keys.length) fail('Give the keyframes as a list of {tick, pose, x, y}.');
      const e = ed(), sorted = [...keys].sort((a, b) => a.tick - b.tick);
      e.movieclipBatch('Animate figure', () => {
        for (const key of sorted) {
          if (key.x != null || key.y != null || key.scale != null || key.opacity != null) api.place(uid, key.tick, key);
          if (key.pose) api.pose(uid, key.tick, key.pose, {world});
          if (!key.pose && key.x == null && key.y == null && key.scale == null && key.opacity == null) keyAt(uid, key.tick);
        }
        if (easing) e.sheetSetEasing([layerOf(uid)], sorted[0].tick, sorted.at(-1).tick, {interpolation: easing});
      });
      return {keys: e.layerFrameKeys(layerOf(uid)).map(k => ({tick: k.tick, easing: k.interpolation}))};
    },

    /** Keys frame `tick` on `layers` (default: every layer) with what it shows now. */
    key(tick, {layers} = {}) { ed().sheetInsertKey(layers ?? ed().report._styk.layers.order, tick); return api.keys(); },
    /** The keys of each layer: {layer: [{tick, easing}]}. */
    keys() {
      const e = ed();
      return Object.fromEntries(e.report._styk.layers.order.map(layer => [layer, e.layerFrameKeys(layer).map(k => ({tick: k.tick, easing: k.interpolation}))]));
    },
    /** Sets the easing of the keys from `from` to `to` (default: the whole timeline) on `layers` (default: every layer). */
    ease(interpolation = 'linear', {from = 0, to, layers} = {}) {
      const e = ed();
      e.sheetSetEasing(layers ?? e.report._styk.layers.order, from, to ?? e.totalTicks - 1, {interpolation});
      return api.keys();
    },
    /** Copies frame `tick` (default: the playhead) to a new frame right after it, on every layer. */
    duplicateFrame(tick) { const e = ed(); e.sheetDuplicateFrameAfter(allRows(), tick ?? e.tick); return {frames: e.totalTicks, tick: e.tick}; },
    setLength(frames) { let total; ed().movieclipBatch('Set length', () => { total = setLength(frames); }); return {frames: total}; },
    seek(tick) { ed().seek(tick); return {tick: ed().tick}; },
    undo() { app().actions.undo(); return {undo: ed().undoLabel ?? null}; },
    redo() { app().actions.redo(); return {undo: ed().undoLabel ?? null}; },

    /** Waits until the stage shows the document's current revision and frame. */
    async settle(timeoutMs = 5000) {
      const e = ed(), tick = e.tick, revision = e.revision, since = performance.now(), deadline = since + timeoutMs;
      app().requestRender();
      while (performance.now() < deadline) {
        const shown = app().state.lastEditingPresentation;
        if (shown && shown.tick === tick && shown.revision === revision && shown.at >= since - 1) return true;
        await frame();
      }
      return false;
    },

    /** Opens a file's bytes (base64) as the app opens a dropped file, and waits until it is shown. */
    async openBytes(name, base64, timeoutMs = 120000) {
      const before = app().editor?.report;
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      await app().importFiles([new File([bytes], name)]);
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (app().editor.report !== before && !app().state.importing && app().editor.totalTicks > 0) { await api.settle(); return api.info(); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      fail(`${name} did not open within ${Math.round(timeoutMs / 1000)} s.`);
    },

    /**
     * Makes a file of the document in memory, with the app's own exporters and no dialog, and keeps it for `readBlob`.
     * `format`: styk (the project), piv, gif, apng, mp4, webm, png (one frame), svg (one frame), png-sequence (zip),
     * jpeg-sequence, svg-sequence. `options`: {from, to (1-based frames), width, height, frame (for png/svg, 0-based)}.
     */
    async exportBlob(format, options = {}) {
      const blob = await makeFile(format, options);
      const id = ++blobCount;
      blobs.set(id, blob);
      if (blobs.size > 4) blobs.delete(blobs.keys().next().value);
      return {id, size: blob.size, type: blob.type};
    },
    /** `length` bytes of a kept file from `offset`, as base64. */
    async readBlob(id, offset = 0, length = 8 * 1024 * 1024) {
      const blob = blobs.get(id) ?? fail('That file is no longer kept: export it again.');
      const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    },
    releaseBlob(id) { blobs.delete(id); },
  };

  function depth(definition, index) {
    let count = 0;
    for (let at = parentIndex(definition, index); at >= 0 && count < 1000; at = parentIndex(definition, at)) count++;
    return count;
  }

  const blobs = new Map();
  let blobCount = 0;

  /** The app's export pieces (src/export-flow.mjs composes the same ones behind its dialogs). */
  async function makeFile(format, {from, to, width, height, frame: tick} = {}) {
    const e = ed();
    const [request, sink, images, engineExport, video, documents] = await Promise.all(['/src/export-request.mjs', '/src/export-sink.mjs', '/src/image-export.mjs',
      '/src/engine/engine-export.mjs', '/src/video-export.mjs', '/src/document-export.mjs'].map(path => import(path)));
    app().state.playing && app().actions.play();
    if (format === 'styk' || format === 'piv') {
      return new documents.DocumentExporter().export(e.report, {format, name: e.name, tick: e.tick, revision: e.revision});
    }
    const report = e.report;
    const asked = request.buildExportRequest({format, from, to, width, height}, {canvasWidth: report.canvas_width, canvasHeight: report.canvas_height, totalFrames: e.totalTicks});
    const job = request.exportJob(asked, {totalFrames: e.totalTicks, fps: fps(), provider: 'WebCodecs', browserAudio: false, audioClips: [], loop: true, name: e.name,
      objectName: '', tick: tick ?? e.tick, movieclip: false});
    if (job.kind === 'project') fail(`Use styk or piv for a project file (${format} is a figure file).`);
    // A single frame's job starts at 0 whatever the frame: its range is the frame itself.
    const start = job.kind === 'frame' ? tick ?? e.tick : job.options.start, frames = job.kind === 'frame' ? 1 : job.ticks;
    const renderer = engineExport.createExportFrameRenderer({width: job.options.width, height: job.options.height, smoothing: job.options.smoothing,
      getRevision: () => `${e.revision}`}, {stage: app().state.renderer, revision: e.revision, range: [start, start + frames - 1], vector: format.startsWith('svg')});
    try {
      await renderer.load(report);
      if (job.kind === 'frame') {
        const at = start;
        // Awaited here: the renderer is disposed in `finally`.
        if (format === 'svg') return await renderer.renderSVGTick(at);
        const canvas = await renderer.renderTick(at);
        return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The PNG could not be made.')), 'image/png'));
      }
      const memory = new sink.MemorySink('application/octet-stream');
      const output = job.kind === 'video'
        ? await (format === 'mp4' ? video.encodeMP4 : video.encodeWebM)({...job.encode, sink: memory, renderFrame: index => renderer.renderTick(index + start)})
        : await images.exportAnimation({...job.animation, sink: memory, renderFrame: index => renderer.renderTick(index + start),
          renderPNGFrame: index => renderer.renderNativeTick(index + start, {preserveAlpha: true}), renderSVGFrame: index => renderer.renderSVGTick(index + start)});
      return output?.blob ?? (await memory.finish()).blob;
    } finally {
      renderer.dispose();
    }
  }

  window.stykScript = api;
})();
