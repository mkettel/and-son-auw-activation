import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { RectAreaLightHelper } from "three/addons/helpers/RectAreaLightHelper.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/addons/renderers/CSS2DRenderer.js";
import Stats from "three/addons/libs/stats.module.js";

// ============ PCSS SOFT SHADOWS (like Drei's SoftShadows) ============
const pcssConfig = {
  size: 25, // Light size - larger = softer shadows
  samples: 10, // Quality - more samples = smoother but slower
  focus: 0, // Focus point - 0 = auto
};
window.pcssConfig = pcssConfig;

// ============ SUN CYCLE CONFIG ============
const sunCycleConfig = {
  sunrise: 6, // 6 AM
  sunset: 19, // 7 PM
  center: new THREE.Vector3(5, 0, 2),
  radius: 20,
};

// Sun cycle runtime state
const sunCycle = {
  override: false, // true when user pressed L to manually override
  lastUpdate: 0, // timestamp of last sun recalc
  isNight: false, // current day/night state
  targetPosition: new THREE.Vector3(19, 10, -6),
  targetIntensity: 8,
  targetColor: new THREE.Color(0xffb770),
  currentPosition: new THREE.Vector3(19, 10, -6),
  currentIntensity: 8,
  currentColor: new THREE.Color(0xffb770),
  // Sim controls
  sim: false, // true when using simulated time
  simHour: 12, // current simulated decimal hour
  simSpeed: 0, // multiplier: 0 = paused (slider-only), 60/360/etc = fast-forward
};

// Color temperature keyframes
const sunColors = {
  dawn: new THREE.Color(0xff8c42), // rich warm orange
  morning: new THREE.Color(0xffb770), // warm (current color)
  noon: new THREE.Color(0xfff4e0), // near-white warm
};

/**
 * Get sun position, intensity, and color for a given decimal hour.
 * @param {number} hour - Decimal hour (e.g. 14.5 = 2:30 PM)
 * @returns {{ position: THREE.Vector3, intensity: number, color: THREE.Color }}
 */
function getSunPosition(hour) {
  const { sunrise, sunset, center, radius } = sunCycleConfig;
  const dawnDuration = 2; // 2 hour ramp at dawn — longer warm glow
  const duskDuration = 2; // 2 hour ramp at dusk

  // Default: night
  let intensity = 0;
  const color = new THREE.Color();
  const position = new THREE.Vector3();

  if (hour >= sunrise && hour <= sunset) {
    // Map sunrise→sunset to 0→PI
    const t = (hour - sunrise) / (sunset - sunrise); // 0..1

    // Bias t so the sun lingers in the morning/low-angle zone longer.
    // Power < 1 stretches early values (morning) and compresses late (afternoon).
    const biasedT = Math.pow(t, 0.8);
    const angle = biasedT * Math.PI; // 0..PI

    // Sun arc: comes from the front of the room (like a garage door / storefront).
    // The front of the room is roughly +z direction.
    // x sweeps side to side, y rises/falls, z stays out in front.
    position.set(
      center.x + radius * Math.cos(angle) * 0.1, // sweeps left-to-right across front
      center.y + radius * Math.sin(angle) * 0.6, // lower arc — more raking angle
      center.z + radius * 0.7, // stays out in front of room
    );

    // Intensity ramp at dawn/dusk edges
    const hoursFromSunrise = hour - sunrise;
    const hoursFromSunset = sunset - hour;

    if (hoursFromSunrise < dawnDuration) {
      intensity = 6 * smoothstep(hoursFromSunrise / dawnDuration);
    } else if (hoursFromSunset < duskDuration) {
      intensity = 6 * smoothstep(hoursFromSunset / duskDuration);
    } else {
      intensity = 6;
    }

    // Color temperature: stay warm most of the day.
    // elevation 0..1..0 over the arc
    const elevation = Math.sin(angle);
    if (elevation < 0.4) {
      // Dawn/dusk zone: rich warm orange → morning warm (wider zone)
      const ct = elevation / 0.4;
      color.copy(sunColors.dawn).lerp(sunColors.morning, smoothstep(ct));
    } else {
      // Rest of day: mostly morning-warm, barely touching noon-white
      const ct = (elevation - 0.4) / 0.6; // 0..1
      const gentleCt = Math.pow(ct, 2.5); // stays warm even longer
      color.copy(sunColors.morning).lerp(sunColors.noon, gentleCt * 0.35); // cap at 35% toward noon
    }
  } else {
    // Night: below horizon
    intensity = 0;
    position.set(center.x, -5, center.z + radius * 0.7);
    color.copy(sunColors.dawn);
  }

  return { position, intensity, color };
}

