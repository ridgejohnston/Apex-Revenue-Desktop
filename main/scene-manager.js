/**
 * Apex Revenue — Scene & Source Manager
 * OBS-style scene composition with layered sources
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

const SOURCE_TYPES = {
  WEBCAM:         'webcam',
  SCREEN_CAPTURE: 'screen_capture',
  WINDOW_CAPTURE: 'window_capture',
  GAME_CAPTURE:   'game_capture',
  IMAGE:          'image',
  IMAGE_SLIDE:    'image_slideshow',
  TEXT:           'text',
  BROWSER:        'browser',
  COLOR:          'color',
  MEDIA:          'media',
  AUDIO_INPUT:    'audio_input',
  AUDIO_OUTPUT:   'audio_output',
  CAM_SITE:       'cam_site',
  LOVENSE_OVERLAY:'lovense_overlay',
  TIP_GOAL:       'tip_goal',
  TIP_MENU:       'tip_menu',
  CHAT_OVERLAY:   'chat_overlay',
  ALERT_BOX:      'alert_box',
};

const TRANSITIONS = {
  CUT:    { type: 'cut',   label: 'Cut',   duration: 0 },
  FADE:   { type: 'fade',  label: 'Fade',  duration: 300 },
  SLIDE:  { type: 'slide', label: 'Slide', duration: 500 },
  SWIPE:  { type: 'swipe', label: 'Swipe', duration: 400 },
  STINGER:{ type: 'stinger', label: 'Stinger', duration: 1000, mediaPath: null },
};

function uid() { return crypto.randomBytes(8).toString('hex'); }

function createDefaultSource(type, name, overrides = {}) {
  return {
    id: uid(),
    type,
    name: name || type,
    visible: true,
    locked: false,
    transform: { x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1 },
    crop: { top: 0, bottom: 0, left: 0, right: 0 },
    opacity: 1,
    filters: [],
    properties: {},
    ...overrides,
  };
}

class SceneManager extends EventEmitter {
  constructor() {
    super();
    this.scenes = [];
    this.activeSceneId = null;
    this.previewSceneId = null;
    this.transition = { ...TRANSITIONS.FADE };
    this.studioMode = false;
  }

  init(savedScenes, activeId) {
    if (savedScenes?.length) {
      this.scenes = savedScenes;
      this.activeSceneId = activeId || savedScenes[0]?.id;
    } else {
      // Create default scene
      const defaultScene = this._createScene('Scene 1');
      this.scenes = [defaultScene];
      this.activeSceneId = defaultScene.id;
    }
    this.emit('change');
  }

  _createScene(name) {
    return {
      id: uid(),
      name,
      sources: [],
      createdAt: Date.now(),
    };
  }

  getAll() { return this.scenes; }
  getActiveId() { return this.activeSceneId; }

  getActive() {
    return this.scenes.find((s) => s.id === this.activeSceneId) || this.scenes[0];
  }

  getPreview() {
    if (!this.studioMode) return null;
    return this.scenes.find((s) => s.id === this.previewSceneId);
  }

  create(name) {
    const scene = this._createScene(name || `Scene ${this.scenes.length + 1}`);
    this.scenes.push(scene);
    this.emit('change');
    return scene;
  }

  remove(id) {
    this.scenes = this.scenes.filter((s) => s.id !== id);
    if (this.activeSceneId === id) {
      this.activeSceneId = this.scenes[0]?.id || null;
    }
    this.emit('change');
  }

  setActive(id) {
    if (this.studioMode) {
      // In studio mode, transition from preview
      this.previewSceneId = this.activeSceneId;
      this.activeSceneId = id;
    } else {
      this.activeSceneId = id;
    }
    this.emit('change');
  }

  rename(id, name) {
    const scene = this.scenes.find((s) => s.id === id);
    if (scene) { scene.name = name; this.emit('change'); }
  }

  duplicate(id) {
    const source = this.scenes.find((s) => s.id === id);
    if (!source) return null;
    const copy = {
      ...JSON.parse(JSON.stringify(source)),
      id: uid(),
      name: `${source.name} (Copy)`,
      createdAt: Date.now(),
    };
    // Regenerate source IDs
    copy.sources.forEach((s) => { s.id = uid(); });
    this.scenes.push(copy);
    this.emit('change');
    return copy;
  }

  // ─── Source Operations ──────────────────────────────────
  addSource(sceneId, config) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return null;

    const source = createDefaultSource(config.type, config.name, config.properties ? { properties: config.properties } : {});
    if (config.transform) source.transform = { ...source.transform, ...config.transform };

    scene.sources.push(source);
    this.emit('change');
    return source;
  }

  removeSource(sceneId, sourceId) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    scene.sources = scene.sources.filter((s) => s.id !== sourceId);
    this.emit('change');
  }

  updateSource(sceneId, sourceId, props) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    const source = scene.sources.find((s) => s.id === sourceId);
    if (!source) return;

    // Deep merge the properties
    Object.keys(props).forEach((key) => {
      if (typeof props[key] === 'object' && !Array.isArray(props[key]) && source[key]) {
        source[key] = { ...source[key], ...props[key] };
      } else {
        source[key] = props[key];
      }
    });
    this.emit('change');
  }

  reorderSources(sceneId, orderedIds) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    const mapped = new Map(scene.sources.map((s) => [s.id, s]));
    scene.sources = orderedIds.map((id) => mapped.get(id)).filter(Boolean);
    this.emit('change');
  }

  toggleSourceVisibility(sceneId, sourceId) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    const source = scene?.sources.find((s) => s.id === sourceId);
    if (source) { source.visible = !source.visible; this.emit('change'); }
    return source?.visible;
  }

  toggleSourceLock(sceneId, sourceId) {
    const scene = this.scenes.find((s) => s.id === sceneId);
    const source = scene?.sources.find((s) => s.id === sourceId);
    if (source) { source.locked = !source.locked; this.emit('change'); }
    return source?.locked;
  }

  // ─── Transition ─────────────────────────────────────────
  setTransition(transitionConfig) {
    this.transition = { ...this.transition, ...transitionConfig };
    this.emit('change');
  }

  setStudioMode(enabled) {
    this.studioMode = enabled;
    if (enabled && !this.previewSceneId) {
      this.previewSceneId = this.activeSceneId;
    }
    this.emit('change');
  }

  executeTransition() {
    if (!this.studioMode || !this.previewSceneId) return;
    this.activeSceneId = this.previewSceneId;
    this.emit('change');
  }
}

const instance = new SceneManager();

module.exports = instance;
module.exports.SOURCE_TYPES = SOURCE_TYPES;
module.exports.TRANSITIONS = TRANSITIONS;
