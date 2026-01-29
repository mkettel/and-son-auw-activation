import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/addons/helpers/RectAreaLightHelper.js';
import Stats from 'three/addons/libs/stats.module.js';

// ============ PCSS SOFT SHADOWS (like Drei's SoftShadows) ============
const pcssConfig = {
  size: 25,      // Light size - larger = softer shadows
  samples: 6,   // Quality - more samples = smoother but slower
  focus: 0       // Focus point - 0 = auto
};
window.pcssConfig = pcssConfig;

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
THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment.replace(
  '#ifdef USE_SHADOWMAP',
  '#ifdef USE_SHADOWMAP\n' + pcssGetShadow
).replace(
  'return shadow;',
  'return PCSS_shadow(shadowMap, shadowCoord);'
).replace(
  /texture2DCompare\s*\(\s*shadowMap\s*,\s*shadowCoord\.xy\s*,\s*shadowCoord\.z\s*\)/g,
  'PCSS_shadow(shadowMap, shadowCoord)'
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
  1000
);
camera.position.set(0, 0, 5);

// Renderer
const canvas = document.getElementById('canvas');
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

// HDRI Environment (for subtle reflections)
const exrLoader = new EXRLoader();
exrLoader.load(
  '/hdri/forest.exr',
  (texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = texture;
    scene.background = texture;
  }
);

// Camera mode config: 'mouse' or 'orbit'
const cameraConfig = {
  mode: 'mouse', // 'mouse' = mouse-follow, 'orbit' = OrbitControls
};
window.cameraConfig = cameraConfig;

// Mouse-follow camera settings
const mouseTarget = { x: 0, y: 0 };
const mouseCurrent = { x: 0, y: 0 };
const cameraBasePosition = new THREE.Vector3();
const cameraLookCenter = new THREE.Vector3();
const cameraLookCurrent = new THREE.Vector3();
const cameraLookRange = { x: 2, y: 1 };

// Track mouse position (normalized -1 to 1)
window.addEventListener('mousemove', (e) => {
  mouseTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseTarget.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

// OrbitControls setup
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1;
controls.maxDistance = 100;
controls.enabled = false; // Start with mouse mode

// Toggle camera mode with 'C' key
window.addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') {
    cameraConfig.mode = cameraConfig.mode === 'mouse' ? 'orbit' : 'mouse';
    controls.enabled = cameraConfig.mode === 'orbit';

    // Reset orbit controls target when switching to orbit mode
    if (cameraConfig.mode === 'orbit' && cameraLookCenter.length() > 0) {
      controls.target.copy(cameraLookCenter);
      controls.update();
    }

    console.log('Camera mode:', cameraConfig.mode);
  }
});

// Loading manager
const loadingElement = document.getElementById('loading');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');

// DRACO loader (for compressed models)
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