/** Attempt a smooth Hermite-like step */
function smoothstep(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

// Patch Three.js shadow shaders for PCSS
let originalShaderChunk = THREE.ShaderChunk.shadowmap_pars_fragment;

const pcssGetShadow = `
#define PCSS_SAMPLES ${pcssConfig.samples}
#define PCSS_SIZE ${pcssConfig.size.toFixed(1)}

float PCSS_rand(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

vec2 PCSS_poissonDisk[16];

void PCSS_initPoissonSamples(vec2 seed) {
  float angle = PCSS_rand(seed) * 6.283185307179586;
  float radius = 1.0 / float(PCSS_SAMPLES);
  for (int i = 0; i < 16; i++) {
    float r = sqrt(float(i) + 0.5) * radius;
    PCSS_poissonDisk[i] = vec2(cos(angle), sin(angle)) * r;
    angle += 2.399963229728653;
  }
}

float PCSS_penumbraSize(float zReceiver, float zBlocker) {
  return (zReceiver - zBlocker) / zBlocker * PCSS_SIZE;
}

float PCSS_findBlocker(sampler2D shadowMap, vec2 uv, float zReceiver, float size) {
  float blockerSum = 0.0;
  float numBlockers = 0.0;
  for (int i = 0; i < PCSS_SAMPLES; i++) {
    vec2 offset = PCSS_poissonDisk[i % 16] * size / 2048.0;
    float shadowMapDepth = unpackRGBAToDepth(texture2D(shadowMap, uv + offset));
    if (shadowMapDepth < zReceiver) {
      blockerSum += shadowMapDepth;
      numBlockers += 1.0;
    }
  }
  return numBlockers > 0.0 ? blockerSum / numBlockers : -1.0;
}

float PCSS_PCF(sampler2D shadowMap, vec2 uv, float zReceiver, float filterRadius) {
  float sum = 0.0;
  for (int i = 0; i < PCSS_SAMPLES; i++) {
    vec2 offset = PCSS_poissonDisk[i % 16] * filterRadius / 2048.0;
    float depth = unpackRGBAToDepth(texture2D(shadowMap, uv + offset));
    sum += step(zReceiver, depth + 0.001);
  }
  return sum / float(PCSS_SAMPLES);
}

float PCSS_shadow(sampler2D shadowMap, vec4 coords) {
  vec2 uv = coords.xy;
  float zReceiver = coords.z;

  PCSS_initPoissonSamples(uv);

  float avgBlockerDepth = PCSS_findBlocker(shadowMap, uv, zReceiver, PCSS_SIZE);
  if (avgBlockerDepth < 0.0) return 1.0;

  float penumbraWidth = PCSS_penumbraSize(zReceiver, avgBlockerDepth);
  return PCSS_PCF(shadowMap, uv, zReceiver, penumbraWidth * PCSS_SIZE);
}
`;

// Override the DirectionalLight shadow function
THREE.ShaderChunk.shadowmap_pars_fragment =
  THREE.ShaderChunk.shadowmap_pars_fragment
    .replace("#ifdef USE_SHADOWMAP", "#ifdef USE_SHADOWMAP\n" + pcssGetShadow)
    .replace("return shadow;", "return PCSS_shadow(shadowMap, shadowCoord);")
    .replace(
      /texture2DCompare\s*\(\s*shadowMap\s*,\s*shadowCoord\.xy\s*,\s*shadowCoord\.z\s*\)/g,
      "PCSS_shadow(shadowMap, shadowCoord)",
    );

// Initialize RectAreaLight support
RectAreaLightUniformsLib.init();

// Performance monitor
const stats = new Stats();
document.body.appendChild(stats.dom);

// Scene setup
const scene = new THREE.Scene();

// Camera
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.set(0, 0, 5);

// Renderer
const canvas = document.getElementById("canvas");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.45;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap; // PCSS handles softening

// CSS2D overlay renderer (for hotspot indicators — synced with WebGL projection)
const css2dRenderer = new CSS2DRenderer();
css2dRenderer.setSize(window.innerWidth, window.innerHeight);
css2dRenderer.domElement.style.position = "absolute";
css2dRenderer.domElement.style.top = "0";
css2dRenderer.domElement.style.left = "0";
css2dRenderer.domElement.style.pointerEvents = "none";
css2dRenderer.domElement.id = "css2d-overlay";
document.body.appendChild(css2dRenderer.domElement);

// HDRI Environment (for subtle reflections)
const exrLoader = new EXRLoader();
exrLoader.load("/hdri/forest.exr", (texture) => {
  texture.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = texture;
});

// Camera mode config: 'mouse' or 'orbit'
const cameraConfig = {
  mode: "mouse", // 'mouse' = mouse-follow, 'orbit' = OrbitControls
};
window.cameraConfig = cameraConfig;

// Mouse-follow camera settings
const mouseTarget = { x: 0, y: 0 };
const mouseCurrent = { x: 0, y: 0 };
const cameraBasePosition = new THREE.Vector3();
const cameraLookCenter = new THREE.Vector3();
const cameraLookCurrent = new THREE.Vector3();
const cameraLookRange = { x: 2, y: 1 };

// Raycaster for DJ booth hover detection
const raycaster = new THREE.Raycaster();
const raycasterMouse = new THREE.Vector2();
const boothHover = { isHovered: false, mesh: null, decal: null };

// ============ CLICK-TO-FOCUS CAMERA SYSTEM ============
// Declarative map of clickable mesh names → camera behavior
// Each target can use EITHER:
//   cameraPosition + cameraLookAt  — explicit world-space coords (full control)
//   viewOffset + viewDistance       — auto-computed from mesh bounding box
// viewDistance only → auto-computes perpendicular view from mesh face normal
// cameraPosition + cameraLookAt → explicit world-space override
const focusTargets = {
  FRAME_LEFT_1: {
    viewDistance: 7.5,
    lerpBase: 0.008,
  },
  FRAME_LEFT_2: {
    viewDistance: 7.5,
    lerpBase: 0.008,
  },
  BOOTH_DJ: {
    // Explicit camera placement — tune these in console then paste back
    cameraPosition: new THREE.Vector3(10, 4.5, 16),
    cameraLookAt: new THREE.Vector3(19, 4.5, 0),
    lerpBase: 0.008,
  },
};

// ============ HOTSPOT INDICATORS ============
const hotspotConfig = {
  BOOTH_DJ: { elementId: "hotspot-booth", offsetY: 2.5 },
  FRAME_LEFT_1: { elementId: "hotspot-frame-left-1", offsetY: 1.5 },
};
const hotspots = []; // populated after model loads

// Focus mode state
const cameraFocus = {
  active: false,
  transitioning: false,
  meshName: null,
  targetPosition: new THREE.Vector3(),
  targetLookAt: new THREE.Vector3(),
  returnPosition: new THREE.Vector3(),
  returnLookAt: new THREE.Vector3(),
  lerpBase: 0.003,
  previousCameraMode: null,
};
const focusMeshMap = new Map(); // Mesh → config (populated after model loads)
const focusMeshList = []; // flat array for raycaster

// Close button reference
const focusCloseBtn = document.getElementById("focus-close-btn");

// ============ VIDEO TEXTURE FOR FRAMES ============
const videoEl = document.createElement("video");
videoEl.src = "/videos/and-son-video.mp4";
videoEl.crossOrigin = "anonymous";
videoEl.loop = true;
videoEl.muted = true; // muted so autoplay works; unmute after first interaction if needed
videoEl.playsInline = true;
videoEl.preload = "auto";

const videoTexture = new THREE.VideoTexture(videoEl);
videoTexture.colorSpace = THREE.SRGBColorSpace;
videoTexture.minFilter = THREE.LinearFilter;
videoTexture.magFilter = THREE.LinearFilter;

// Map mesh name → video plane (populated after model loads)
const videoPlanes = new Map();

/** Get the dominant face normal of a mesh in world space */
function getMeshWorldNormal(mesh) {
  const geometry = mesh.geometry;
  if (!geometry) return new THREE.Vector3(0, 0, 1);

  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const normalAttr = geometry.attributes.normal;

  // Average vertex normals to find dominant face direction
  const avg = new THREE.Vector3();
  const count = Math.min(normalAttr.count, 100);
  for (let i = 0; i < count; i++) {
    avg.x += normalAttr.getX(i);
    avg.y += normalAttr.getY(i);
    avg.z += normalAttr.getZ(i);
  }
  avg.normalize();

  // Transform from local to world space
  const worldQuat = new THREE.Quaternion();
  mesh.getWorldQuaternion(worldQuat);
  avg.applyQuaternion(worldQuat);

  return avg;
}

/** Compute where the camera should go when focusing on a mesh */
function computeFocusCamera(mesh, config) {
  // Explicit world-space overrides — full control per target
  if (config.cameraPosition && config.cameraLookAt) {
    return {
      position: config.cameraPosition.clone(),
      lookAt: config.cameraLookAt.clone(),
    };
  }

  // Auto-compute: perpendicular to mesh face at viewDistance
  const box = new THREE.Box3().setFromObject(mesh);
  const center = box.getCenter(new THREE.Vector3());
  const normal = getMeshWorldNormal(mesh);
  const dist = config.viewDistance || 2.0;

  const position = center.clone().add(normal.clone().multiplyScalar(dist));
  const lookAt = center.clone();

  return { position, lookAt };
}

/** Enter focus mode — lerp camera to viewing position in front of mesh */
function enterFocusMode(mesh, config) {
  // Use the primary focus mesh if specified (e.g. decal → booth)
  const targetMesh = config.focusMesh || mesh;

  // Save return targets
  cameraFocus.returnPosition.copy(camera.position);
  cameraFocus.returnLookAt.copy(cameraLookCurrent);

  // Compute focus targets
  const { position, lookAt } = computeFocusCamera(targetMesh, config);
  cameraFocus.targetPosition.copy(position);
  cameraFocus.targetLookAt.copy(lookAt);
  cameraFocus.lerpBase = config.lerpBase;
  cameraFocus.meshName = targetMesh.name;

  // Debug: log computed positions so you can tune or switch to explicit mode
  console.log(`Focus → ${targetMesh.name}`);
  console.log(
    `  center:`,
    lookAt.toArray().map((v) => +v.toFixed(2)),
  );
  console.log(
    `  cameraPos:`,
    position.toArray().map((v) => +v.toFixed(2)),
  );
  console.log(
    `  normal:`,
    getMeshWorldNormal(targetMesh)
      .toArray()
      .map((v) => +v.toFixed(2)),
  );

  // Save and disable OrbitControls
  cameraFocus.previousCameraMode = cameraConfig.mode;
  if (cameraConfig.mode === "orbit") {
    controls.enabled = false;
  }

  cameraFocus.active = true;
  cameraFocus.transitioning = true;

  // Show close button
  if (focusCloseBtn) focusCloseBtn.classList.remove("hidden");

  // Play video if this frame has a video plane (resume from where it left off)
  if (videoPlanes.has(mesh.name)) {
    videoEl.play().catch(() => {});
  }
}

/** Exit focus mode — lerp camera back to saved return position */
function exitFocusMode() {
  if (!cameraFocus.active && !cameraFocus.transitioning) return;

  cameraFocus.targetPosition.copy(cameraFocus.returnPosition);
  cameraFocus.targetLookAt.copy(cameraFocus.returnLookAt);
  cameraFocus.active = false;
  cameraFocus.transitioning = true;

  // Hide close button
  if (focusCloseBtn) focusCloseBtn.classList.add("hidden");

  // Pause video
  videoEl.pause();
}

/** Called when camera arrives back at return position */
function finishFocusReturn() {
  cameraFocus.transitioning = false;
  cameraFocus.meshName = null;

  // Restore previous camera mode
  if (cameraFocus.previousCameraMode === "orbit") {
    cameraConfig.mode = "orbit";
    controls.target.copy(cameraFocus.returnLookAt);
    controls.enabled = true;
    controls.update();
  }
  cameraFocus.previousCameraMode = null;
}

// Track mouse position (normalized -1 to 1)
window.addEventListener("mousemove", (e) => {
  mouseTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseTarget.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycasterMouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  raycasterMouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

// OrbitControls setup
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1;
controls.maxDistance = 100;
controls.enabled = false; // Start with mouse mode

// Toggle camera mode with 'C' key (blocked during focus)
window.addEventListener("keydown", (e) => {
  if (e.key === "c" || e.key === "C") {
    if (cameraFocus.active || cameraFocus.transitioning) return;

    cameraConfig.mode = cameraConfig.mode === "mouse" ? "orbit" : "mouse";
    controls.enabled = cameraConfig.mode === "orbit";

    // Reset orbit controls target when switching to orbit mode
    if (cameraConfig.mode === "orbit" && cameraLookCenter.length() > 0) {
      controls.target.copy(cameraLookCenter);
      controls.update();
    }

    console.log("Camera mode:", cameraConfig.mode);
  }
});

// Click handler for focus targets (X button / Escape to exit, not click)
canvas.addEventListener("click", (e) => {
  if (cameraFocus.active || cameraFocus.transitioning) return;
  if (focusMeshList.length === 0) return;

  const clickMouse = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(clickMouse, camera);
  const hits = raycaster.intersectObjects(focusMeshList, false);
  if (hits.length > 0) {
    const hitMesh = hits[0].object;
    const config = focusMeshMap.get(hitMesh);
    if (config) enterFocusMode(hitMesh, config);
  }
});

// Escape key exits focus mode
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (cameraFocus.active || cameraFocus.transitioning)) {
    exitFocusMode();
  }
});

