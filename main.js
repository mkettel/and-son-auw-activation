import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/addons/helpers/RectAreaLightHelper.js';
import Stats from 'three/addons/libs/stats.module.js';

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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.35;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// HDRI Environment (for subtle reflections)
const exrLoader = new EXRLoader();
exrLoader.load(
  '/hdri/forest.exr',
  (texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = texture;
    scene.background = new THREE.Color(0x1a1a1a);
  }
);

// Controls
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1;
controls.maxDistance = 100;

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


    controls.target.copy(center);
    controls.update();

    // Set envMapIntensity on all materials (subtle reflections only)
    model.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.envMapIntensity = 0.2;
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

      // Log cactus meshes
      const cactusMeshes = [];
      cactusModel.traverse((child) => {
        if (child.isMesh) {
          cactusMeshes.push({ name: child.name, material: child.material });
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
      logoMesh.material.roughness = 0.7;
      logoMesh.material.metalness = 0.1;
      logoMesh.material.envMapIntensity = 0.9;
    }

    // Floor (ROOM_2) - warm it up to match Blender
    const floorMesh = model.getObjectByName('ROOM_2');
    if (floorMesh?.material) {
      floorMesh.material.color.set(0xD4BC94); // Warmer golden wood (lighter)
      floorMesh.material.roughness = 0.7;
      floorMesh.material.envMapIntensity = 0.3;
      window.floorMaterial = floorMesh.material;
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
    const areaLeft = new THREE.RectAreaLight(warmColor, 6, 6, 6);
    areaLeft.position.set(4.5, 5, 18);
    areaLeft.lookAt(3, 3, 1);
    areaLeft.power = 1000;
    scene.add(areaLeft);

    // Right area light (angled)
    const areaRight = new THREE.RectAreaLight(warmColor, 6, 6, 4);
    areaRight.position.set(14, 5, 10);
    areaRight.lookAt(3, 2, 1);
    scene.add(areaRight);

    // Top area light
    const areaTop = new THREE.RectAreaLight(warmColor, 9, 6, 6);
    areaTop.position.set(14, 10, 3);
    areaTop.lookAt(6, -1, 2);
    scene.add(areaTop);

    // small ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.1);
    scene.add(ambientLight);

    // ============ LIGHT SWITCH (Press 'L') ============
    // Room lights (on when bright) vs practical lights (on when dark)
    window.lightSwitch = {
      on: true, // room lights on
      roomLights: [
        { light: ambientLight, onIntensity: 2.1, current: 2.1, target: 2.1 },
      ],
      practicalLights: [
        // These turn ON when room lights are OFF
        { light: lampPointLight, onIntensity: 3, current: 0, target: 0 },
        { light: lampLightUp, onIntensity: 15, current: 0, target: 0 },
        { light: lampLightDown, onIntensity: 15, current: 0, target: 0 },
        { light: sconceLeft, onIntensity: 5, current: 0, target: 0 },
        { light: sconceRight, onIntensity: 5, current: 0, target: 0 },
      ]
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

    const areaLeftHelper = new RectAreaLightHelper(areaLeft);
    scene.add(areaLeftHelper);
    helpers.push(areaLeftHelper);

    const areaRightHelper = new RectAreaLightHelper(areaRight);
    scene.add(areaRightHelper);
    helpers.push(areaRightHelper);

    const areaTopHelper = new RectAreaLightHelper(areaTop);
    scene.add(areaTopHelper);
    helpers.push(areaTopHelper);

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
  controls.update();

  // Lerp all lights for smooth light switch (frame-rate independent)
  if (window.lightSwitch) {
    const lerpFactor = 1 - Math.pow(0.01, delta); // Smooth ~3 second transition
    const lerpLight = (l) => {
      l.current += (l.target - l.current) * lerpFactor;
      l.light.intensity = l.current;
    };
    window.lightSwitch.roomLights?.forEach(lerpLight);
    window.lightSwitch.practicalLights?.forEach(lerpLight);
  }

  renderer.render(scene, camera);
}

animate();