// GLTF loader
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// Load model
gltfLoader.load(
  '/models/son-and-store-keep-meshes.glb',
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

    camera.position.set(center.x + cameraZ * 0.5, center.y + cameraZ * 0.0, center.z + cameraZ);
    camera.lookAt(center);

    // Store base camera position and look target for mouse-follow
    cameraBasePosition.copy(camera.position);
    cameraLookCenter.copy(center);
    cameraLookCurrent.copy(center);

    // Set envMapIntensity and enable shadows on all meshes
    model.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.envMapIntensity = 0.9;
        // Room/walls/ceiling receive shadows but don't cast them (avoids hard ceiling shadow line)
        const isRoom = child.name.toLowerCase().includes('room');
        child.castShadow = !isRoom;
        child.receiveShadow = true;
      }
    });

    // Hide cactus in main model (using separate cactus model instead)
    model.traverse((child) => {
      if (child.name.toLowerCase().includes('cactus')) {
        child.visible = false;
      }
    });

    // Load separate cactus model
    gltfLoader.load('/models/cactus.gltf', (cactusGltf) => {
      const cactusModel = cactusGltf.scene;

      // Match the main model rotation
      cactusModel.rotation.y = -1.1;

      // Position it (adjust as needed)
      cactusModel.position.set(0, 0, 0);

      scene.add(cactusModel);

      // Expose for positioning in console
      window.cactusModel = cactusModel;
      console.log('Cactus loaded. Adjust position with: cactusModel.position.set(x, y, z)');

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
      console.log('Cactus meshes:', cactusMeshes.map(c => c.name));

      // Set the colors of the cactus meshes individually
      // Pot
      cactusMaterials[0].material.color.set(0x4D1E04);
      cactusMaterials[0].material.roughness = 0.3;
      cactusMaterials[0].material.metalness = 0.1;
      cactusMaterials[0].material.envMapIntensity = 0.9;

      // Spikes
      cactusMaterials[1].material.color.set(0xffffff);
      cactusMaterials[1].material.roughness = 0.7;
      cactusMaterials[1].material.metalness = 0.1;
      cactusMaterials[1].material.envMapIntensity = 0.9;

      // Body
      cactusMaterials[2].material.color.set(0x1E2816);
      cactusMaterials[2].material.roughness = 0.8;
      cactusMaterials[2].material.metalness = 0.1;
      cactusMaterials[2].material.envMapIntensity = 0.9;

      // Ground
      cactusMaterials[3].material.color.set(0x1E2816);
      cactusMaterials[3].material.roughness = 0.8;
      cactusMaterials[3].material.metalness = 0.1;
      cactusMaterials[3].material.envMapIntensity = 0.9;
    });

    // Get LOGO mesh and material colors (with safety check)
    const logoMesh = model.getObjectByName('LOGO');
    if (logoMesh?.material) {
      logoMesh.material.color.set(0xffffff);
      logoMesh.material.roughness = 0.8;
      logoMesh.material.metalness = 0.1;
      logoMesh.material.envMapIntensity = 1.7;
      logoMesh.material.emissive.set(0xffffff);
      logoMesh.material.emissiveIntensity = 0.8
    }

    // Floor (ROOM_2) - warm it up to match Blender
    const floorMesh = model.getObjectByName('ROOM_2');
    if (floorMesh?.material) {
      floorMesh.material.color.set(0xD4BC94); // Warmer golden wood (lighter)
      floorMesh.material.roughness = 0.8;
      floorMesh.material.envMapIntensity = 0.99;
      window.floorMaterial = floorMesh.material;
    }

    // Rug Materials - matte fabric look
    const rugMesh = model.getObjectByName('Shaggy_carpet');
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
    const boothMesh = model.getObjectByName('BOOTH_DJ');
    if (boothMesh) {
      const textureLoader = new THREE.TextureLoader();
      textureLoader.load('/textures/test-decal.png', (texture) => {
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

        window.decal = decal;
        window.boothMesh = boothMesh;
        console.log('Decal placed on BOOTH_DJ at:', center);
        console.log('Adjust with: decal.position.set(x, y, z)');
        console.log('Resize with: decal.scale.set(w, h, 1)');
      });
    }

    // Map and log all meshes
    const meshes = {};
    model.traverse((child) => {
      if (child.isMesh && child.material) meshes[child.name] = child.material;
    });
    window.meshes = meshes;
    console.log('=== ALL MESHES IN MODEL ===');
    console.log('Total count:', Object.keys(meshes).length);
    console.log('Names:', Object.keys(meshes));
    console.table(Object.keys(meshes).map(name => ({ name })));


    // // DEBUG: Uncomment to expose ALL materials
    // const materials = {};
    // model.traverse((child) => {
    //   if (child.isMesh && child.material) materials[child.name] = child.material;
    // });
    // window.materials = materials;
    // console.log('Materials exposed:', Object.keys(materials));

    // ============ LIGHTING SETUP ============
    // Colors
    const warmColor = 0xFFB770;  // Warm orange for lamp and area lights
    const whiteColor = 0xFFFFFF; // White for sconces

    // --- LAMP (Point Light - diffuse glow through shade) ---
    const lampPointLight = new THREE.PointLight(warmColor, 3, 12, 2);
    lampPointLight.position.set(-2.7, 4.0, 8.75);
    scene.add(lampPointLight);
    window.lampPointLight = lampPointLight;

    // --- LAMP (Spotlight - pointing up) ---
    const lampLightUp = new THREE.SpotLight(warmColor, 15, 15, Math.PI / 4, 1, 1);
    lampLightUp.position.set(-2.7, 4.0, 8.75);
    lampLightUp.target.position.set(-2.7, 10, 8.75);
    scene.add(lampLightUp);
    scene.add(lampLightUp.target);
    window.lampLightUp = lampLightUp;

    // --- LAMP (Spotlight - pointing down) ---
    const lampLightDown = new THREE.SpotLight(warmColor, 15, 10, Math.PI / 3, 1, 1);
    lampLightDown.position.set(-2.7, 4.0, 8.75);
    lampLightDown.target.position.set(-2.7, 0, 8.75);
    scene.add(lampLightDown);
    scene.add(lampLightDown.target);
    window.lampLightDown = lampLightDown;

    // --- SCONCES (Point Lights - white) ---
    // Left sconce
    const sconceLeft = new THREE.PointLight(whiteColor, 5, 10, 1);
    sconceLeft.position.set(-4, 6.5, 1.2);
    scene.add(sconceLeft);

    // Right sconce
    const sconceRight = new THREE.PointLight(whiteColor, 5, 10, 1);
    sconceRight.position.set(14.3, 6.5, -6.9);
    scene.add(sconceRight);

    // --- ROOM AREA LIGHTS (RectAreaLight - warm) ---
    // Left area light
    // const areaLeft = new THREE.RectAreaLight(warmColor, 6, 6, 6);
    // areaLeft.position.set(4.5, 5, 18);
    // areaLeft.lookAt(3, 3, 1);
    // areaLeft.power = 1000;
    // scene.add(areaLeft);

    // Right area light (angled)
    // const areaRight = new THREE.RectAreaLight(warmColor, 6, 6, 4);
    // areaRight.position.set(14, 5, 10);
    // areaRight.lookAt(3, 2, 1);
    // scene.add(areaRight);

    // Top area light
    // const areaTop = new THREE.RectAreaLight(warmColor, 6, 6, 6);
    // areaTop.position.set(14, 10, 0);
    // areaTop.lookAt(6, 10, 2);
    // scene.add(areaTop);

    // Ambient light (lower for more depth)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    // Directional light (simulates sunlight through window)
    const sunLight = new THREE.DirectionalLight(0xFFB770, 6.5); // Soft warm sunlight
    sunLight.position.set(9, 7, 20); // Coming from window direction (left side)
    sunLight.target.position.set(0, 1, 0);
    scene.add(sunLight.target);
    sunLight.castShadow = true;

    // Shadow settings
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 50;
    sunLight.shadow.camera.left = -30;
    sunLight.shadow.camera.right = 30;
    sunLight.shadow.camera.top = 30;
    sunLight.shadow.camera.bottom = -30;
    sunLight.shadow.bias = -0.0001;
    // PCSS handles shadow softness via pcssConfig.size

    scene.add(sunLight);
    window.sunLight = sunLight;

    // ============ LIGHT SWITCH (Press 'L') ============
    // Collect all materials for envMapIntensity control
    const allMaterials = [];
    model.traverse((child) => {
      if (child.isMesh && child.material && child.material.envMapIntensity !== undefined) {
        allMaterials.push({
          material: child.material,
          onIntensity: child.material.envMapIntensity, // current value as "on" value
          offIntensity: 0.55, // dim when lights off
          current: child.material.envMapIntensity,
          target: child.material.envMapIntensity
        });
      }
    });

    // Room lights (on when bright) vs practical lights (on when dark)
    window.lightSwitch = {
      on: true, // room lights on
      roomLights: [
        { light: ambientLight, onIntensity: 0.5, current: 0.5, target: 0.5 },
        { light: sunLight, onIntensity: 3.6, current: 3.6, target: 3.6 },
      ],
      practicalLights: [
        // These turn ON when room lights are OFF
        { light: lampPointLight, onIntensity: 3, current: 0, target: 0 },
        { light: lampLightUp, onIntensity: 15, current: 0, target: 0 },
        { light: lampLightDown, onIntensity: 15, current: 0, target: 0 },
        { light: sconceLeft, onIntensity: 5, current: 0, target: 0 },
        { light: sconceRight, onIntensity: 5, current: 0, target: 0 },
      ],
      materials: allMaterials
    };

    // Start with practical lights off
    window.lightSwitch.practicalLights.forEach(l => l.light.intensity = 0);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'l' || e.key === 'L') {
        window.lightSwitch.on = !window.lightSwitch.on;
        const on = window.lightSwitch.on;
        // Room lights: on when bright
        window.lightSwitch.roomLights.forEach(l => {
          l.target = on ? l.onIntensity : 0;
        });
        // Practical lights: on when dark (opposite)
        window.lightSwitch.practicalLights.forEach(l => {
          l.target = on ? 0 : l.onIntensity;
        });
        // Materials envMapIntensity: high when bright, low when dark
        window.lightSwitch.materials.forEach(m => {
          m.target = on ? m.onIntensity : m.offIntensity;
        });
        console.log('Room lights:', on ? 'ON' : 'OFF');
      }
    });

    console.log('Lighting setup complete');

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
    helpers.forEach(helper => helper.visible = false);

    // Toggle helpers with 'H' key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'h' || e.key === 'H') {
        helpers.forEach(helper => helper.visible = !helper.visible);
        console.log('Helpers:', helpers[0].visible ? 'ON' : 'OFF');
      }
    });

    // Hide loading screen
    loadingElement.classList.add('hidden');

    console.log('Model loaded successfully');
  },
  (progress) => {
    if (progress.total > 0) {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      progressFill.style.width = `${percent}%`;
      progressText.textContent = `${percent}%`;
    }
  },
  (error) => {
    console.error('Error loading model:', error);
    progressText.textContent = 'Error loading model';
    progressText.style.color = '#ff4444';
  }
);