// Close button exits focus mode
if (focusCloseBtn) {
  focusCloseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    exitFocusMode();
  });
}

// Loading manager
const loadingElement = document.getElementById("loading");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");

// DRACO loader (for compressed models)
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(
  "https://www.gstatic.com/draco/versioned/decoders/1.5.6/",
);

// GLTF loader
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// Load model
gltfLoader.load(
  "/models/son-and-store-keep-meshes.glb",
  (gltf) => {
    const model = gltf.scene;
    model.rotation.y = -1.1;
    scene.add(model);

    // Auto-fit camera to model
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    cameraZ *= 0.6; // Add some padding

    camera.position.set(
      center.x + cameraZ * 0.5,
      center.y + cameraZ * 0.0,
      center.z + cameraZ,
    );
    camera.lookAt(center);

    // Store base camera position and look target for mouse-follow
    cameraBasePosition.copy(camera.position);
    cameraLookCenter.copy(center);
    cameraLookCurrent.copy(center);

    // Set envMapIntensity and enable shadows on all meshes
    model.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.envMapIntensity = 0.9;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // Hide cactus in main model (using separate cactus model instead)
    // Also hide old flat frame meshes (replaced by new STORE VIDEO FRAME model)
    model.traverse((child) => {
      if (child.name.toLowerCase().includes("cactus")) {
        child.visible = false;
      }
      if (child.name === "FRAME_LEFT_1" || child.name === "FRAME_LEFT_2") {
        child.visible = false;
      }
    });

    // ============ ROOM TEXTURE COMPARISON (TEMPORARY) ============
    // We have two versions of the room shell (walls + floor only, no interior items):
    //   OLD: Room meshes baked into son-and-store-keep-meshes.glb, flat colors set in JS
    //   NEW: Separate room.gltf in /models/room/ with PBR textures (concrete walls, wood plank floor)
    // Press 'R' to toggle between them for side-by-side comparison.
    // Once we pick a direction, remove the unused version and this toggle code.
    // ================================================================

    // Collect old room meshes for toggle (keep visible until new room loads)
    const oldRoomMeshes = [];
    model.traverse((child) => {
      if (child.name.toLowerCase().includes("room")) {
        oldRoomMeshes.push(child);
      }
    });

    // Load separate cactus model
    gltfLoader.load("/models/cactus.gltf", (cactusGltf) => {
      const cactusModel = cactusGltf.scene;

      // Match the main model rotation
      cactusModel.rotation.y = -1.1;

      // Position it (adjust as needed)
      cactusModel.position.set(0, 0, 0);

      scene.add(cactusModel);

      // Expose for positioning in console
      window.cactusModel = cactusModel;
      console.log(
        "Cactus loaded. Adjust position with: cactusModel.position.set(x, y, z)",
      );

      // Log cactus meshes and enable shadows
      const cactusMeshes = [];
      cactusModel.traverse((child) => {
        if (child.isMesh) {
          cactusMeshes.push({ name: child.name, material: child.material });
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      window.cactusMaterials = cactusMeshes;
      console.log(
        "Cactus meshes:",
        cactusMeshes.map((c) => c.name),
      );

      // Set the colors of the cactus meshes individually
      // Pot
      cactusMaterials[0].material.color.set(0x4d1e04);
      cactusMaterials[0].material.roughness = 0.3;
      cactusMaterials[0].material.metalness = 0.1;
      cactusMaterials[0].material.envMapIntensity = 0.9;

      // Spikes
      cactusMaterials[1].material.color.set(0xffffff);
      cactusMaterials[1].material.roughness = 0.7;
      cactusMaterials[1].material.metalness = 0.1;
      cactusMaterials[1].material.envMapIntensity = 0.9;

      // Body
      cactusMaterials[2].material.color.set(0x1e2816);
      cactusMaterials[2].material.roughness = 0.8;
      cactusMaterials[2].material.metalness = 0.1;
      cactusMaterials[2].material.envMapIntensity = 0.9;

      // Ground
      cactusMaterials[3].material.color.set(0x1e2816);
      cactusMaterials[3].material.roughness = 0.8;
      cactusMaterials[3].material.metalness = 0.1;
      cactusMaterials[3].material.envMapIntensity = 0.9;
    });

    // ============ ROOM TOGGLE (Press 'R') ============
    // Toggle between old room (flat colors from GLB) and new room (textured GLTF)
    window.roomToggle = {
      useNewRoom: true, // Start with new textured room
      oldRoomMeshes: oldRoomMeshes,
      newRoomModel: null, // Set once loaded
    };

    window.addEventListener("keydown", (e) => {
      if (e.key === "r" || e.key === "R") {
        const toggle = window.roomToggle;
        toggle.useNewRoom = !toggle.useNewRoom;

        // Show/hide old room meshes
        toggle.oldRoomMeshes.forEach((mesh) => {
          mesh.visible = !toggle.useNewRoom;
        });

        // Show/hide new room model
        if (toggle.newRoomModel) {
          toggle.newRoomModel.visible = toggle.useNewRoom;
        }

        // Update legend status
        const statusEl = document.getElementById("room-status");
        if (statusEl)
          statusEl.textContent = toggle.useNewRoom
            ? "new (textured)"
            : "old (flat colors)";

        console.log(
          "Room mode:",
          toggle.useNewRoom ? "NEW (textured)" : "OLD (flat colors)",
        );
      }
    });

    // Load new room model (textured walls + floor with cutout window)
    gltfLoader.load("/models/room/room.gltf", (roomGltf) => {
      const roomModel = roomGltf.scene;

      // Match the main model rotation
      roomModel.rotation.y = -1.1;

      // Room shell receives shadows but doesn't cast them
      // (prevents the ceiling edge from casting a hard line on the back wall)
      roomModel.traverse((child) => {
        if (child.isMesh) {
          child.receiveShadow = true;
          child.castShadow = false;
          if (child.material) {
            child.material.envMapIntensity = 0.9;
          }
        }
      });

      // Log room mesh names for reference
      const roomMats = {};
      roomModel.traverse((child) => {
        if (child.isMesh && child.material) {
          roomMats[child.name] = child.material;
        }
      });
      window.roomMaterials = roomMats;
      console.log("Room mesh names:", Object.keys(roomMats));

      scene.add(roomModel);

      // Now that the new room is ready, hide the old room meshes
      oldRoomMeshes.forEach((mesh) => {
        mesh.visible = false;
      });

      window.roomModel = roomModel;
      window.roomToggle.newRoomModel = roomModel;

      // Add room materials to light switch system if already initialized
      if (window.lightSwitch) {
        roomModel.traverse((child) => {
          if (
            child.isMesh &&
            child.material &&
            child.material.envMapIntensity !== undefined
          ) {
            window.lightSwitch.materials.push({
              material: child.material,
              onIntensity: child.material.envMapIntensity,
              offIntensity: 0.55,
              current: child.material.envMapIntensity,
              target: child.material.envMapIntensity,
            });
          }
        });
      }
    });

    // Get LOGO mesh and material colors (with safety check)
    const logoMesh = model.getObjectByName("LOGO");
    if (logoMesh?.material) {
      logoMesh.material.color.set(0xffffff);
      logoMesh.material.roughness = 0.8;
      logoMesh.material.metalness = 0.1;
      logoMesh.material.envMapIntensity = 1.7;
      logoMesh.material.emissive.set(0xffffff);
      logoMesh.material.emissiveIntensity = 0.8;
    }

    // Floor (ROOM_2) - used when toggled back to old room
    const floorMesh = model.getObjectByName("ROOM_2");
    if (floorMesh?.material) {
      floorMesh.material.color.set(0xd4bc94); // Warmer golden wood (lighter)
      floorMesh.material.roughness = 0.8;
      floorMesh.material.envMapIntensity = 0.99;
      window.floorMaterial = floorMesh.material;
    }

    // Rug Materials - matte fabric look
    const rugMesh = model.getObjectByName("Shaggy_carpet");
    if (rugMesh?.material) {
      rugMesh.material.roughness = 0.6;
      rugMesh.material.metalness = 0.0;
      rugMesh.material.envMapIntensity = 1;
      // rugMesh.material.metalnessMap = null;
      // rugMesh.material.roughnessMap = null;
      // Fix sheen and specular
      rugMesh.material.sheen = 0; // Disable sheen
      rugMesh.material.specularIntensity = 0.8; // No specular
      rugMesh.material.needsUpdate = true;
      window.rugMaterial = rugMesh.material;
    }

    // ============ DECAL (AUW Logo) on DJ Booth ============
    const boothMesh = model.getObjectByName("BOOTH_DJ");
    if (boothMesh) {
      // Store booth mesh ref for raycasting
      boothHover.mesh = boothMesh;

      const textureLoader = new THREE.TextureLoader();
      textureLoader.load("/textures/test-decal.png", (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;

        const decalGeometry = new THREE.PlaneGeometry(1, 1);
        const decalMaterial = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        });

        const decal = new THREE.Mesh(decalGeometry, decalMaterial);

        // Get booth position and place decal on front face
        const box = new THREE.Box3().setFromObject(boothMesh);
        const center = box.getCenter(new THREE.Vector3());

        decal.position.copy(center);
        decal.position.z += 1.15; // Offset slightly in front
        decal.rotation.y = 0.6; // Match model rotation
        decal.position.x += 2.7;
        decal.position.y += -2.0;
        decal.scale.set(0.6, 0.6, 1);
        scene.add(decal);

        // Store decal ref for hover detection
        boothHover.decal = decal;

        // Register decal as a click target so clicking the logo also focuses the booth
        const boothConfig = focusTargets.BOOTH_DJ;
        if (boothConfig && boothMesh) {
          focusMeshMap.set(decal, { ...boothConfig, focusMesh: boothMesh });
          focusMeshList.push(decal);
        }

        window.decal = decal;
        window.boothMesh = boothMesh;
        console.log(
          "Decal placed on BOOTH_DJ at:",
          center.toArray().map((v) => +v.toFixed(2)),
        );
        console.log("Adjust with: decal.position.set(x, y, z)");
        console.log("Resize with: decal.scale.set(w, h, 1)");
        console.log(
          "Booth focus tuning — paste camera.position and cameraLookCurrent into focusTargets.BOOTH_DJ",
        );
        console.log(
          "  Use: camera.position.toArray() and cameraLookCurrent.toArray() while viewing the booth",
        );
      });
    }

    // Map and log all meshes
    const meshes = {};
    model.traverse((child) => {
      if (child.isMesh && child.material) meshes[child.name] = child.material;
    });
    window.meshes = meshes;

    // Resolve focus target meshes + create video planes
    for (const [meshName, config] of Object.entries(focusTargets)) {
      const mesh = model.getObjectByName(meshName);
      if (mesh) {
        focusMeshMap.set(mesh, config);
        focusMeshList.push(mesh);
        console.log(`Focus target resolved: ${meshName}`);

        // Skip video plane for non-frame targets
        if (!meshName.startsWith("FRAME")) continue;

        // Create a video plane overlaying the frame's canvas area
        const frameBox = new THREE.Box3().setFromObject(mesh);
        const frameCenter = frameBox.getCenter(new THREE.Vector3());
        const frameSize = frameBox.getSize(new THREE.Vector3());
        const normal = getMeshWorldNormal(mesh);

        // Plane sized to fit inside the wood frame
        const planeW = Math.max(frameSize.x, frameSize.z) * 1.21;
        const planeH = frameSize.y * 0.78;
        const planeGeom = new THREE.PlaneGeometry(planeW, planeH);
        const planeMat = new THREE.MeshBasicMaterial({
          map: videoTexture,
          side: THREE.DoubleSide,
          toneMapped: false,
        });

        const videoPlane = new THREE.Mesh(planeGeom, planeMat);

        // Derive exact wall normal from model rotation (not averaged mesh normals)
        // The frame's local outward normal is (0,0,-1), rotated by model's world transform
        const wallNormal = new THREE.Vector3(0, 0, -1);
        wallNormal.applyQuaternion(
          new THREE.Quaternion().setFromEuler(model.rotation),
        );

        videoPlane.position.copy(frameCenter);
        // Nudge back toward wall — tweak this value to sit flush on canvas
        videoPlane.position.add(wallNormal.clone().multiplyScalar(-0.091));
        videoPlane.lookAt(videoPlane.position.clone().add(wallNormal));

        scene.add(videoPlane);
        videoPlanes.set(meshName, videoPlane);

        // Expose for tweaking in console
        window[`videoPlane_${meshName}`] = videoPlane;
        console.log(`Video plane created for ${meshName}:`, {
          position: videoPlane.position.toArray().map((v) => +v.toFixed(2)),
          size: [+planeW.toFixed(2), +planeH.toFixed(2)],
        });
      } else {
        console.warn(`Focus target mesh not found: ${meshName}`);
      }
    }

    // ============ POPULATE HOTSPOTS (CSS2DObject) ============
    for (const [meshName, hConfig] of Object.entries(hotspotConfig)) {
      const mesh = model.getObjectByName(meshName);
      if (!mesh) continue;

      // Build DOM element
      const el = document.getElementById(hConfig.elementId);
      if (!el) continue;
      // Remove from document flow — CSS2DRenderer will own it
      el.remove();

      // Wrap in CSS2DObject and position in world space
      const css2dObj = new CSS2DObject(el);
      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      css2dObj.position.set(center.x, center.y + hConfig.offsetY, center.z);
      scene.add(css2dObj);

      hotspots.push({ element: el, css2dObj, meshName });

      // Click handler — trigger existing focus mode
      el.addEventListener("click", () => {
        if (cameraFocus.active || cameraFocus.transitioning) return;
        const focusConfig = focusMeshMap.get(mesh);
        if (focusConfig) enterFocusMode(mesh, focusConfig);
      });
    }

    // Fade hotspots in after a short delay
    setTimeout(() => {
      hotspots.forEach((h) => h.element.classList.add("visible"));
    }, 800);

    // ============ LOAD NEW STORE VIDEO FRAME MODEL (visual only) ============
    gltfLoader.load("/models/STORE VIDEO FRAME.gltf", (frameGltf) => {
      ["FRAME_LEFT_1", "FRAME_LEFT_2"].forEach((frameName) => {
        const oldMesh = model.getObjectByName(frameName);
        if (!oldMesh) return;

        const newFrame = frameGltf.scene.clone();
        newFrame.rotation.y = -1.1;

        // Align new frame to old frame's world-space center
        const oldBox = new THREE.Box3().setFromObject(oldMesh);
        const oldCenter = oldBox.getCenter(new THREE.Vector3());
        const gltfNode = frameGltf.scene.children[0];
        const bakedTranslation = gltfNode.position.clone();
        const rotatedOffset = bakedTranslation
          .clone()
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), -1.1);
        newFrame.position.copy(oldCenter).sub(rotatedOffset);

        newFrame.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            if (child.material) child.material.envMapIntensity = 0.9;
          }
        });

        scene.add(newFrame);

        // Nudge the existing video plane forward so it sits on top of the new 3D frame
        const vp = videoPlanes.get(frameName);
        if (vp) {
          const wallNormal = new THREE.Vector3(0, 0, -1);
          wallNormal.applyQuaternion(
            new THREE.Quaternion().setFromEuler(model.rotation),
          );
          // Move from old offset (-0.091 into wall) to in front of the new frame
          vp.position.add(wallNormal.clone().multiplyScalar(0.1));
        }

        console.log(`New frame placed for ${frameName}`);
      });
    });

    console.log("=== ALL MESHES IN MODEL ===");
    console.log("Total count:", Object.keys(meshes).length);
    console.log("Names:", Object.keys(meshes));
    console.table(Object.keys(meshes).map((name) => ({ name })));

    // // DEBUG: Uncomment to expose ALL materials
    // const materials = {};
    // model.traverse((child) => {
    //   if (child.isMesh && child.material) materials[child.name] = child.material;
    // });
    // window.materials = materials;
    // console.log('Materials exposed:', Object.keys(materials));

    // ============ LIGHTING SETUP ============
    // Colors
    const warmColor = 0xffb770; // Warm orange for lamp and area lights
    const whiteColor = 0xffffff; // White for sconces

    // --- LAMP (Point Light - diffuse glow through shade) ---
    const lampPointLight = new THREE.PointLight(warmColor, 3, 12, 2);
    lampPointLight.position.set(-2.7, 4.0, 8.75);
    scene.add(lampPointLight);
    window.lampPointLight = lampPointLight;

    // --- LAMP (Spotlight - pointing up) ---
    const lampLightUp = new THREE.SpotLight(
      warmColor,
      15,
      15,
      Math.PI / 4,
      1,
      1,
    );
    lampLightUp.position.set(-2.7, 4.0, 8.75);
    lampLightUp.target.position.set(-2.7, 10, 8.75);
    scene.add(lampLightUp);
    scene.add(lampLightUp.target);
    window.lampLightUp = lampLightUp;

    // --- LAMP (Spotlight - pointing down) ---
    const lampLightDown = new THREE.SpotLight(
      warmColor,
      15,
      10,
      Math.PI / 3,
      1,
      1,
    );
    lampLightDown.position.set(-2.7, 4.0, 8.75);
    lampLightDown.target.position.set(-2.7, 0, 8.75);
    scene.add(lampLightDown);
    scene.add(lampLightDown.target);
    window.lampLightDown = lampLightDown;

    // --- SCONCES (Point Lights - white) ---
    // Left sconce
    const sconceLeft = new THREE.PointLight(warmColor, 5, 10, 1);
    sconceLeft.position.set(-4, 6.5, 1.2);
    scene.add(sconceLeft);

    // Right sconce
    const sconceRight = new THREE.PointLight(warmColor, 5, 10, 1);
    sconceRight.position.set(14.3, 6.5, -6.9);
    scene.add(sconceRight);

    // --- WALL/CEILING FILL LIGHTS (no shadows, cheap) ---
    // HemisphereLight: cheapest light in Three.js — uniform warm fill everywhere
    // Sky color warm, ground color slightly darker warm — lifts all surfaces
    const hemiLight = new THREE.HemisphereLight(0xffe0b2, 0x806040, 0.6);
    scene.add(hemiLight);

    // Stronger PointLights close to side walls to push warmth onto them
    const fillLeft = new THREE.PointLight(warmColor, 4, 18, 1);
    fillLeft.position.set(-5, 5.5, 2);
    scene.add(fillLeft);

    const fillRight = new THREE.PointLight(warmColor, 4, 18, 1);
    fillRight.position.set(15, 5.5, -3);
    scene.add(fillRight);

    // Ceiling fill — placed right below ceiling, wider range
    const fillCeiling = new THREE.PointLight(warmColor, 3, 16, 1);
    fillCeiling.position.set(5, 10.5, 2);
    scene.add(fillCeiling);

    // Ambient light — low for window light contrast
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.15);
    scene.add(ambientLight);

    // Directional light (simulates sunlight through window)
    const sunLight = new THREE.DirectionalLight(0xffb770, 6); // Soft warm sunlight
    sunLight.position.set(19, 10, -6); // Coming from window direction (left side) 19,7,20
    sunLight.target.position.set(0, 0.5, 3);
    scene.add(sunLight.target);
    sunLight.castShadow = true;

    // Shadow settings — wide frustum to cover entire room without clipping
    sunLight.shadow.mapSize.width = 4096;
    sunLight.shadow.mapSize.height = 4096;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 120;
    sunLight.shadow.camera.left = -50;
    sunLight.shadow.camera.right = 50;
    sunLight.shadow.camera.top = 50;
    sunLight.shadow.camera.bottom = -50;
    sunLight.shadow.bias = -0.0001;
    // PCSS handles shadow softness via pcssConfig.size

    scene.add(sunLight);
    window.sunLight = sunLight;
    window.sunCycle = sunCycle;
    window.getSunPosition = getSunPosition;

    // ============ LIGHT SWITCH (Press 'L') ============
    // Collect all materials for envMapIntensity control
    const allMaterials = [];
    model.traverse((child) => {
      if (
        child.isMesh &&
        child.material &&
        child.material.envMapIntensity !== undefined
      ) {
        allMaterials.push({
          material: child.material,
          onIntensity: child.material.envMapIntensity, // current value as "on" value
          offIntensity: 0.95, // dim when lights off
          current: child.material.envMapIntensity,
          target: child.material.envMapIntensity,
        });
      }
    });

    // Room lights (on when bright) vs practical lights (on when dark)
    window.lightSwitch = {
      on: true, // room lights on
      roomLights: [
        { light: ambientLight, onIntensity: 0.15, current: 0.15, target: 0.15 },
        { light: sunLight, onIntensity: 6, current: 6, target: 6 },
        { light: hemiLight, onIntensity: 0.6, current: 0.6, target: 0.6 },
        { light: fillLeft, onIntensity: 4, current: 4, target: 4 },
        { light: fillRight, onIntensity: 4, current: 4, target: 4 },
        { light: fillCeiling, onIntensity: 3, current: 3, target: 3 },
      ],
      practicalLights: [
        // These turn ON when room lights are OFF
        { light: lampPointLight, onIntensity: 3, current: 0, target: 0 },
        { light: lampLightUp, onIntensity: 15, current: 0, target: 0 },
        { light: lampLightDown, onIntensity: 15, current: 0, target: 0 },
        { light: sconceLeft, onIntensity: 5, current: 0, target: 0 },
        { light: sconceRight, onIntensity: 5, current: 0, target: 0 },
      ],
      materials: allMaterials,
    };

    // Initialize sun cycle state based on current time
    {
      const date = new Date();
      const currentHour =
        date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
      const sun = getSunPosition(currentHour);

      sunCycle.targetPosition.copy(sun.position);
      sunCycle.currentPosition.copy(sun.position);
      sunCycle.targetIntensity = sun.intensity;
      sunCycle.currentIntensity = sun.intensity;
      sunCycle.targetColor.copy(sun.color);
      sunCycle.currentColor.copy(sun.color);
      sunCycle.isNight = sun.intensity < 0.1;

      // Apply immediately
      sunLight.position.copy(sun.position);
      sunLight.intensity = sun.intensity;
      sunLight.color.copy(sun.color);

      if (sunCycle.isNight) {
        // Night: practical lights on, ambient dimmed
        window.lightSwitch.on = false;
        window.lightSwitch.roomLights.forEach((l) => {
          if (l.light === sunLight) return;
          l.current = 0.02;
          l.target = 0.02;
          l.light.intensity = 0.02;
        });
        window.lightSwitch.practicalLights.forEach((l) => {
          l.current = l.onIntensity;
          l.target = l.onIntensity;
          l.light.intensity = l.onIntensity;
        });
        window.lightSwitch.materials.forEach((m) => {
          m.current = m.offIntensity;
          m.target = m.offIntensity;
          m.material.envMapIntensity = m.offIntensity;
        });
      } else {
        // Day: practical lights off
        window.lightSwitch.practicalLights.forEach(
          (l) => (l.light.intensity = 0),
        );
      }
    }

    window.addEventListener("keydown", (e) => {
      if (e.key === "l" || e.key === "L") {
        if (sunCycle.override) {
          // Second press: release override, return to auto mode
          sunCycle.override = false;
          console.log("Light override OFF — returning to auto sun cycle");
        } else {
          // First press: enable override and toggle lights
          sunCycle.override = true;
          window.lightSwitch.on = !window.lightSwitch.on;
          const on = window.lightSwitch.on;
          // Room lights: on when bright
          window.lightSwitch.roomLights.forEach((l) => {
            l.target = on ? l.onIntensity : 0;
          });
          // Practical lights: on when dark (opposite)
          window.lightSwitch.practicalLights.forEach((l) => {
            l.target = on ? 0 : l.onIntensity;
          });
          // Materials envMapIntensity: high when bright, low when dark
          window.lightSwitch.materials.forEach((m) => {
            m.target = on ? m.onIntensity : m.offIntensity;
          });
          console.log("Light override ON — lights:", on ? "ON" : "OFF");
        }
      }
    });

    console.log("Lighting setup complete");

    // ============ LIGHT HELPERS (for positioning) ============
    // Press 'H' to toggle helpers
    const helpers = [];

    const lampPointHelper = new THREE.PointLightHelper(lampPointLight, 0.3);
    scene.add(lampPointHelper);
    helpers.push(lampPointHelper);

    const lampHelperUp = new THREE.SpotLightHelper(lampLightUp);
    scene.add(lampHelperUp);
    helpers.push(lampHelperUp);

    const lampHelperDown = new THREE.SpotLightHelper(lampLightDown);
    scene.add(lampHelperDown);
    helpers.push(lampHelperDown);

    const sconceLeftHelper = new THREE.PointLightHelper(sconceLeft, 0.3);
    scene.add(sconceLeftHelper);
    helpers.push(sconceLeftHelper);

    const sconceRightHelper = new THREE.PointLightHelper(sconceRight, 0.3);
    scene.add(sconceRightHelper);
    helpers.push(sconceRightHelper);

    // const areaLeftHelper = new RectAreaLightHelper(areaLeft);
    // scene.add(areaLeftHelper);
    // helpers.push(areaLeftHelper);

    // const areaRightHelper = new RectAreaLightHelper(areaRight);
    // scene.add(areaRightHelper);
    // helpers.push(areaRightHelper);

    // const areaTopHelper = new RectAreaLightHelper(areaTop);
    // scene.add(areaTopHelper);
    // helpers.push(areaTopHelper);

    const sunHelper = new THREE.DirectionalLightHelper(sunLight, 2);
    scene.add(sunHelper);
    helpers.push(sunHelper);

    // Shadow camera helper (shows shadow frustum bounds)
    const shadowCameraHelper = new THREE.CameraHelper(sunLight.shadow.camera);
    scene.add(shadowCameraHelper);
    helpers.push(shadowCameraHelper);

    // Hide helpers by default
    helpers.forEach((helper) => (helper.visible = false));

    // Toggle helpers with 'H' key
    window.addEventListener("keydown", (e) => {
      if (e.key === "h" || e.key === "H") {
        helpers.forEach((helper) => (helper.visible = !helper.visible));
        console.log("Helpers:", helpers[0].visible ? "ON" : "OFF");
      }
    });

    // Hide loading screen
    loadingElement.classList.add("hidden");

    console.log("Model loaded successfully");
  },
  (progress) => {
    if (progress.total > 0) {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      progressFill.style.width = `${percent}%`;
      progressText.textContent = `${percent}%`;
    }
  },
  (error) => {
    console.error("Error loading model:", error);
    progressText.textContent = "Error loading model";
    progressText.style.color = "#ff4444";
  },
);

