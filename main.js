import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RectAreaLightHelper } from 'three/addons/helpers/RectAreaLightHelper.js';

// Initialize RectAreaLight support
RectAreaLightUniformsLib.init();

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
        child.material.envMapIntensity = 0.1;
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

    // --- LAMP (Point Light) ---
    const lampLight = new THREE.PointLight(warmColor, 7, 20, 2);
    lampLight.position.set(-2.7, 4.12, 8.75);
    scene.add(lampLight);

    // --- SCONCES (Point Lights - white) ---
    // Left sconce
    const sconceLeft = new THREE.PointLight(whiteColor, 5, 10, 1);
    sconceLeft.position.set(-4, 6.5, 1.2);
    scene.add(sconceLeft);

    // Right sconce
    const sconceRight = new THREE.PointLight(whiteColor, 5, 10, 1);
    sconceRight.position.set(13, 6.5, -6.9);
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
    const areaTop = new THREE.RectAreaLight(warmColor, 7, 8, 8);
    areaTop.position.set(14, 10, 3);
    areaTop.lookAt(6, -1, 3);
    scene.add(areaTop);

    // small ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.1);
    scene.add(ambientLight);

    console.log('Lighting setup complete');

    // ============ LIGHT HELPERS (for positioning) ============
    // Press 'H' to toggle helpers
    const helpers = [];

    const lampHelper = new THREE.PointLightHelper(lampLight, 0.5);
    scene.add(lampHelper);
    helpers.push(lampHelper);

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

    // Toggle helpers with 'H' key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'h' || e.key === 'H') {
        helpers.forEach(helper => helper.visible = !helper.visible);
        console.log('Helpers:', helpers[0].visible ? 'ON' : 'OFF');
      }
    });

    // ============ MESH HOVER LOGGING ============
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let lastHovered = null;

    window.addEventListener('mousemove', (e) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObject(model, true);

      if (intersects.length > 0) {
        const mesh = intersects[0].object;
        if (mesh.name !== lastHovered) {
          lastHovered = mesh.name;
          console.log('Hovered:', mesh.name, mesh.material);
          window.hoveredMesh = mesh;
          window.hoveredMaterial = mesh.material;
        }
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

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

animate();