// Handle window resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Animation loop with deltaTime for consistent speed
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  stats.update();

  // Camera mode handling
  if (cameraConfig.mode === 'mouse') {
    // Smooth mouse-follow camera - look at where mouse is pointing
    const lerpSpeed = 1 - Math.pow(0.001, delta);
    mouseCurrent.x += (mouseTarget.x - mouseCurrent.x) * lerpSpeed;
    mouseCurrent.y += (mouseTarget.y - mouseCurrent.y) * lerpSpeed;

    if (cameraLookCenter.length() > 0) {
      const targetLookX = cameraLookCenter.x + mouseCurrent.x * cameraLookRange.x;
      const targetLookY = cameraLookCenter.y + mouseCurrent.y * cameraLookRange.y;

      cameraLookCurrent.x += (targetLookX - cameraLookCurrent.x) * lerpSpeed;
      cameraLookCurrent.y += (targetLookY - cameraLookCurrent.y) * lerpSpeed;

      camera.lookAt(cameraLookCurrent);
    }
  } else {
    // Orbit controls mode
    controls.update();
  }

  // Lerp all lights for smooth light switch (frame-rate independent)
  if (window.lightSwitch) {
    const lerpFactor = 1 - Math.pow(0.01, delta); // Smooth ~3 second transition
    const lerpLight = (l) => {
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

  renderer.render(scene, camera);
}

animate();