// Handle window resize
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  css2dRenderer.setSize(window.innerWidth, window.innerHeight);
});

// ============ TIME SIM CONTROLS ============
function activateSim(speed) {
  const date = new Date();
  if (!sunCycle.sim) {
    // Starting sim — seed from current real time
    sunCycle.simHour =
      date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  }
  sunCycle.sim = true;
  sunCycle.simSpeed = speed;
  sunCycle.override = false; // clear L-key override so sun cycle drives lights
  const slider = document.getElementById("time-slider");
  if (slider) slider.value = sunCycle.simHour;
  updateSimButtons();
}

function deactivateSim() {
  sunCycle.sim = false;
  sunCycle.simSpeed = 0;
  sunCycle.override = false;
  updateSimButtons();
}

function updateSimButtons() {
  document
    .querySelectorAll(".sim-btn")
    .forEach((btn) => btn.classList.remove("active"));
  if (!sunCycle.sim) {
    const resetBtn = document.getElementById("sim-reset");
    if (resetBtn) resetBtn.classList.add("active");
    return;
  }
  const speedMap = {
    0: "sim-speed-0",
    1: "sim-speed-1",
    6: "sim-speed-6",
    24: "sim-speed-24",
  };
  const activeId = speedMap[sunCycle.simSpeed];
  if (activeId) {
    const btn = document.getElementById(activeId);
    if (btn) btn.classList.add("active");
  }
}

// Slider: dragging sets sim hour directly
const timeSlider = document.getElementById("time-slider");
if (timeSlider) {
  timeSlider.addEventListener("input", (e) => {
    if (!sunCycle.sim) activateSim(0); // activate sim in paused mode on first drag
    sunCycle.simHour = parseFloat(e.target.value);
  });
}

// Speed buttons
document
  .getElementById("sim-speed-0")
  ?.addEventListener("click", () => activateSim(0));
document
  .getElementById("sim-speed-1")
  ?.addEventListener("click", () => activateSim(1));
document
  .getElementById("sim-speed-6")
  ?.addEventListener("click", () => activateSim(6));
document
  .getElementById("sim-speed-24")
  ?.addEventListener("click", () => activateSim(24));
document
  .getElementById("sim-reset")
  ?.addEventListener("click", () => deactivateSim());

// Mark "Live" as active by default
updateSimButtons();

// Animation loop with deltaTime for consistent speed
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  stats.update();

  // Camera mode handling (three-branch priority)
  if (cameraFocus.active || cameraFocus.transitioning) {
    // Focus mode: lerp camera toward focus/return target
    const focusLerp = 1 - Math.pow(cameraFocus.lerpBase, delta);
    camera.position.lerp(cameraFocus.targetPosition, focusLerp);
    cameraLookCurrent.lerp(cameraFocus.targetLookAt, focusLerp);
    camera.lookAt(cameraLookCurrent);

    // Check if arrived at target
    const posDist = camera.position.distanceTo(cameraFocus.targetPosition);
    const lookDist = cameraLookCurrent.distanceTo(cameraFocus.targetLookAt);
    if (posDist < 0.01 && lookDist < 0.01) {
      camera.position.copy(cameraFocus.targetPosition);
      cameraLookCurrent.copy(cameraFocus.targetLookAt);
      if (cameraFocus.active) {
        // Arrived at focus target — stop transitioning
        cameraFocus.transitioning = false;
      } else {
        // Arrived back at return position
        finishFocusReturn();
      }
    }
  } else if (cameraConfig.mode === "mouse") {
    // Smooth mouse-follow camera - look at where mouse is pointing
    const lerpSpeed = 1 - Math.pow(0.001, delta);
    mouseCurrent.x += (mouseTarget.x - mouseCurrent.x) * lerpSpeed;
    mouseCurrent.y += (mouseTarget.y - mouseCurrent.y) * lerpSpeed;

    if (cameraLookCenter.length() > 0) {
      const targetLookX =
        cameraLookCenter.x + mouseCurrent.x * cameraLookRange.x;
      const targetLookY =
        cameraLookCenter.y + mouseCurrent.y * cameraLookRange.y;

      cameraLookCurrent.x += (targetLookX - cameraLookCurrent.x) * lerpSpeed;
      cameraLookCurrent.y += (targetLookY - cameraLookCurrent.y) * lerpSpeed;

      camera.lookAt(cameraLookCurrent);
    }
  } else {
    // Orbit controls mode
    controls.update();
  }

  // ============ SUN CYCLE UPDATE ============
  // Advance sim time each frame when speed > 0
  if (sunCycle.sim && sunCycle.simSpeed > 0) {
    sunCycle.simHour += (delta * sunCycle.simSpeed) / 60; // simSpeed = hours per real-minute, delta in seconds
    if (sunCycle.simHour >= 24) sunCycle.simHour -= 24;
    if (sunCycle.simHour < 0) sunCycle.simHour += 24;
    // Update slider to match
    const slider = document.getElementById("time-slider");
    if (slider) slider.value = sunCycle.simHour;
  }

  if (window.lightSwitch && window.sunLight) {
    const now = performance.now();
    const updateInterval = sunCycle.sim ? 50 : 1000; // faster updates during sim
    if (now - sunCycle.lastUpdate > updateInterval) {
      sunCycle.lastUpdate = now;

      let currentHour;
      if (sunCycle.sim) {
        currentHour = sunCycle.simHour;
      } else {
        const date = new Date();
        currentHour =
          date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
      }
      const sun = getSunPosition(currentHour);

      // Update sun targets
      sunCycle.targetPosition.copy(sun.position);
      sunCycle.targetIntensity = sun.intensity;
      sunCycle.targetColor.copy(sun.color);

      // Determine night state
      const wasNight = sunCycle.isNight;
      sunCycle.isNight = sun.intensity < 0.1;

      // Auto-toggle practical lights when day/night changes (unless overridden)
      if (!sunCycle.override && wasNight !== sunCycle.isNight) {
        const on = !sunCycle.isNight; // lights "on" = daytime = sun is up
        window.lightSwitch.on = on;
        // Room lights (ambient): dim at night but don't go to zero
        window.lightSwitch.roomLights.forEach((l) => {
          // Skip sunLight — it's controlled by the sun cycle directly
          if (l.light === window.sunLight) return;
          l.target = on ? l.onIntensity : 0.02;
        });
        // Practical lights: on at night
        window.lightSwitch.practicalLights.forEach((l) => {
          l.target = on ? 0 : l.onIntensity;
        });
        // Materials envMapIntensity
        window.lightSwitch.materials.forEach((m) => {
          m.target = on ? m.onIntensity : m.offIntensity;
        });
        console.log("Sun cycle auto-toggle:", on ? "DAY" : "NIGHT");
      }

      // Update time display in legend
      const timeEl = document.getElementById("time-status");
      if (timeEl) {
        const displayHour = sunCycle.sim ? sunCycle.simHour : currentHour;
        const h = Math.floor(displayHour);
        const m = Math.floor((displayHour - h) * 60);
        const ampm = h >= 12 ? "PM" : "AM";
        const h12 = h % 12 || 12;
        const suffix = sunCycle.sim ? " (sim)" : "";
        timeEl.textContent = `${h12}:${m.toString().padStart(2, "0")} ${ampm}${suffix}`;
      }
    }
  }

  // Lerp all lights for smooth light switch (frame-rate independent)
  if (window.lightSwitch) {
    const lerpFactor = 1 - Math.pow(0.01, delta); // Smooth ~3 second transition
    const lerpLight = (l) => {
      // Skip sunLight in roomLights lerp — sun cycle controls it directly
      if (!sunCycle.override && l.light === window.sunLight) return;
      l.current += (l.target - l.current) * lerpFactor;
      l.light.intensity = l.current;
    };
    const lerpMaterial = (m) => {
      m.current += (m.target - m.current) * lerpFactor;
      m.material.envMapIntensity = m.current;
    };
    window.lightSwitch.roomLights?.forEach(lerpLight);
    window.lightSwitch.practicalLights?.forEach(lerpLight);
    window.lightSwitch.materials?.forEach(lerpMaterial);
  }

  // Lerp sun position, intensity, and color toward targets
  if (window.sunLight && !sunCycle.override) {
    const sunLerp = 1 - Math.pow(0.05, delta); // Smoother, slower transition for sun
    sunCycle.currentPosition.lerp(sunCycle.targetPosition, sunLerp);
    sunCycle.currentIntensity +=
      (sunCycle.targetIntensity - sunCycle.currentIntensity) * sunLerp;
    sunCycle.currentColor.lerp(sunCycle.targetColor, sunLerp);

    window.sunLight.position.copy(sunCycle.currentPosition);
    window.sunLight.intensity = sunCycle.currentIntensity;
    window.sunLight.color.copy(sunCycle.currentColor);

    // Update shadow camera to follow sun
    window.sunLight.shadow.camera.updateProjectionMatrix();
  }

  // ============ DJ BOOTH HOVER GLOW + FOCUS TARGET HOVER ============
  if (boothHover.mesh) {
    // Raycast against booth mesh + decal + focus targets
    raycaster.setFromCamera(raycasterMouse, camera);
    const hoverTargets = [boothHover.mesh];
    if (boothHover.decal) hoverTargets.push(boothHover.decal);
    const allHoverTargets = hoverTargets.concat(focusMeshList);
    const intersects = raycaster.intersectObjects(allHoverTargets, false);

    // Determine what was hit
    const boothHit = intersects.some(
      (h) => h.object === boothHover.mesh || h.object === boothHover.decal,
    );
    const focusHit = intersects.some((h) => focusMeshMap.has(h.object));
    const anyPointerTarget = boothHit || focusHit;

    boothHover.isHovered = boothHit;

    // Pointer cursor for booth or focus targets
    document.body.style.cursor = anyPointerTarget ? "pointer" : "";
  }

  // Hide/show hotspots during focus mode
  const isFocused = cameraFocus.active || cameraFocus.transitioning;
  for (let i = 0; i < hotspots.length; i++) {
    hotspots[i].css2dObj.visible = !isFocused;
  }

  renderer.render(scene, camera);
  css2dRenderer.render(scene, camera);
}

animate();
