/* ===== IMPORTS ===== */
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import Stats from 'three/addons/libs/stats.module';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as CANNON from 'cannon-es';
import { createNoise2D } from "https://esm.sh/simplex-noise";
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { createAnimalFlockSystem } from './animals.js';



/* ===== POST-PROCESSING IMPORTS ===== */
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';


const exrLoader = new EXRLoader();
const fbxLoader = new FBXLoader();



let width = window.innerWidth;
let height = window.innerHeight;

// Create a new noise function from the imported generator
const noise = createNoise2D();



/* ===== HELPER ===== */
function lerp(a, b, t) {
    if (typeof a == "object" && a.constructor == Object) {
        let res = {};
        for (let k of Object.keys(a)) res[k] = lerp(a[k], b[k], t);
        return res;
    }
    return a + (b - a) * t;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0, edge1, value) {
    const t = clamp01((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

/**
 * Processes vertex displacement maps and material groups on a raw target geometry.
 */
function rebuildGeometryData(geo, chunkX, chunkZ) {
    const worldOffsetX = chunkX * CHUNK_SIZE;
    const worldOffsetZ = chunkZ * CHUNK_SIZE;
    const posAttr = geo.attributes.position;

    // 1. Evaluate clean heights straight from the noise map generator
    for (let i = 0; i < posAttr.count; i++) {
        const localX = posAttr.getX(i);
        const localZ = posAttr.getZ(i);
        const worldX = localX + worldOffsetX;
        const worldZ = localZ + worldOffsetZ;

        const vy = getTerrainHeight(worldX, worldZ);
        posAttr.setY(i, vy);
    }

    posAttr.needsUpdate = true;
    geo.computeVertexNormals();

    // 2. Re-bind custom uv2 structures if uv maps exist (Needed for PBR AO/Roughness maps)
    if (geo.attributes.uv) {
        if (geo.attributes.uv2) {
            geo.attributes.uv2.copy(geo.attributes.uv);
            geo.attributes.uv2.needsUpdate = true;
        } else {
            geo.setAttribute('uv2', new THREE.BufferAttribute(geo.attributes.uv.array, 2));
        }
    }

    // 3. Rebuild PBR Material face groups
    const indices = geo.index ? geo.index.array : null;
    if (!indices) return;

    const totalFaces = indices.length / 3;

    // Completely clear old grouping structures to clean out historical buffer layers
    geo.clearGroups();

    for (let faceIndex = 0; faceIndex < totalFaces; faceIndex++) {
        const vA = indices[faceIndex * 3];
        const wX = posAttr.getX(vA) + worldOffsetX;
        const wZ = posAttr.getZ(vA) + worldOffsetZ;
        const wY = posAttr.getY(vA);

        const delta = 1.0;
        const hL = getTerrainHeight(wX - delta, wZ);
        const hR = getTerrainHeight(wX + delta, wZ);
        const hD = getTerrainHeight(wX, wZ - delta);
        const hU = getTerrainHeight(wX, wZ + delta);

        const normalY = 2.0 * delta;
        const squaredLength = (hL - hR) ** 2 + normalY ** 2 + (hD - hU) ** 2;
        const denominator = Math.sqrt(squaredLength);

        let slope = 1.0 - (normalY / denominator);

        let matIndex = 0; // Grass default
        if (wY > 145.0 && slope < 0.25) matIndex = 3;      // Snow
        else if (slope > 0.35) matIndex = 1;               // Rock
        else {
            const temp = (noise(wX * 0.00015, wZ * 0.00015) + 1.0) * 0.5;
            const moist = (noise(wX * 0.00015 + 15.23, wZ * 0.00015 * 1.87) + 1.0) * 0.5;
            if (temp > 0.58 && moist < 0.42) matIndex = 1; // Badlands Rock
        }

        geo.addGroup(faceIndex * 3, 3, matIndex);
    }

    // ========================================================
    //  CRITICAL FIX: FORCE WEBGL TO FLUSH THE NEW FACE GROUP DATA 
    // ========================================================
    geo.groupsNeedUpdate = true;
}

/**
 * Toggles or updates internal high-fidelity assets (like foliage) based on current LOD tier.
 */
function handleVegetationVisibility(mesh, activeLod) {
    // Find if this mesh already has an InstancedMesh child attached
    const grassMesh = mesh.children.find(child => child.isInstancedMesh);

    if (activeLod === 0) {
        // If it transitioned into the highest detail tier but has no grass, make it visible/rebuild
        if (grassMesh) grassMesh.visible = true;
    } else {
        // Hide instanced elements on distant, low-fidelity LOD tiers to protect framerate
        if (grassMesh) grassMesh.visible = false;
    }
}

/* ===== CONFIGURATIONS & MATRICES ===== */
const CHUNK_SIZE = 120;
const CHUNK_RADIUS = 8;        // Expanded visibility radius to handle 7 tiers of LOD ring ranges smoothly
const activeChunks = new Map();
let grassMaterialGlobal = null;

const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();

/* for (const chunkData of activeChunks.values()) {
    const mesh = chunkData.chunkMesh;

    if (!mesh.geometry.boundingSphere) {
        mesh.geometry.computeBoundingSphere();
    }

    const sphere = mesh.geometry.boundingSphere.clone();
    sphere.center.add(mesh.position);

    mesh.visible = frustum.intersectsSphere(sphere);
} */

const chunkGenerationQueue = [];
const queuedChunkKeys = new Set();
let lastChunkReconcileKey = '';
// FIND where your activeChunks Map is declared and make sure it's accessible:

// --- 3x3 MACRO COLLIDER TRACKING HOOKS ---
let globalPhysicsFloorBody = null;
const PHYSICS_GRID_RES = 128;
let lastPhysicsMacroGroupX = null;
let lastPhysicsMacroGroupZ = null;

// Global Texture Loader instance
const textureLoader = new THREE.TextureLoader();

// --- YOUR UPGRADED HIGH-FIDELITY 7-TIER LOD SYSTEM ---
// REPLACE your segment array configuration with this clean power-of-two structure:
const LOD_SEGMENTS = [128, 64, 32, 16, 8, 4, 2];

/* ===== CENTRALIZED MASTER TERRAIN BIOME MATERIALS PALETTE ===== */
// --- GLOBAL BIOME MATERIAL PALETTE CONFIGURATION ---
const TERRAIN_PALETTE = {
    lushMeadow: {
        color: new THREE.Color(0x3e542b),
        roughness: 0.85,
        metalness: 0.0,
        material: new THREE.MeshStandardMaterial({
            color: 0x3e542b,
            roughness: 0.85,
            metalness: 0.0
        })
    },
    rockSheer: {
        color: new THREE.Color(0x5a544d),
        roughness: 0.9,
        metalness: 0.0,
        material: new THREE.MeshStandardMaterial({
            color: 0x5a544d,
            roughness: 0.9,
            metalness: 0.0
        }) // Material Index 1
    },
    deepRiverBed: { // Retained as fallback key for data arrays
        color: new THREE.Color(0x2b2925),
        roughness: 0.95,
        metalness: 0.0,
        material: new THREE.MeshStandardMaterial({
            color: 0x2b2925,
            roughness: 0.95,
            metalness: 0.0
        }) // Material Index 2
    },
    summitSnow: {
        color: new THREE.Color(0xffffff),
        roughness: 0.75,
        metalness: 0.0,
        material: new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.75,
            metalness: 0.0
        }) // Material Index 3
    },
    drySteppe: {
        color: new THREE.Color(0x8d5524),
        roughness: 0.8,
        metalness: 0.0,
        material: new THREE.MeshStandardMaterial({
            color: 0x8d5524,
            roughness: 0.8,
            metalness: 0.0
        }) // Material Index 4
    },
    alpineForest: {
        color: new THREE.Color(0x2e4a2e),
        roughness: 0.9,
        metalness: 0.0,
        material: new THREE.MeshStandardMaterial({
            color: 0x2e4a2e,
            roughness: 0.9,
            metalness: 0.0
        }) // Material Index 5
    },
    alpineTundra: {
        color: new THREE.Color(0x6b726b),
        roughness: 0.85,
        metalness: 0.0,
        material: new THREE.MeshStandardMaterial({
            color: 0x6b726b,
            roughness: 0.85,
            metalness: 0.0
        }) // Material Index 6
    }
};

// Flatten to a flat index array format for multi-material mesh assignment mappings
const terrainMaterialsArray = [
    TERRAIN_PALETTE.lushMeadow.material,
    TERRAIN_PALETTE.rockSheer.material,
    TERRAIN_PALETTE.deepRiverBed.material,
    TERRAIN_PALETTE.summitSnow.material
];

/**
 * Reusable PBR Material Factory
 * @param {string} folderPath - Path to the directory (must include the trailing slash)
 * @param {number} tileX - Tiling repeat frequency horizontally
 * @param {number} tileY - Tiling repeat frequency vertically
 * @returns {THREE.MeshStandardMaterial}
 */

/**
 * Seeded fractal noise generator using octaves for intricate, realistic terrain layers.
 */
function seededFractalNoise(x, z, octaves = 4, persistence = 0.5) {
    let total = 0;
    let frequency = 1.0;
    let amplitude = 1.0;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
        total += noise(x * frequency, z * frequency) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        frequency *= 2.0;
    }
    return total / maxValue;
}

/**
 * Epic scale Whittaker Climate Biome Height Generator.
 * Parabolic riverbed math prevents walls by keeping depths proportional to width.
 */
function getTerrainHeight(x, z) {
    // 1. Base Landscape Profile (Large scale continental masses)
    const baseNoise = noise(x * 0.0002, z * 0.0002);
    let baseElevation = (baseNoise + 1.0) * 40.0; // Broad flats and valleys up to 80m

    // 2. High Mountain Masking Range
    const mountainMask = Math.max(0, noise(x * 0.0001, z * 0.0001) + 0.2);

    if (mountainMask > 0) {
        // Fractal Brownian Motion (fBm) Octaves for sharp crags
        // Octave 1: Structural masses
        let n1 = Math.abs(noise(x * 0.001, z * 0.001));
        n1 = 1.0 - n1; // Invert to create sharp ridges instead of smooth valleys
        n1 = n1 * n1;   // Sharpen the peaks

        // Octave 2: High-frequency surface detail (Roughness)
        let n2 = Math.abs(noise(x * 0.004, z * 0.004));
        n2 = 1.0 - n2;

        // Combine octaves with diminishing weights
        const rigidFractal = (n1 * 1.0) + (n2 * 0.35);

        // Scale and add to base elevation, multiplied by our continental mountain mask
        baseElevation += rigidFractal * 140.0 * Math.pow(mountainMask, 1.5);
    }

    const detailMask = smoothstep(4.0, 95.0, baseElevation) * (1.0 - smoothstep(135.0, 170.0, baseElevation));
    const rollingDetail = seededFractalNoise(x * 0.0065 + 81.7, z * 0.0065 - 19.4, 3, 0.48) * 2.2;
    const pebbleDetail = noise(x * 0.028, z * 0.028) * 0.42;
    const ridgeChatter = (1.0 - Math.abs(noise(x * 0.014 - 43.2, z * 0.014 + 12.6))) * 0.65;

    return baseElevation + (rollingDetail + pebbleDetail + ridgeChatter) * detailMask;
}
window.getTerrainHeight = getTerrainHeight;

function getTerrainSurfaceInfo(x, z) {
    const y = getTerrainHeight(x, z);
    const delta = 1.0;
    const hL = getTerrainHeight(x - delta, z);
    const hR = getTerrainHeight(x + delta, z);
    const hD = getTerrainHeight(x, z - delta);
    const hU = getTerrainHeight(x, z + delta);
    const normalY = 2.0 * delta;
    const slope = 1.0 - (normalY / Math.sqrt((hL - hR) ** 2 + normalY ** 2 + (hD - hU) ** 2));

    const macroX = x * 0.00015;
    const macroZ = z * 0.00015;
    const temperature = (noise(macroX, macroZ) + 1.0) * 0.5;
    const moisture = (noise(macroX + 15.23, macroZ * 1.87) + 1.0) * 0.5;

    let biome = 'lushMeadow';
    let color = TERRAIN_PALETTE.lushMeadow.color;
    let grassDensity = 1.0;

    if (y > 145.0 && slope < 0.25) {
        biome = 'summitSnow';
        color = TERRAIN_PALETTE.summitSnow.color;
        grassDensity = 0.0;
    } else if (slope > 0.35) {
        biome = 'rockSheer';
        color = TERRAIN_PALETTE.rockSheer.color;
        grassDensity = 0.0;
    } else if (temperature > 0.58 && moisture < 0.42) {
        biome = 'drySteppe';
        color = TERRAIN_PALETTE.drySteppe.color;
        grassDensity = 0.0;
    } else if (moisture > 0.55) {
        biome = 'alpineForest';
        color = TERRAIN_PALETTE.alpineForest.color;
        grassDensity = 1.15;
    }

    grassDensity *= clamp01(1.0 - (slope / 0.26));
    if (y > 128.0) grassDensity *= clamp01(1.0 - ((y - 128.0) / 28.0));

    return { y, slope, temperature, moisture, biome, color, grassDensity };
}

/**
 * Compiles a localized terrain mesh chunk tile using centralized material profiles.
 * Incorporates instanced billboard texture card grass on immediate-proximity tiles.
 */
/**
 * Generates an individual chunk mesh. Fixes the riverX scoping initialization error
 * and color blends vertices smoothly based on real-time Whittaker biome vectors.
 */
function createTerrainChunk(chunkX, chunkZ, lodLevel, scene, camera) {
    const segments = LOD_SEGMENTS[lodLevel] !== undefined ? LOD_SEGMENTS[lodLevel] : LOD_SEGMENTS[6];
    const chunkGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, segments, segments);
    chunkGeo.rotateX(-Math.PI / 2);

    const worldOffsetX = chunkX * CHUNK_SIZE;
    const worldOffsetZ = chunkZ * CHUNK_SIZE;

    const posAttr = chunkGeo.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);

    for (let i = 0; i < posAttr.count; i++) {
        const localX = posAttr.getX(i);
        const localZ = posAttr.getZ(i);
        const worldX = localX + worldOffsetX;
        const worldZ = localZ + worldOffsetZ;

        const surface = getTerrainSurfaceInfo(worldX, worldZ);
        posAttr.setY(i, surface.y);

        let finalColor = new THREE.Color();

        if (surface.biome === 'summitSnow') {
            finalColor.copy(TERRAIN_PALETTE.summitSnow.color);
        } else if (surface.biome === 'rockSheer') {
            finalColor.copy(TERRAIN_PALETTE.rockSheer.color);
        } else {
            if (surface.biome === 'drySteppe') {
                finalColor.copy(TERRAIN_PALETTE.drySteppe.color).lerp(TERRAIN_PALETTE.rockSheer.color, surface.slope / 0.35);
            } else if (surface.biome === 'alpineForest') {
                finalColor.copy(TERRAIN_PALETTE.alpineForest.color).lerp(TERRAIN_PALETTE.rockSheer.color, surface.slope / 0.35);
            } else {
                finalColor.copy(TERRAIN_PALETTE.lushMeadow.color).lerp(TERRAIN_PALETTE.drySteppe.color, (0.58 - surface.moisture));
            }
        }

        const colorIndex = i * 3;
        colors[colorIndex] = finalColor.r;
        colors[colorIndex + 1] = finalColor.g;
        colors[colorIndex + 2] = finalColor.b;
    }

    chunkGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    chunkGeo.computeVertexNormals();

    const chunkMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: TERRAIN_PALETTE.lushMeadow.roughness,
        metalness: TERRAIN_PALETTE.lushMeadow.metalness,
        flatShading: false
    });

    const chunkMesh = new THREE.Mesh(chunkGeo, chunkMat);
    chunkMesh.castShadow = true;
    chunkMesh.receiveShadow = true;
    chunkMesh.frustumCulled = true;
    chunkMesh.position.set(chunkX * CHUNK_SIZE, 0, chunkZ * CHUNK_SIZE);
    scene.add(chunkMesh);

    // GRASS GENERATION ENGINE CODE REMOVED FROM HERE

    return { chunkMesh, lodLevel };
}

/**
 * Handles streaming lifecycle management. Spawns matching resolution tiles around coordinates 
 * and despawns far chunks to clean buffer registers.
 */
/**
 * Handles progressive LOD streaming maps. Maps coordinate steps to 7 distinct detail levels
 * based on distance, and deletes out-of-bounds chunks to free up video memory.
 */
/**
 * Handles progressive synchronous LOD streaming maps frame-by-frame.
 * Gathers missing chunks into an evaluation priority queue and instantiates 
 * exactly ONE chunk per animation frame to protect the engine from framerate hitches.
 */
/**
 * Drives live dynamic LOD morphing frame-by-frame.
 * Instead of waiting for unloads, this alters plane geometry segments and 
 * updates material group ranges dynamically as the car approaches or retreats.
 */
function queueChunkGenerationTask(task) {
    if (queuedChunkKeys.has(task.key)) return;
    queuedChunkKeys.add(task.key);
    chunkGenerationQueue.push(task);
}

function disposeChunkMesh(mesh) {
    mesh.traverse((child) => {
        if (child.isInstancedMesh && child.geometry) child.geometry.dispose();
    });

    if (mesh.geometry) mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
        mesh.material.forEach(mat => mat.dispose());
    } else if (mesh.material) {
        mesh.material.dispose();
    }
}

function updateDynamicWorldChunks(playerX, playerZ, scene, camera, dt = 0) {
    const currentChunkX = Math.round(playerX / CHUNK_SIZE);
    const currentChunkZ = Math.round(playerZ / CHUNK_SIZE);
    const reconcileKey = `${currentChunkX},${currentChunkZ}`;
    const keptKeys = new Set();
    const shouldReconcile = reconcileKey !== lastChunkReconcileKey || activeChunks.size === 0;

    // 1. Scan footprint and check if any chunk's active target LOD has changed
    if (shouldReconcile) {
        lastChunkReconcileKey = reconcileKey;

        for (let x = -CHUNK_RADIUS; x <= CHUNK_RADIUS; x++) {
            for (let z = -CHUNK_RADIUS; z <= CHUNK_RADIUS; z++) {
                const targetX = currentChunkX + x;
                const targetZ = currentChunkZ + z;
                const key = `${targetX},${targetZ}`;
                keptKeys.add(key);

                // Progressive Ring mapping rules
                const distance = Math.max(Math.abs(x), Math.abs(z));
                let targetLod = 6;
                if (distance <= 1) targetLod = 0;      // Super High Definition (128 segs)
                else if (distance === 2) targetLod = 1; // 64 segs
                else if (distance === 3) targetLod = 2; // 32 segs
                else if (distance === 4) targetLod = 3; // 16 segs
                else if (distance === 5) targetLod = 4; // 8 segs
                else if (distance === 6) targetLod = 5; // 4 segs

                if (activeChunks.has(key)) {
                    const chunkData = activeChunks.get(key);

                    // CRITICAL DYNAMIC TRIGGER: If the chunk's current LOD doesn't match where the player is, morph it!
                    if (chunkData.lodLevel !== targetLod) {
                        queueChunkGenerationTask({ key, chunkX: targetX, chunkZ: targetZ, lod: targetLod, isMorph: true });
                    }
                } else {
                    // Not spawned yet: Queue fresh registration task
                    queueChunkGenerationTask({ key, chunkX: targetX, chunkZ: targetZ, lod: targetLod, isMorph: false });
                }
            }
        }

        // 2. Sort Queue: Focus resources immediately on what's closest to the bumper
        chunkGenerationQueue.sort((a, b) => {
            const distA = Math.max(Math.abs(a.chunkX - currentChunkX), Math.abs(a.chunkZ - currentChunkZ));
            const distB = Math.max(Math.abs(b.chunkX - currentChunkX), Math.abs(b.chunkZ - currentChunkZ));
            return distA - distB;
        });
    } else {
        for (let x = -CHUNK_RADIUS; x <= CHUNK_RADIUS; x++) {
            for (let z = -CHUNK_RADIUS; z <= CHUNK_RADIUS; z++) {
                keptKeys.add(`${currentChunkX + x},${currentChunkZ + z}`);
            }
        }
    }

    // 3. FRAME BUDGET CONSUMPTION: Build cautiously during slow frames and faster while bootstrapping.
    const taskBudget = activeChunks.size < 12 ? 2 : (dt > 0.028 ? 0 : 1);
    for (let taskIndex = 0; taskIndex < taskBudget && chunkGenerationQueue.length > 0; taskIndex++) {
        const task = chunkGenerationQueue.shift();
        queuedChunkKeys.delete(task.key);

        if (keptKeys.has(task.key)) {
            if (task.isMorph && activeChunks.has(task.key)) {
                const existingChunk = activeChunks.get(task.key);
                const oldMesh = existingChunk.chunkMesh;

                // 1. Visually allocate the fresh mesh segment layers cleanly
                const newChunkData = createTerrainChunk(task.chunkX, task.chunkZ, task.lod, scene, camera);
                const newMesh = newChunkData.chunkMesh;

                scene.remove(oldMesh);
                disposeChunkMesh(oldMesh);

                existingChunk.chunkMesh = newMesh;
                existingChunk.lodLevel = task.lod;

                // ========================================================
                //  FIX: COMPREHENSIVE CANNON-ES HEIGHTFIELD RE-SHAPING
                // ========================================================
                if (existingChunk.physicsBody && existingChunk.physicsBody.shapes[0]) {
                    const body = existingChunk.physicsBody;
                    const oldShape = body.shapes[0];
                    const segs = LOD_SEGMENTS[task.lod];

                    // 1. Compile a pristine raw matrix matching the updated LOD tier dimension (segs + 1)
                    const newMatrix = [];
                    for (let x = 0; x <= segs; x++) {
                        newMatrix.push(new Float32Array(segs + 1));
                        for (let z = 0; z <= segs; z++) {
                            const worldX = (task.chunkX * CHUNK_SIZE) - (CHUNK_SIZE / 2) + (x * (CHUNK_SIZE / segs));
                            const worldZ = (task.chunkZ * CHUNK_SIZE) - (CHUNK_SIZE / 2) + (z * (CHUNK_SIZE / segs));

                            newMatrix[x][z] = getTerrainHeight(worldX, worldZ);
                        }
                    }

                    // 2. Compute the precise element distance spacing matching this specific LOD tier
                    const elementSize = CHUNK_SIZE / segs;

                    // 3. Create a brand new Heightfield shape with the correct matrix structural allocations
                    const newShape = new CANNON.Heightfield(newMatrix, {
                        elementSize: elementSize
                    });

                    // 4. Swap the shapes on the active rigid body safely
                    body.removeShape(oldShape);
                    body.addShape(newShape);

                    // 5. Force the rigid body bounding properties to re-calculate their physical envelopes
                    newShape.updateBoundingSphereRadius();
                    body.computeAABB();
                }
            } else if (!task.isMorph) {
                // Fresh chunk structure generation instantiation path
                const newlyCreated = createTerrainChunk(task.chunkX, task.chunkZ, task.lod, scene, camera);
                activeChunks.set(task.key, newlyCreated);
            }
        }
    }

    // 4. Garbage Collection Loop (Instantly unloads chunks that slip out of view)
    if (shouldReconcile) {
        for (const [key, chunkData] of activeChunks.entries()) {
            if (!keptKeys.has(key)) {
                scene.remove(chunkData.chunkMesh);
                disposeChunkMesh(chunkData.chunkMesh);
                activeChunks.delete(key);

                const qIdx = chunkGenerationQueue.findIndex(item => item.key === key);
                if (qIdx !== -1) {
                    queuedChunkKeys.delete(key);
                    chunkGenerationQueue.splice(qIdx, 1);
                }
            }
        }
    }
}

/**
 * Groups 9 visual chunks into a single unified physics collider mattress.
 * Bypasses matrix allocations completely unless the car crosses sector lines.
 */
function updateStreamingPhysicsFloor(playerX, playerZ, world) {
    const macroGroupX = Math.floor((playerX + (CHUNK_SIZE * 2.5)) / (CHUNK_SIZE * 5));
    const macroGroupZ = Math.floor((playerZ + (CHUNK_SIZE * 2.5)) / (CHUNK_SIZE * 5));

    if (globalPhysicsFloorBody && macroGroupX === lastPhysicsMacroGroupX && macroGroupZ === lastPhysicsMacroGroupZ) {
        return;
    }

    lastPhysicsMacroGroupX = macroGroupX;
    lastPhysicsMacroGroupZ = macroGroupZ;

    const macroFootprintWidth = CHUNK_SIZE * 5;
    const minWorldX = (macroGroupX - 0.5) * macroFootprintWidth;
    const maxWorldZ = (macroGroupZ + 0.5) * macroFootprintWidth;

    if (!globalPhysicsFloorBody) {
        const matrix = [];
        for (let i = 0; i <= PHYSICS_GRID_RES; i++) {
            matrix.push(new Array(PHYSICS_GRID_RES + 1).fill(0));
        }

        const hfShape = new CANNON.Heightfield(matrix, {
            elementSize: macroFootprintWidth / PHYSICS_GRID_RES,
            outOfBoundsValue: CANNON.Heightfield.OUT_OF_BOUNDS_EXTRAPOLATE
        });

        globalPhysicsFloorBody = new CANNON.Body({ mass: 0 });
        globalPhysicsFloorBody.addShape(hfShape);
        globalPhysicsFloorBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
        world.addBody(globalPhysicsFloorBody);
    }

    const shape = globalPhysicsFloorBody.shapes[0];
    const matrix = shape.data;

    for (let i = 0; i <= PHYSICS_GRID_RES; i++) {
        for (let j = 0; j <= PHYSICS_GRID_RES; j++) {
            const pctX = i / PHYSICS_GRID_RES;
            const pctZ = j / PHYSICS_GRID_RES;

            const worldX = minWorldX + (pctX * macroFootprintWidth);
            const worldZ = maxWorldZ - (pctZ * macroFootprintWidth);

            matrix[i][j] = getTerrainHeight(worldX, worldZ);
        }
    }

    shape.updateBoundingSphereRadius();
    shape.updateMinValue();
    shape.updateMaxValue();
    globalPhysicsFloorBody.position.set(minWorldX, 0, maxWorldZ);
}

/**
 * Generates thousands of GPU-instanced grass blades distributed procedurally over flat plains.
 * Includes a custom vertex shader modification to make the grass sway in the wind.
 */
/**
 * Generates thousands of GPU-instanced billboard texture cards distributed procedurally over flat plains.
 * Uses alpha maps for high-fidelity plant shapes and custom vertex shaders for wind animation.
 */
/**
 * Generates thousands of GPU-instanced billboard texture cards distributed procedurally over flat plains.
 * Implements sky-normal modification for perfectly uniform lighting and alpha test mask tuning.
 */
/**
 * Generates thousands of GPU-instanced billboard texture cards distributed procedurally over flat plains.
 * Implements a bulletproof sky-normal modification injection to guarantee even lighting on all sides.
 */
/* function createInstancedGrass(scene) {
    const bladeCount = 45000;
    const terrainSize = 1400;

    const textureLoader = new THREE.TextureLoader();
    const grassMap = textureLoader.load('./images/grass-blade.png');

    // 1. Cross-Plane 'X' Shape Geometry Construction
    const cardGeo = new THREE.PlaneGeometry(0.6, 0.75, 1, 2);
    cardGeo.translate(0, 0.375, 0); // Shift pivot point down to roots

    const crossGeo = cardGeo.clone();
    crossGeo.rotateY(Math.PI / 2);

    // Merge planes into an intersecting cluster layout
    const bladeGeo = BufferGeometryUtils.mergeGeometries([cardGeo, crossGeo]);

    // 2. Build Light-Responsive Material Environment
    const grassMat = new THREE.MeshStandardMaterial({
        map: grassMap,
        roughness: 0.95,      // Eliminates shiny plastic reflections
        metalness: 0.0,       // Absolute non-metal surface
        side: THREE.DoubleSide,
        transparent: true,    // Activates alpha-channel operations
        alphaTest: 0.4,       // Clean cutout threshold to prevent jagged sorting artifacts
        opacity: 0.98
    });

    // --- HARDWARE MATERIAL SHADER INJECTIONS ---
    grassMat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = { value: 0 };
        grassMat.userData.shaderUniforms = shader.uniforms;

        // Add the global uniform timing parameter to the vertex string
        shader.vertexShader = `
            uniform float uTime;
        ` + shader.vertexShader;

        // HOOK 1: Dynamic Wind Sway Simulation
        shader.vertexShader = shader.vertexShader.replace(
            `#include <begin_vertex>`,
            `
            #include <begin_vertex>
            float heightFactor = uv.y; // Animate the tips, keep the root nodes locked
            
            float waveX = sin(uTime * 2.2 + position.x * 2.5 + position.z * 1.8) * 0.14;
            float waveZ = cos(uTime * 1.8 + position.x * 1.5 + position.z * 2.4) * 0.09;
            
            transformed.x += waveX * heightFactor;
            transformed.z += waveZ * heightFactor;
            `
        );

        // HOOK 2: THE EVEN LIGHTING RE-NORMALIZATION TRICK
        // We override "objectNormal" right where Three.js initializes it. This tells the lighting 
        // equations that the grass is facing the sky, illuminating all sides evenly.
        shader.vertexShader = shader.vertexShader.replace(
            `#include <beginnormal_vertex>`,
            `
            #include <beginnormal_vertex>
            // Force the geometry's core normal vectors to point straight up along the Y-axis
            objectNormal = vec3(0.0, 1.0, 0.0);
            `
        );
    };

    // 3. Instantiate Master GPU Container
    const instancedMesh = new THREE.InstancedMesh(bladeGeo, grassMat, bladeCount);
    const dummy = new THREE.Object3D();
    let currentSpawnedCount = 0;

    // 4. Biome Distribution Loop
    for (let i = 0; i < bladeCount * 2.5; i++) {
        if (currentSpawnedCount >= bladeCount) break;

        const x = (Math.random() - 0.5) * terrainSize;
        const z = (Math.random() - 0.5) * terrainSize;
        const y = getTerrainHeight(x, z);

        // Filter out the center spawn plaza tracking range
        const distFromCenter = Math.sqrt(x * x + z * z);
        if (distFromCenter < 120) continue;

        // Query terrain slopes to avoid growing grass sideways on sheer mountain rock walls
        const delta = 1.0;
        const hL = getTerrainHeight(x - delta, z);
        const hR = getTerrainHeight(x + delta, z);
        const hD = getTerrainHeight(x, z - delta);
        const hU = getTerrainHeight(x, z + delta);
        const normalY = 2.0 * delta;
        const slope = 1.0 - (normalY / Math.sqrt((hL - hR) ** 2 + normalY ** 2 + (hD - hU) ** 2));

        const macroX = x * 0.00015;
        const macroZ = z * 0.00015;
        const temperature = (noise(macroX, macroZ) + 1.0) * 0.5;
        const moisture = (noise(macroX + 15.23, macroZ * 1.87) + 1.0) * 0.5;

        // console.log("haha");

        // Continue if not grass
        // if ((temperature > 0.58 && moisture < 0.42 && moisture > 0.55)) continue;
        // if (temperature < 0.58 || (moisture > 0.42 && moisture < 0.55)) continue;
        // if (temperature < 0.58 || moisture > 0.42) continue;
        const isAlpineForest = moisture > 0.55;
        const isMeadow = !(temperature > 0.58 && moisture < 0.42) && !isAlpineForest;

        if (!isAlpineForest && !isMeadow) continue;

        if (slope > 0.16) continue;

        dummy.position.set(x, y - 0.01, z);
        dummy.rotation.set(0, Math.random() * Math.PI * 2, 0); // Random 360 spin orientation

        // Diversify instance cluster scaling profiles
        const scaleY = 0.7 + Math.random() * 0.6;
        const scaleXZ = 0.8 + Math.random() * 0.4;
        dummy.scale.set(scaleXZ, scaleY, scaleXZ);

        dummy.updateMatrix();
        instancedMesh.setMatrixAt(currentSpawnedCount, dummy.matrix);

        // Procedural coloration mix matching your plain's wild grass palette entries
        const baseGrassColor = new THREE.Color(0x3e542b);
        const lighterGrassColor = new THREE.Color(0x5a7541);
        instancedMesh.setColorAt(currentSpawnedCount, baseGrassColor.lerp(lighterGrassColor, Math.random()));

        currentSpawnedCount++;
    }

    instancedMesh.instanceMatrix.needsUpdate = true;
    if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;

    scene.add(instancedMesh);
    return grassMat;
} */

const GRASS_PATCH_SIZE = 28;
const GRASS_RADIUS = 185;
const GRASS_INNER_RADIUS = 72;
const GRASS_MAX_BLADES_PER_PATCH = 190;
const GRASS_PATCH_BUILDS_PER_FRAME = 3;
const GRASS_RECONCILE_INTERVAL = 0.18;

function hashToUnit(seed) {
    seed |= 0;
    seed = (seed ^ 61) ^ (seed >>> 16);
    seed = Math.imul(seed, 9);
    seed = seed ^ (seed >>> 4);
    seed = Math.imul(seed, 0x27d4eb2d);
    seed = seed ^ (seed >>> 15);
    return ((seed >>> 0) / 4294967295);
}

function seededPatchRandom(patchX, patchZ, index, salt = 0) {
    const seed = Math.imul(patchX, 73856093) ^ Math.imul(patchZ, 19349663) ^ Math.imul(index + 1, 83492791) ^ salt;
    return hashToUnit(seed);
}

function createGrassBladeGeometry() {
    const cardGeo = new THREE.PlaneGeometry(2.5, 1.2, 1, 2);
    cardGeo.translate(0, 0.4, 0);

    const crossGeo = cardGeo.clone();
    crossGeo.rotateY(Math.PI / 2);

    const bladeGeo = BufferGeometryUtils.mergeGeometries([cardGeo, crossGeo]);
    bladeGeo.computeBoundingSphere();
    return bladeGeo;
}

function createGrassMaterial() {
    const grassMap = textureLoader.load('./images/grass-blade.png');
    grassMap.colorSpace = THREE.SRGBColorSpace;

    const grassMat = new THREE.MeshLambertMaterial({
        map: grassMap,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        vertexColors: true,
        emissive: 0xffccff,
        emissiveMap: grassMap,
        emissiveIntensity: 0.5,
        depthWrite: false,
        depthTest: true,
    });

    grassMat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = { value: 0 };
        grassMat.userData.shaderUniforms = shader.uniforms;

        shader.vertexShader = `
            uniform float uTime;
        ` + shader.vertexShader;

        shader.vertexShader = shader.vertexShader.replace(
            `#include <begin_vertex>`,
            `
            #include <begin_vertex>
            float heightFactor = uv.y;
            float worldWave = sin(uTime * 1.7 + instanceMatrix[3].x * 0.08 + instanceMatrix[3].z * 0.06);
            transformed.x += worldWave * 0.11 * heightFactor;
            transformed.z += cos(uTime * 1.3 + instanceMatrix[3].x * 0.05) * 0.07 * heightFactor;
            `
        );
    };

    return grassMat;
}

function createGrassSystem(scene) {
    const group = new THREE.Group();
    group.name = 'CameraDistanceGrassSystem';
    scene.add(group);

    const material = createGrassMaterial();
    const geometry = createGrassBladeGeometry();

    return {
        group,
        material,
        geometry,
        patches: new Map(),
        queuedPatchKeys: new Set(),
        patchQueue: [],
        reconcileTimer: 0,
        lastCenterX: Number.POSITIVE_INFINITY,
        lastCenterZ: Number.POSITIVE_INFINITY,
        dummy: new THREE.Object3D(),
        baseGrassColor: new THREE.Color(0x355f25),
        meadowTipColor: new THREE.Color(0x7ea84b),
        dryGrassColor: new THREE.Color(0x9a8a45),
        forestGrassColor: new THREE.Color(0x2e5c36)
    };
}

function disposeGrassPatch(system, key) {
    const patch = system.patches.get(key);
    if (patch && patch.mesh) {
        system.group.remove(patch.mesh);
    }
    system.patches.delete(key);
    system.queuedPatchKeys.delete(key);
}

function queueGrassPatch(system, key, patchX, patchZ) {
    if (system.patches.has(key) || system.queuedPatchKeys.has(key)) return;
    system.queuedPatchKeys.add(key);
    system.patchQueue.push({ key, patchX, patchZ });
}

function buildGrassPatch(system, task, cameraX, cameraZ) {
    const patchMinX = task.patchX * GRASS_PATCH_SIZE;
    const patchMinZ = task.patchZ * GRASS_PATCH_SIZE;
    const centerX = patchMinX + GRASS_PATCH_SIZE * 0.5;
    const centerZ = patchMinZ + GRASS_PATCH_SIZE * 0.5;
    const distanceFromCamera = Math.hypot(centerX - cameraX, centerZ - cameraZ);
    const distanceDensity = Math.pow(1.0 - smoothstep(GRASS_INNER_RADIUS, GRASS_RADIUS, distanceFromCamera), 1.85);

    if (distanceDensity <= 0.02) {
        system.patches.set(task.key, { mesh: null });
        return;
    }

    const mesh = new THREE.InstancedMesh(system.geometry, system.material, GRASS_MAX_BLADES_PER_PATCH);
    mesh.name = `grass-patch-${task.key}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    mesh.position.set(patchMinX, 0, patchMinZ);

    let spawned = 0;
    const candidates = GRASS_MAX_BLADES_PER_PATCH * 4;

    for (let i = 0; i < candidates && spawned < GRASS_MAX_BLADES_PER_PATCH; i++) {
        const localX = seededPatchRandom(task.patchX, task.patchZ, i, 101) * GRASS_PATCH_SIZE;
        const localZ = seededPatchRandom(task.patchX, task.patchZ, i, 211) * GRASS_PATCH_SIZE;
        const worldX = patchMinX + localX;
        const worldZ = patchMinZ + localZ;
        const surface = getTerrainSurfaceInfo(worldX, worldZ);

        if (surface.grassDensity <= 0.02) continue;

        const bladeDistance = Math.hypot(worldX - cameraX, worldZ - cameraZ);
        const bladeDistanceDensity = Math.pow(1.0 - smoothstep(GRASS_INNER_RADIUS, GRASS_RADIUS, bladeDistance), 1.7);
        const localClump = 0.45 + seededPatchRandom(task.patchX, task.patchZ, i, 809) * 0.85;
        const density = Math.min(1.0, surface.grassDensity * bladeDistanceDensity * localClump);
        if (seededPatchRandom(task.patchX, task.patchZ, i, 307) > density) continue;

        const yaw = seededPatchRandom(task.patchX, task.patchZ, i, 401) * Math.PI * 2;
        const scaleXZ = 0.75 + seededPatchRandom(task.patchX, task.patchZ, i, 503) * 0.5;
        const scaleY = 0.55 + seededPatchRandom(task.patchX, task.patchZ, i, 607) * 0.7;

        system.dummy.position.set(localX, surface.y - 0.02, localZ);
        system.dummy.rotation.set(0, yaw, 0);
        system.dummy.scale.set(scaleXZ, scaleY, scaleXZ);
        system.dummy.updateMatrix();
        mesh.setMatrixAt(spawned, system.dummy.matrix);

        const colorMix = seededPatchRandom(task.patchX, task.patchZ, i, 709);
        const color = system.baseGrassColor.clone();
        if (surface.biome === 'drySteppe') {
            color.lerp(system.dryGrassColor, 0.65 + colorMix * 0.25);
        } else if (surface.biome === 'alpineForest') {
            color.copy(system.forestGrassColor).lerp(system.meadowTipColor, colorMix * 0.35);
        } else {
            color.lerp(system.meadowTipColor, colorMix * 0.75);
        }
        mesh.setColorAt(spawned, color);

        spawned++;
    }

    if (spawned === 0) {
        system.patches.set(task.key, { mesh: null });
        return;
    }

    mesh.count = spawned;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();

    system.group.add(mesh);
    system.patches.set(task.key, { mesh });
}

function updateGrassSystem(system, camera, dt) {
    if (!system) return;

    system.reconcileTimer += dt;
    const cameraX = camera.position.x;
    const cameraZ = camera.position.z;
    const movedEnough = Math.hypot(cameraX - system.lastCenterX, cameraZ - system.lastCenterZ) > GRASS_PATCH_SIZE * 0.45;

    if (movedEnough || system.reconcileTimer >= GRASS_RECONCILE_INTERVAL) {
        system.reconcileTimer = 0;
        system.lastCenterX = cameraX;
        system.lastCenterZ = cameraZ;

        const centerPatchX = Math.floor(cameraX / GRASS_PATCH_SIZE);
        const centerPatchZ = Math.floor(cameraZ / GRASS_PATCH_SIZE);
        const patchRadius = Math.ceil(GRASS_RADIUS / GRASS_PATCH_SIZE);
        const wantedKeys = new Set();

        for (let x = -patchRadius; x <= patchRadius; x++) {
            for (let z = -patchRadius; z <= patchRadius; z++) {
                const patchX = centerPatchX + x;
                const patchZ = centerPatchZ + z;
                const patchCenterX = (patchX + 0.5) * GRASS_PATCH_SIZE;
                const patchCenterZ = (patchZ + 0.5) * GRASS_PATCH_SIZE;
                const patchDistance = Math.hypot(patchCenterX - cameraX, patchCenterZ - cameraZ);
                if (patchDistance > GRASS_RADIUS) continue;

                const key = `${patchX},${patchZ}`;
                const existingPatch = system.patches.get(key);
                if (existingPatch && !existingPatch.mesh && patchDistance < GRASS_RADIUS - GRASS_PATCH_SIZE) {
                    system.patches.delete(key);
                }

                wantedKeys.add(key);
                queueGrassPatch(system, key, patchX, patchZ);
            }
        }

        for (const key of system.patches.keys()) {
            if (!wantedKeys.has(key)) disposeGrassPatch(system, key);
        }

        system.patchQueue = system.patchQueue.filter(task => {
            const keep = wantedKeys.has(task.key);
            if (!keep) system.queuedPatchKeys.delete(task.key);
            return keep;
        });

        system.patchQueue.sort((a, b) => {
            const ax = (a.patchX + 0.5) * GRASS_PATCH_SIZE;
            const az = (a.patchZ + 0.5) * GRASS_PATCH_SIZE;
            const bx = (b.patchX + 0.5) * GRASS_PATCH_SIZE;
            const bz = (b.patchZ + 0.5) * GRASS_PATCH_SIZE;
            return Math.hypot(ax - cameraX, az - cameraZ) - Math.hypot(bx - cameraX, bz - cameraZ);
        });
    }

    const patchBudget = dt > 0.028 ? 1 : GRASS_PATCH_BUILDS_PER_FRAME;
    for (let i = 0; i < patchBudget && system.patchQueue.length > 0; i++) {
        const task = system.patchQueue.shift();
        system.queuedPatchKeys.delete(task.key);
        if (!system.patches.has(task.key)) {
            buildGrassPatch(system, task, cameraX, cameraZ);
        }
    }
}



// Fetch Pre-defined DOM Handles From HTML 
const menuOverlay = document.getElementById('garage-menu');
const hud = document.getElementById('hud');
const loadingDiv = document.getElementById('loading');
const canvasElement = document.getElementById('game-canvas');
const gaugeCanvas = document.getElementById('hud-gauge-canvas');
const gCtx = gaugeCanvas.getContext('2d');

loadingDiv.style.display = "none";
loadingDiv.style.opacity = "100%";

/* ===== PROCEDURAL AUDIO ENGINE CONFIG ===== */
let audioCtx = null;
let audioInitialized = false;

// Structural Audio Node References
let engineOscillator = null;
let engineGain = null;
let tireNoiseNode = null;
let tireGain = null;

/**
 * Initializes and binds sound synthesizers to the Web Audio Context
 */
function initProceduralAudio() {
    if (audioInitialized) return;

    try {
        // 1. Setup Master Context
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // --- ENGINE SYNTHESIZER ---
        // We use a sawtooth wave combined with a lowpass filter to mimic cylinder detonations
        engineOscillator = audioCtx.createOscillator();
        engineOscillator.type = 'sawtooth';

        const engineFilter = audioCtx.createBiquadFilter();
        engineFilter.type = 'lowpass';
        engineFilter.frequency.value = 400; // Muffles high frequencies for a realistic engine rumble

        engineGain = audioCtx.createGain();
        engineGain.gain.value = 0.15; // Balanced resting volume

        // Connect engine chain
        engineOscillator.connect(engineFilter);
        engineFilter.connect(engineGain);
        engineGain.connect(audioCtx.destination);
        engineOscillator.start(0);

        // --- TIRE SCREECH NOISE GENERATOR ---
        // We generate a buffer of random White Noise, then dynamically shape it for tire slip
        const bufferSize = 2 * audioCtx.sampleRate;
        const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }

        const tireNoiseSource = audioCtx.createBufferSource();
        tireNoiseSource.buffer = noiseBuffer;
        tireNoiseSource.loop = true;

        const tireFilter = audioCtx.createBiquadFilter();
        tireFilter.type = 'bandpass';
        tireFilter.frequency.value = 800; // Centers the noise around pitch-perfect rubber screaming
        tireFilter.Q.value = 3.0;

        tireGain = audioCtx.createGain();
        tireGain.gain.value = 0.0; // Silenced by default until the car breaks traction

        // Connect tire chain
        tireNoiseSource.connect(tireFilter);
        tireFilter.connect(tireGain);
        tireGain.connect(audioCtx.destination);
        tireNoiseSource.start(0);

        audioInitialized = true;
        console.log("Procedural Engine & Tire Audio Context Started successfully.");
    } catch (e) {
        console.error("Web Audio API is blocked or un-supported by this browser environment:", e);
    }
}

/* ===== CAR MATERIAL CONFIGURATION ===== */
// Material part trackers - assigned when FBX loads
const carParts = {
    rim: null,
    spoiler: null,
    bottomHalf: null,
    topHalf: null
};

// Default color config (hex strings)
let carConfig = {
    rimColor: "#cccccc",
    spoilerColor: "#ff0000",
    bottomHalfColor: "#ff0000",
    topHalfColor: "#ff0000",
    isMatte: false  // false = glossy, true = matte
};

/* ===== LOCALSTORAGE AUTOMATED RESTORATION PROCEDURE ===== */
const savedData = localStorage.getItem('savedCarConfig');
if (savedData) {
    try {
        // Parse raw string configuration block
        const parsedConfig = JSON.parse(savedData);

        // Merge settings back into the running configuration object
        carConfig = { ...carConfig, ...parsedConfig };

        // Dynamic fallback verification check to sync input DOM nodes to loaded state
        document.getElementById('garageRimColorPicker').value = carConfig.rimColor;
        document.getElementById('garageSpoilerColorPicker').value = carConfig.spoilerColor;
        document.getElementById('garageBottomColorPicker').value = carConfig.bottomHalfColor;
        document.getElementById('garageTopColorPicker').value = carConfig.topHalfColor;
        document.getElementById('garageMatteToggle').checked = carConfig.isMatte;

        console.log("Car customization successfully restored from LocalStorage:", carConfig);
    } catch (e) {
        console.error("Failed to safely reconstruct stored car definitions:", e);
    }
}



/* ===== ENGINE BOOTSTRAP CONTROL LOOP TRIGGER ===== */
document.getElementById('startDriveBtn').addEventListener('click', () => {
    initProceduralAudio();

    // Collect user selection state at engine startup
    carConfig.rimColor = document.getElementById('garageRimColorPicker').value;
    carConfig.spoilerColor = document.getElementById('garageSpoilerColorPicker').value;
    carConfig.bottomHalfColor = document.getElementById('garageBottomColorPicker').value;
    carConfig.topHalfColor = document.getElementById('garageTopColorPicker').value;
    carConfig.isMatte = document.getElementById('garageMatteToggle').checked;

    // Save car configuration to localStorage
    localStorage.setItem('savedCarConfig', JSON.stringify(carConfig));

    // Smoothly swap UI element layers
    menuOverlay.style.display = 'none';
    hud.style.display = 'block';
    loadingDiv.style.display = "none";


    // Start engine compilation sequences 
    initializeSimulation();
});



// Function to apply material config to car parts
function applyCarConfig() {
    // if (!carParts.rim || !carParts.spoiler || !carParts.bottomHalf || !carParts.topHalf) return;


    // Convert hex to THREE.Color
    const rimColor = new THREE.Color(carConfig.rimColor);
    const spoilerColor = new THREE.Color(carConfig.spoilerColor);
    const bottomColor = new THREE.Color(carConfig.bottomHalfColor);
    const topColor = new THREE.Color(carConfig.topHalfColor);


    // Apply colors
    if (carParts.rim) carParts.rim.color = rimColor;
    if (carParts.spoiler) carParts.spoiler.color = spoilerColor;
    if (carParts.bottomHalf) carParts.bottomHalf.color = bottomColor;
    if (carParts.topHalf) carParts.topHalf.color = topColor;


    // Apply matte/glossy (roughness: matte=1.0, glossy=0.35)
    const roughness = carConfig.isMatte ? 1.0 : 0.1;
    const metalness = carConfig.isMatte ? 0.2 : 0.9;


    if (carParts.rim) {
        carParts.rim.roughness = roughness;
        carParts.rim.metalness = metalness;
    }
    if (carParts.spoiler) {
        carParts.spoiler.roughness = roughness;
        carParts.spoiler.metalness = metalness;
    }
    if (carParts.bottomHalf) {
        carParts.bottomHalf.roughness = roughness;
        carParts.bottomHalf.metalness = metalness;
    }
    if (carParts.topHalf) {
        carParts.topHalf.roughness = roughness;
        carParts.topHalf.metalness = metalness;
    }

    console.log(carParts)
}

function drawGauge(ctx, x, y, radius, value, minVal, maxVal, label, unitStr, accentColor, totalTicks = 5, redTicks = 2) {
    // Standard dashboard configuration layout angles
    const startAngle = 0.75 * Math.PI;
    const endAngle = 2.25 * Math.PI;
    const totalAngle = endAngle - startAngle;

    // Normalize runtime values to arc coordinates
    const pct = (value - minVal) / (maxVal - minVal);
    // const targetAngle = startAngle + (totalAngle * Math.min(Math.max(pct, 0), 1));
    const targetAngle = startAngle + (totalAngle * pct);

    // Outer Backplate Tracking Line Ring
    ctx.beginPath();
    ctx.arc(x, y, radius, startAngle, endAngle);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Vector Hash Tick Lines
    ctx.lineWidth = 2;
    for (let i = 0; i <= totalTicks; i++) {
        const tickAngle = startAngle + (totalAngle * (i / totalTicks));
        const outerX = x + Math.cos(tickAngle) * radius;
        const outerY = y + Math.sin(tickAngle) * radius;
        const innerX = x + Math.cos(tickAngle) * (radius - 6);
        const innerY = y + Math.sin(tickAngle) * (radius - 6);

        ctx.beginPath();
        ctx.moveTo(innerX, innerY);
        ctx.lineTo(outerX, outerY);
        ctx.strokeStyle = i >= (totalTicks - redTicks) ? '#ff3333' : 'rgba(255, 255, 255, 0.3)';
        ctx.stroke();
    }

    // Active Value Glow Arc Tail
    ctx.beginPath();
    ctx.arc(x, y, radius, startAngle, Math.max(Math.min(targetAngle, totalAngle + startAngle), 0));
    let valueGlowArcTailColor = "#ccc8";
    if (targetAngle > totalAngle + startAngle) valueGlowArcTailColor = "#f008";
    ctx.strokeStyle = valueGlowArcTailColor;
    ctx.lineWidth = 4;
    ctx.shadowBlur = 5;
    ctx.shadowColor = valueGlowArcTailColor;
    ctx.lineCap = "mitter";
    ctx.stroke();
    ctx.shadowBlur = 0; // Clear immediately for vector optimization drops

    // Needle Pin Component
    ctx.beginPath();
    ctx.moveTo(x, y);
    const needleX = x + Math.cos(targetAngle) * (radius - 10);
    const needleY = y + Math.sin(targetAngle) * (radius - 10);
    ctx.lineCap = "round";
    ctx.lineTo(needleX, needleY);
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Central Needle Hub Cap
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Typography Labels Readouts
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(value) + " " + unitStr, x, y + radius * 0.55);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = '9px monospace';
    ctx.fillText(label, x, y + radius * 0.82);
}

function updateHUDGauges(speedKmh, rpm, currentGearValue) {
    // Clear backplate rendering steps to avoid overlap loops
    gCtx.clearRect(0, 0, gaugeCanvas.width, gaugeCanvas.height);

    // 1. LEFT SIDE CLUSTER: Speedometer
    drawGauge(gCtx, 90, 125, 60, speedKmh, 0, 400, 'SPEED', 'KM/H', '#ff0000', 6, 1);

    // 2. CENTER PIECE: Engine Tachometer (RPM scale locked to 8000 max engine map)
    drawGauge(gCtx, 240, 110, 85, rpm, 0, 8000, 'TACHOMETER', 'RPM', '#ff0000', 8, 2);

    // 3. RIGHT SIDE CLUSTER: Fuel Status Scale (Always hardwired to Full state)
    drawGauge(gCtx, 390, 125, 60, 100, 0, 100, 'FUEL', '%', '#ff0000', 8, 1);

    // Update digital overlay gear text readout DOM element safely
    const displayGear = currentGearValue === -1 ? 'R' : currentGearValue === 0 ? 'N' : currentGearValue;
    document.getElementById('digital-gear-value').innerText = displayGear;
}



async function initializeSimulation() {
    loadingDiv.style.display = "block";
    loadingDiv.style.opacity = "100%";

    /* ===== RENDERER LINK ===== */
    const renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: false });
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const ctx = renderer.domElement.getContext('webgl2');
    ctx.disable(ctx.DEPTH_TEST);



    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(
        0xc7d1d8,
        100,
        1800
    );
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 20000);
    camera.position.set(-10, 5, 0);



    const stats = new Stats();
    document.body.appendChild(stats.dom);



    let assetsLoading = 2;



    /* ===== SKYBOX ===== */
    const exrTexture = await new Promise(res => exrLoader.load('./images/autumn_field_puresky_1k.exr', (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        scene.background = texture;
        scene.environment = texture;
        assetsLoading--;
        // if (assetsLoading <= 0) loadingDiv.style.display = 'none';
        res(texture);
    }));



    /* ===== COMPOSITOR SETUP ===== */
    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const bokehPass = new BokehPass(scene, camera, {
        focus: 7.0,
        aperture: 0.0001,
        maxblur: 0.001,
        width: width,
        height: height
    });
    composer.addPass(bokehPass);



    const fxaaPass = new ShaderPass(FXAAShader);
    fxaaPass.material.uniforms['resolution'].value.set(1 / width, 1 / height);
    composer.addPass(fxaaPass);



    const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.01, 0.7, 0);
    composer.addPass(bloomPass);



    /* const vignettePass = new ShaderPass(VignetteShader);
    vignettePass.uniforms['darkness'].value = 0.8;
    vignettePass.uniforms['offset'].value = 1.0;
    composer.addPass(vignettePass); */

    const afterimagePass = new AfterimagePass();
    afterimagePass.uniforms["damp"].value = 0.4;
    composer.addPass(afterimagePass);



    const outputPass = new OutputPass();
    composer.addPass(outputPass);

    const settingsBtn = document.getElementById('settingsBtn');
    const settingsMenu = document.getElementById('settingsMenu');
    let toggleBloom = document.getElementById('toggleBloom');
    let toggleAA = document.getElementById('toggleAA');
    let toggleShadows = document.getElementById('toggleShadows');
    let toggleSkyBox = document.getElementById('toggleSkyBox');
    let toggleFog = document.getElementById('toggleFog');

    toggleBloom.addEventListener('click', () => bloomPass.enabled = toggleBloom.checked);

    toggleAA.addEventListener('click', () => fxaaPass.enabled = toggleAA.checked);

    toggleShadows.addEventListener('click', () => dirLight.castShadow = toggleShadows.checked);

    toggleSkyBox.addEventListener('click', () => {
        if (toggleSkyBox.checked) {
            scene.background = exrTexture;
            scene.environment = exrTexture;
            scene.environmentIntensity = 1;
        } else {
            scene.background = new THREE.Color(0x87CEEB);
            scene.environment = new THREE.Color(0x87CEEB);
            scene.environmentIntensity = 10;
        }
    });

    toggleFog.addEventListener('click', () => scene.fog = toggleFog.checked ? new THREE.Fog(0xc7d1d8, 100, 1800) : null);

    settingsBtn.addEventListener('mousedown', (e) => {
        if (settingsMenu.classList.contains('active')) {
            settingsMenu.classList.remove('active');
        } else {
            settingsMenu.classList.add('active');
        }
    });
    window.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 'o') {
            settingsMenu.classList.toggle('active');
        }
        if (e.key.toLowerCase() === 'escape') {
            settingsMenu.classList.remove('active');
        }
    });
    canvasElement.addEventListener('mousedown', (e) => {
        if (e.target !== settingsBtn && e.target !== settingsMenu && e.target.parentElement !== settingsMenu) {
            settingsMenu.classList.remove('active');
        }
    });



    /* ===== LIGHTS ===== */
    const dirLight = new THREE.DirectionalLight(0xffffff, 3);
    dirLight.position.set(300, 400, 200);
    dirLight.castShadow = true;
    scene.add(dirLight);
    scene.add(new THREE.DirectionalLightHelper(dirLight))
    scene.add(new THREE.AmbientLight(0x506070, 0.8));

    dirLight.shadow.mapSize.width = 4096;
    dirLight.shadow.mapSize.height = 4096;

    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 1000;

    dirLight.shadow.camera.left = -250;
    dirLight.shadow.camera.right = 250;
    dirLight.shadow.camera.top = 250;
    dirLight.shadow.camera.bottom = -250;

    dirLight.shadow.bias = -0.0002;
    dirLight.shadow.normalBias = 0.2;



    /* ===== PHYSICS WORLD ===== */
    const world = new CANNON.World();
    world.gravity.set(0, -9.82, 0);
    world.broadphase = new CANNON.NaiveBroadphase();
    world.solver.iterations = 30;



    /* ===== STATIC GROUND MAP ===== */
    const PLANE_SIZE = 10000;
    /* const gridCanvas = document.createElement('canvas');
    gridCanvas.width = gridCanvas.height = 512;
    const ctx = gridCanvas.getContext('2d');
    ctx.fillStyle = '#cccccc'; ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = '#999999';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillRect(256, 256, 256, 256);
    const gridTexture = new THREE.CanvasTexture(gridCanvas);
    gridTexture.wrapS = gridTexture.wrapT = THREE.RepeatWrapping;
    gridTexture.repeat.set(PLANE_SIZE / 5, PLANE_SIZE / 5);



    const groundMaterial = new CANNON.Material('ground');
    groundMaterial.friction = 0.82;
    groundMaterial.restitution = 0.02;
    /* const groundBody = new CANNON.Body({ mass: 0, material: groundMaterial });
    groundBody.addShape(new CANNON.Plane());
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody); //
    const groundThickness = 10;
    const groundShape = new CANNON.Box(new CANNON.Vec3(PLANE_SIZE / 2, groundThickness, PLANE_SIZE / 2));
    const groundBody = new CANNON.Body({
        mass: 0, // Static
        shape: groundShape,
        material: groundMaterial
    });

    // Position the surface perfectly at y = 0 by dropping the center down by its half-height
    groundBody.position.set(0, -groundThickness, 0);
    world.addBody(groundBody);




    const planeMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE),
        new THREE.MeshStandardMaterial({ map: gridTexture, roughness: 0.85, metalness: 0.05 })
    );
    planeMesh.rotation.x = -Math.PI / 2;
    scene.add(planeMesh); */

    // Remove your old ground/plane generation lines and replace them with this:

    const terrainSize = 1000; // Physical boundary range
    const segments = 1200;     // Resolution density of your hills mesh
    // Replaces the old static terrainMesh allocation loop around line 334:
    updateDynamicWorldChunks(0, 0, scene, camera);
    const groundMaterial = new CANNON.Material('ground');
    /* const terrainGeo = new THREE.PlaneGeometry(terrainSize, terrainSize, segments, segments);

    // Rotate the geometry flat before calculating coordinates
    terrainGeo.rotateX(-Math.PI / 2);

    // Displace vertices up and down using our noise map
    // Allocate color buffers for every single vertex node
    const posAttr = terrainGeo.attributes.position;
    const colors = [];
    for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i);
        const vz = posAttr.getZ(i);
        const vy = getTerrainHeight(vx, vz);
        posAttr.setY(i, vy);

        // Dynamic Slope calculation (compare heights with nearby points)
        const delta = 1.0;
        const hL = getTerrainHeight(vx - delta, vz);
        const hR = getTerrainHeight(vx + delta, vz);
        const hD = getTerrainHeight(vx, vz - delta);
        const hU = getTerrainHeight(vx, vz + delta);

        // Normal estimation vector math
        const normalY = 2.0 * delta;
        const normalX = hL - hR;
        const normalZ = hD - hU;
        const len = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
        const slope = 1.0 - (normalY / len); // 0 = perfectly flat, 1 = absolute vertical cliff

        // Base Palette Color Defs (Minimalist, organic shades)
        const grassColor = new THREE.Color(0x2d3a22);
        const rockColor = new THREE.Color(0x3a3d40);
        const snowColor = new THREE.Color(0xdce3e8);
        const sandColor = new THREE.Color(0x403d35);

        let finalColor = new THREE.Color();

        // 1. Biome styling rules based on height and slope properties
        if (vy < 0.5) {
            // Low ground plains: Blend sand/dirt patch borders into lush wild grass
            finalColor.copy(sandColor).lerp(grassColor, Math.max(0, Math.min(1, (vy + 2) / 2.5)));
        } else if (vy > 18.0 && slope < 0.25) {
            // High mountain plateau peaks: Snowcaps
            finalColor.copy(snowColor);
        } else {
            // Rising landscape: Blend grass into steep jagged stone cliffs
            const slopeThreshold = 0.32;
            if (slope > slopeThreshold) {
                finalColor.copy(rockColor);
            } else {
                const tSlope = slope / slopeThreshold;
                finalColor.copy(grassColor).lerp(rockColor, tSlope * tSlope);
            }
        }

        colors.push(finalColor.r, finalColor.g, finalColor.b);
    }

    terrainGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();

    const terrainMat = new THREE.MeshStandardMaterial({
        vertexColors: true, // Tell Three.js to look at our procedural color array map
        roughness: 0.85,
        metalness: 0.05,
        flatShading: true
    });

    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    scene.add(terrainMesh); */

    // let grassMaterialPointer = null;
    // grassMaterialPointer = createInstancedGrass(scene);
    updateStreamingPhysicsFloor(0, 0, world);
    updateDynamicWorldChunks(0, 0, scene, camera);
    const grassSystem = createGrassSystem(scene);
    grassMaterialGlobal = grassSystem.material;



    // Create a matching 2D matrix array grid for Cannon's physics engine solver
    /* const matrix = [];
    for (let i = 0; i <= segments; i++) {
        matrix.push([]);
        for (let j = 0; j <= segments; j++) {
            // Map 2D indices back into local structural coordinate boundaries
            const x = (i / segments - 0.5) * terrainSize;
            const z = (j / segments - 0.5) * terrainSize;
            matrix[i].push(getTerrainHeight(x, -z));
        }
    }

    // Instantiate the physical physics height shape container
    const hfShape = new CANNON.Heightfield(matrix, {
        elementSize: terrainSize / segments
    });

    const hfBody = new CANNON.Body({ mass: 0 }); // Infinite mass static floor boundary
    hfBody.addShape(hfShape);

    // Align the physics field matrix pivot cleanly to your visual Three.js mesh coordinates
    hfBody.position.set(-terrainSize / 2, 0, terrainSize / 2);
    hfBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);

    world.addBody(hfBody); */

    updateStreamingPhysicsFloor(0, 0, world);



    /* ===== CHASSIS VISUAL INITIALIZATION ===== */
    const carVisualChassis = new THREE.Group();
    carVisualChassis.castShadow = true;
    carVisualChassis.receiveShadow = true;
    scene.add(carVisualChassis);



    /* ===== WHEEL VISUALIZATION TRACKING ===== */
    const visualWheelMeshes = [];


    for (let i = 0; i < 4; i++) {
        visualWheelMeshes.push(null);
    }



    var taillightMat;



    await new Promise(res => fbxLoader.load('./models/mazda-rx7-stylised/model4.fbx', (fbx) => {
        fbx.rotation.y = Math.PI;
        fbx.position.set(0, -1.1, 0);


        fbx.traverse((child) => {
            if (child.isMesh) {
                // Track wheel meshes
                if (child.name.includes('Wheel')) {
                    child.parent = scene;
                    switch (child.name) {
                        case 'WheelFL':
                            visualWheelMeshes[1] = child;
                            break;
                        case 'WheelFR':
                            visualWheelMeshes[0] = child;
                            break;
                        case 'WheelRL':
                            visualWheelMeshes[3] = child;
                            break;
                        case 'WheelRR':
                            visualWheelMeshes[2] = child;
                            break;
                    }
                }


                const oldMat = child.material;
                if (!oldMat) return;


                const processMaterial = (mat) => {
                    return new THREE.MeshStandardMaterial({
                        name: mat.name,
                        color: mat.color ? mat.color : 0xffffff,
                        map: mat.map || null,
                        roughness: 0.35,
                        metalness: 0.15,
                        emissive: mat.emissive ? mat.emissive : new THREE.Color(0x000000),
                        emissiveMap: mat.emissiveMap || null,
                        emissiveIntensity: mat.emissiveIntensity !== undefined ? mat.emissiveIntensity * 0.2 : 0,
                        normalMap: mat.normalMap || null,
                        aoMap: mat.aoMap || null,
                        vertexColors: mat.vertexColors || false,
                        flatShading: false,
                    });
                };


                if (Array.isArray(oldMat)) {
                    child.material = oldMat.map(m => processMaterial(m));
                } else {
                    child.material = processMaterial(oldMat);
                }


                // Material name mapping for car parts
                const matMapping = {
                    "rim": ["RimColor"],       // Rim wheel materials
                    "spoiler": ["Spoiler"],        // Spoiler material
                    "bottomHalf": ["Secondary"],  // Lower body
                    "topHalf": ["Primary"]               // Upper body/roof
                };
                console.log(matMapping)


                // Assign parts by material name
                const matNames = Array.isArray(child.material)
                    ? child.material.map(m => m.name)
                    : [child.material.name];


                if (Array.isArray(child.material)) {
                    for (let i = 0; i < child.material.length; i++) {
                        const matName = oldMat[i]?.name;
                        if (!matName) continue;


                        // Check which part this material belongs to
                        for (const [partName, matNames] of Object.entries(matMapping)) {
                            if (matNames.includes(matName)) {
                                carParts[partName] = child.material[i];
                                break;
                            }
                        }


                        // Apply taillight emissive
                        if (matName == "Taillights") {
                            taillightMat = child.material[i];
                            taillightMat.emissiveIntensity = 0.5;
                        }
                    }
                } else {
                    const matName = oldMat.name;
                    for (const [partName, matNames] of Object.entries(matMapping)) {
                        if (matNames.includes(matName)) {
                            carParts[partName] = child;
                            break;
                        }
                    }


                    if (matName == "Taillights") {
                        taillightMat = child.material;
                        taillightMat.emissiveIntensity = 0.5;
                    }
                }


                child.castShadow = true;
                child.receiveShadow = true;
            }
        });


        carVisualChassis.add(fbx);


        // Apply car config after FBX loads
        console.log(carParts);
        applyCarConfig();
        console.log(carParts);


        assetsLoading--;
        // if (assetsLoading <= 0) loadingDiv.style.display = 'none';
        res();
    }));



    const chassisMaterial = new CANNON.Material('car-body');
    chassisMaterial.friction = 0.42;
    chassisMaterial.restitution = 0.3;

    const chassisBody = new CANNON.Body({
        mass: 1500,
        material: chassisMaterial,
        linearDamping: 0.08,
        angularDamping: 0.62
    });
    // (0.9, 0.25, 2.15)
    chassisBody.addShape(new CANNON.Box(new CANNON.Vec3(0.9, 0.25, 2.15)), new CANNON.Vec3(0, -0.32, 0.2));
    chassisBody.position.set(0, 1.8, 0);
    world.addBody(chassisBody);

    const animalFlockSystem = createAnimalFlockSystem(scene, world, chassisBody);



    /* ===== RAYCAST VEHICLE SYSTEM ===== */
    const vehicle = new CANNON.RaycastVehicle({ chassisBody, indexUpAxis: 1, indexForwardAxis: 2 });
    const wheelMaterial = new CANNON.Material('wheel');
    wheelMaterial.friction = 1.05;
    wheelMaterial.restitution = 0.0;



    const frontWheelOptions = {
        radius: 0.45,
        directionLocal: new CANNON.Vec3(0, -1, 0),
        axleLocal: new CANNON.Vec3(0, 0, -1),

        // Smooth & Responsive Steering Front End Tuning
        suspensionStiffness: 20.0,       // Firm enough for control, soft enough to track the noisier terrain
        suspensionRestLength: 0.62,      // More droop/compression room for high-detail ground
        maxSuspensionTravel: 0.48,       // Prevents sharp detail from bottoming the raycast instantly
        dampingRelaxation: 5.2,          // Catches rebound so bumps do not launch the chassis
        dampingCompression: 3.5,         // Absorbs impacts without feeling like a dead spring

        frictionSlip: 8.0,
        rollInfluence: 0.015,
        maxSuspensionForce: 90000
    };

    const rearWheelOptions = {
        radius: 0.45,
        directionLocal: new CANNON.Vec3(0, -1, 0),
        axleLocal: new CANNON.Vec3(0, 0, -1),

        // Squatting & Drift-Stable Rear End Tuning
        suspensionStiffness: 24.0,       // Softer rear keeps squat and grip over rougher procedural detail
        suspensionRestLength: 0.64,      // Slightly deeper rear travel for acceleration over bumps
        maxSuspensionTravel: 0.5,        // Keeps rear contact stable without pogoing
        dampingRelaxation: 5.6,          // Strong rebound control over noisy terrain
        dampingCompression: 3.25,        // Smooths compression while preserving response

        frictionSlip: 9.0,
        rollInfluence: 0.012,
        maxSuspensionForce: 90000
    };



    const wheelPositions = [
        new CANNON.Vec3(2.1, -0.22, -1.25), new CANNON.Vec3(2.1, -0.22, 1.25),
        new CANNON.Vec3(-1.8, -0.22, -1.25), new CANNON.Vec3(-1.8, -0.22, 1.25)
    ];



    // wheelPositions.forEach(pos => vehicle.addWheel({ ...frontWheelOptions, chassisConnectionPointLocal: pos }));
    vehicle.addWheel({ ...frontWheelOptions, chassisConnectionPointLocal: wheelPositions[0] });
    vehicle.addWheel({ ...frontWheelOptions, chassisConnectionPointLocal: wheelPositions[1] });
    vehicle.addWheel({ ...rearWheelOptions, chassisConnectionPointLocal: wheelPositions[2] });
    vehicle.addWheel({ ...rearWheelOptions, chassisConnectionPointLocal: wheelPositions[3] });
    vehicle.addToWorld(world);



    world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, wheelMaterial, {
        friction: 1.05,
        restitution: 0.0,
        contactEquationStiffness: 7e7,
        contactEquationRelaxation: 4,
        frictionEquationStiffness: 1e7,
        frictionEquationRelaxation: 3
    }));

    world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, chassisMaterial, {
        friction: 0.42,
        restitution: 0.02,
        contactEquationStiffness: 4e7,
        contactEquationRelaxation: 5,
        frictionEquationStiffness: 4e6,
        frictionEquationRelaxation: 4
    }));



    /* ===== DRIVE SYSTEMS / CONFIG ===== */
    let currentGear = 1;
    let isEngineBroken = false;
    // Global state trackers for the drift/skidmark system
    let skidCount = 0;
    const lastWheelPositions = [new THREE.Vector3(), new THREE.Vector3()];
    const wasWheelSlipping = [false, false]; // <-- This is what the animate loop is looking for!
    const gearRatios = { '-1': 3.10, '0': 0.00, '1': 3.15, '2': 1.95, '3': 1.42, '4': 1.12, '5': 0.92, '6': 0.76 };
    const gearDampingProfiles = { '-1': 0.12, '0': 0.02, '1': 0.10, '2': 0.06, '3': 0.035, '4': 0.022, '5': 0.014, '6': 0.007 };



    const finalDriveRatio = 4.1; //3.9
    const idleRPM = 1000;
    const maxRPM = 8000;
    let currentRPM = idleRPM;
    let clutchValue = 1.0;
    let handbrakeToggled = false;
    let currentSteer = 0;



    // Track wheel rotation accumulation for rolling animation
    const wheelRotationAccum = [0, 0, 0, 0];



    /* ===== INPUT MANIPULATION RUNTIMES ===== */
    const handleMouseMove = (e) => {
        const rect = renderer.domElement.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        currentSteer = 1 - x * 2;
        const sign = Math.sign(currentSteer);
        const b = 2;
        currentSteer = sign * (1 - Math.pow((1 - Math.pow(Math.abs(currentSteer), b)), 1 / b));
    };
    window.addEventListener('mousemove', handleMouseMove);



    const keys = {};
    let hbUpdated = true;
    const handleKeyDown = (e) => {
        const key = e.key.toLowerCase();
        keys[key] = true;



        if (key === 'e' && currentGear < 6) { currentGear++; clutchValue = 0.0; }
        if (key === 'q' && currentGear > -1) { currentGear--; clutchValue = 0.0; }



        if (key === ' ' && !hbUpdated) {
            const forwardVector = new CANNON.Vec3(1, 0, 0);
            chassisBody.quaternion.vmult(forwardVector, forwardVector);
            const currentSpeedKMH = Math.abs(chassisBody.velocity.dot(forwardVector) * 3.6);
            if (currentSpeedKMH < 2) {
                handbrakeToggled = !handbrakeToggled;
                hbUpdated = true;
                console.log("Handbrake is: ", handbrakeToggled);
            }
        }
        if (key === 'r') {
            /* chassisBody.position.y = 2;
            chassisBody.quaternion.set(0, 0, 0, 1);
            chassisBody.velocity.set(0, 0, 0);
            chassisBody.angularVelocity.set(0, 0, 0);
            currentGear = 1; currentRPM = idleRPM; clutchValue = 1.0; handbrakeToggled = false;
            wheelRotationAccum[0] = wheelRotationAccum[1] = wheelRotationAccum[2] = wheelRotationAccum[3] = 0; */
            repairAndResetVehicle()
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', (e) => {
        if (e.key === ' ') {
            hbUpdated = false;
        }
    });



    const handleKeyUp = (e) => {
        const key = e.key.toLowerCase();
        keys[key] = false;
        if (key === ' ') {
            const forwardVector = new CANNON.Vec3(1, 0, 0);
            chassisBody.quaternion.vmult(forwardVector, forwardVector);
            const currentSpeedKMH = Math.abs(chassisBody.velocity.dot(forwardVector) * 3.6);
            if (currentSpeedKMH >= 2) handbrakeToggled = false;
        }
    };
    window.addEventListener('keyup', handleKeyUp);



    const handleResize = () => {
        width = window.innerWidth; height = window.innerHeight;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        composer.setSize(width, height);
    };
    window.addEventListener('resize', handleResize);

    function resetCarParallelToGround(chassisBody, chassisMesh) {
        if (!chassisBody) return;

        // 1. Extract current flat coordinates to sample landscape nodes underneath the chassis
        const currentX = chassisBody.position.x;
        const currentZ = chassisBody.position.z;

        // Sample a small triangular footprint layout surrounding the vehicle frame center
        const delta = 1.5;
        const hCenter = getTerrainHeight(currentX, currentZ);
        const hForward = getTerrainHeight(currentX, currentZ - delta);
        const hRight = getTerrainHeight(currentX + delta, currentZ);

        // 2. Construct the exact 3D slope directional vectors
        const vCenter = new THREE.Vector3(currentX, hCenter, currentZ);
        const vForward = new THREE.Vector3(currentX, hForward, currentZ - delta);
        const vRight = new THREE.Vector3(currentX + delta, hRight, currentZ);

        // Form flat plane tangent vectors
        const tangentZ = new THREE.Vector3().subVectors(vForward, vCenter).normalize();
        const tangentX = new THREE.Vector3().subVectors(vRight, vCenter).normalize();

        // Cross-multiply tangents to produce a clean surface Normal Vector pointing away from the slope face
        const groundNormal = new THREE.Vector3().crossVectors(tangentX, tangentZ).normalize();

        // 3. Formulate the parallel orientation tracking matrices
        // Determine the vector heading vector of the car before hitting the reset button
        const currentRotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(chassisMesh.quaternion);
        const currentHeading = new THREE.Vector3(0, 0, -1).applyMatrix4(currentRotationMatrix);
        currentHeading.y = 0; // Project heading flat onto 2D viewport coordinates
        if (currentHeading.lengthSq() < 0.01) currentHeading.set(0, 0, -1);
        currentHeading.normalize();

        // Compute the new custom sideways axis vector matching the slope profile
        const parallelRight = new THREE.Vector3().crossVectors(currentHeading, groundNormal).normalize();
        const parallelForward = new THREE.Vector3().crossVectors(groundNormal, parallelRight).normalize();

        // Map out the directional matrix coordinates
        const alignmentMatrix = new THREE.Matrix4();
        alignmentMatrix.set(
            parallelRight.x, groundNormal.x, -parallelForward.x, 0,
            parallelRight.y, groundNormal.y, -parallelForward.y, 0,
            parallelRight.z, groundNormal.z, -parallelForward.z, 0,
            0, 0, 0, 1
        );

        const targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(alignmentMatrix);

        // 4. Reset velocities to clean zero states to prevent catastrophic phantom impacts
        chassisBody.velocity.set(0, 0, 0);
        chassisBody.angularVelocity.set(0, 0, 0);

        // Randomize safety hover altitude gap metric strictly between 2 to 5 units high
        const randomizedAltitudeGap = 2.0 + Math.random() * 3.0;
        const targetSpawnY = hCenter + randomizedAltitudeGap;

        // 5. Commit coordinates directly into Cannon.js physical engine joints
        chassisBody.position.set(currentX, targetSpawnY, currentZ);
        chassisBody.quaternion.set(
            targetQuaternion.x,
            targetQuaternion.y,
            targetQuaternion.z,
            targetQuaternion.w
        );

        // Sync wheel physics assemblies back to zero out rotational momentum forces
        if (typeof vehicle !== 'undefined' && vehicle.wheelBodies) {
            vehicle.wheelBodies.forEach(wheel => {
                wheel.velocity.set(0, 0, 0);
                wheel.angularVelocity.set(0, 0, 0);
            });
        }

        console.log(`Car cleanly re-aligned parallel to slope normal at altitude offset: +${randomizedAltitudeGap.toFixed(2)} units.`);
    }

    // Complete Recovery Sequence 
    function repairAndResetVehicle() {
        isEngineBroken = false;
        document.getElementById('engine-broken-overlay').style.display = 'none';

        // Smoothly restore the resting engine volume scale
        if (audioInitialized && engineGain) {
            engineGain.gain.setTargetAtTime(0.15, audioCtx.currentTime, 0.1);
        }

        // Teleport structural frame body safely above your ground map plane mesh
        /* chassisBody.position.y = 2;
        chassisBody.quaternion.set(0, 0, 0, 1); */
        resetCarParallelToGround(chassisBody, carVisualChassis);
        chassisBody.velocity.set(0, 0, 0);
        chassisBody.angularVelocity.set(0, 0, 0);

        // Clear simulation variables
        currentGear = 1;
        currentRPM = idleRPM;
        clutchValue = 1.0;
        handbrakeToggled = false;
        wheelRotationAccum[0] = wheelRotationAccum[1] = wheelRotationAccum[2] = wheelRotationAccum[3] = 0;
    }

    /**
 * Drives audio frequency modifiers using real-time car metrics
 */
    function updateProceduralAudio(rpm, isSlipping, isEngineBroken) {
        if (!audioInitialized || !audioCtx) return;

        // Standard safety check: resume context if it falls into a suspended state
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        // 1. CALCULATE ENGINE CHARACTERISTICS
        if (isEngineBroken) {
            // If the car suffered a Money Shift, drop pitch to 0 and kill the engine sound
            engineOscillator.frequency.setTargetAtTime(0, audioCtx.currentTime, 0.05);
            engineGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
        } else {
            // Map raw engine RPM to a pleasant acoustic frequency range (Hz)
            // Idle (1000 RPM) maps around 35Hz, Redline (8500 RPM) screams around 250Hz
            const targetFrequency = (rpm / 1000) * 28;
            engineOscillator.frequency.setTargetAtTime(targetFrequency, audioCtx.currentTime, 0.1);

            // Slightly increase engine volume under high acceleration loads
            const targetVolume = 0.12 + (rpm / 8500) * 0.08;
            engineGain.gain.setTargetAtTime(targetVolume, audioCtx.currentTime, 0.1);
        }

        // 2. CALCULATE TIRE SCREECH CHARACTERISTICS
        if (isSlipping && !isEngineBroken) {
            // Fade in tire shrieking smoothly over 0.05 seconds
            tireGain.gain.setTargetAtTime(0.25, audioCtx.currentTime, 0.05);
        } else {
            // Cut tire sound quickly when traction is regained or if the car is stationary
            tireGain.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.08);
        }
    }

    // Bind to DOM element event loop targets
    // document.getElementById('repairBtn').addEventListener('click', repairAndResetVehicle);



    const maxEngineTorque = 510;
    const maxBrakeForce = 50;
    const handbrakeForce = 120;
    const normalRearFriction = 8.5;
    const normalFrontFriction = 7.5;
    const driftFrictionSlip = 4.0;
    const maxSteer = 0.75;
    let currentHandbrake = 0;
    let currentBrake = 0;



    const camOffset = new THREE.Vector3(-8, 3.5, 0);
    const targetLook = new THREE.Vector3();
    const carPos = new THREE.Vector3();
    const timer = new THREE.Timer();

    resetCarParallelToGround(chassisBody, carVisualChassis);

    // new CANNON.Vec3(0.9, 0.25, 2.15)
    const aRandomMesh = new THREE.Mesh(new THREE.BoxGeometry(4.5, 1, 2.25));
    scene.add(aRandomMesh);



    /* ===== INTERNAL ANIMATE FRAMELOOP ===== */
    function animate() {
        stats.begin();
        timer.update();
        let dt = timer.getDelta();
        if (dt > 0.05) dt = 0.05;

        dirLight.position.x = camera.position.x + 300;
        dirLight.position.z = camera.position.z + 200;

        dirLight.target.position.x = camera.position.x;
        dirLight.target.position.z = camera.position.z;

        dirLight.target.updateMatrixWorld();

        aRandomMesh.position.copy(chassisBody.position);

        // groundBody.position.set(chassisBody.position.x, -10, chassisBody.position.z);
        // Physics body
        // Visual mesh
        /* planeMesh.position.set(Math.floor(chassisBody.position.x / 10) * 10, 0, Math.floor(chassisBody.position.z / 10) * 10);
        groundBody.position.set(planeMesh.position.x, -10, planeMesh.position.z); */

        if (animalFlockSystem && typeof animalFlockSystem.update === 'function') {
            animalFlockSystem.update(dt, chassisBody);
        }



        for (let i = 0; i < 4; i++) {
            vehicle.applyEngineForce(0, i);
            vehicle.setBrake(0, i);
        }
        vehicle.setSteeringValue(0, 0);
        vehicle.setSteeringValue(0, 1);



        const isHandbraking = keys[' '] || false;
        const isBraking = keys['s'] || false;
        const isManualClutch = keys['c'];
        const isAccelerating = keys['w'];



        if (isAccelerating && handbrakeToggled && !isBraking) handbrakeToggled = false;
        if (taillightMat) {
            if (isBraking || (currentGear < 0 && isAccelerating) || (handbrakeToggled !== isHandbraking)) taillightMat.emissiveIntensity = 500;
            else taillightMat.emissiveIntensity = 0.5;
        }



        chassisBody.linearDamping = gearDampingProfiles[currentGear];
        clutchValue = (isManualClutch || currentGear === 0) ? 0 : 1;



        const forwardVector = new CANNON.Vec3(1, 0, 0);
        chassisBody.quaternion.vmult(forwardVector, forwardVector);
        const speed = chassisBody.velocity.dot(forwardVector);
        // const speedKmH = Math.abs(Math.round(speed * 3.6));
        let speedKmH;

        // Check if grounded
        /* const leftFrontGrounded = vehicle.wheelInfos[0].raycastResult.hasHit;
        const rightFrontGrounded = vehicle.wheelInfos[1].raycastResult.hasHit;
        const leftRearGrounded = vehicle.wheelInfos[2].raycastResult.hasHit;
        const rightRearGrounded = vehicle.wheelInfos[3].raycastResult.hasHit;

        const driveWheelsGrounded = leftRearGrounded || rightRearGrounded;
        const anyWheelGrounded = leftFrontGrounded || rightFrontGrounded || leftRearGrounded || rightRearGrounded;

        if (anyWheelGrounded) {
            speedKmH = Math.abs(Math.round(speed * 3.6));
        } else {
            //speedKmH = Math.abs(Math.round(speed * 1.6));
        } */



        let dynamicDownforce = 0;
        if (Math.abs(speed) > 1) dynamicDownforce = Math.min(5.8, Math.pow(speed, 2) * 0.015);
        if (isBraking || isHandbraking || handbrakeToggled && currentGear !== -1) dynamicDownforce = Math.min(5.9, dynamicDownforce + 1.2);
        if (dynamicDownforce > 0) {
            chassisBody.applyForce(new CANNON.Vec3(0, -dynamicDownforce * chassisBody.mass * 0.05, 0), new CANNON.Vec3(0, 0, 0));
        }



        const wheelRadius = 0.5;
        const mechanicalWheelRadSec = Math.abs(speed) / wheelRadius;
        const mechanicalWheelRPM = (mechanicalWheelRadSec * 60) / (2 * Math.PI);
        const theoreticalConnectedRPM = mechanicalWheelRPM * Math.abs(gearRatios[currentGear]) * finalDriveRatio;



        if (clutchValue < 0.2) {
            currentRPM = keys['w'] ? lerp(currentRPM, maxRPM, dt * 2.2) : lerp(currentRPM, idleRPM, dt * 1.2);
        } else {
            if (keys['w']) {
                let targetThrottleRev = lerp(idleRPM, maxRPM, Math.min(1.0, Math.abs(speed) * 0.10 * Math.abs(gearRatios[currentGear])));
                let engineTarget = lerp(targetThrottleRev, theoreticalConnectedRPM, clutchValue);
                currentRPM = lerp(currentRPM, Math.max(engineTarget, theoreticalConnectedRPM), dt * 4);
                // currentRPM = Math.max(engineTarget, theoreticalConnectedRPM);
            } else {
                currentRPM = lerp(currentRPM, Math.max(idleRPM, theoreticalConnectedRPM), dt * 4);
                // currentRPM = Math.max(idleRPM, theoreticalConnectedRPM);
            }
        }



        if (currentRPM >= maxRPM - 100 && keys['w']) currentRPM = maxRPM - (Math.random() * 350);
        if (currentRPM < idleRPM) currentRPM = idleRPM;
        // MONEY SHIFT MONITORING EVALUATION
        if (currentRPM > 8500 && !isEngineBroken) {
            isEngineBroken = true;
            document.getElementById('engine-broken-overlay').style.display = 'flex';
        }

        // Drop values down to absolute zero once mechanical lock is achieved
        /* if (isEngineBroken) {
            currentRPM = 0;
        } */



        if (isAccelerating && currentGear !== 0 && !handbrakeToggled && !isEngineBroken) {
            const rawRatio = Math.abs(gearRatios[currentGear]);
            let customGearMultiplier = lerp(1.0, 2.3, (rawRatio - 0.67) / (3.15 - 0.67));
            let torqueExpression = maxEngineTorque * customGearMultiplier * finalDriveRatio;

            if (currentRPM < 1800 && rawRatio < 1.5) torqueExpression *= Math.max(0.2, currentRPM / 1800);
            if (currentRPM > 7000) torqueExpression *= (1.0 - (currentRPM - 7000) / (maxRPM - 7000));

            torqueExpression *= clutchValue;
            const engineForceSign = (currentGear === -1) ? -torqueExpression : torqueExpression;
            vehicle.applyEngineForce(engineForceSign, 2);
            vehicle.applyEngineForce(engineForceSign, 3);
        } else if (isEngineBroken) {
            // FORCE HARD NEUTRAL: No torque transmission can reach the drive axle when blown
            vehicle.applyEngineForce(0, 2);
            vehicle.applyEngineForce(0, 3);
        }



        if (isBraking) {
            currentBrake = lerp(currentBrake, maxBrakeForce, dt);
            if (speed < -1) {
                vehicle.setBrake(currentBrake * 0.2, 0); vehicle.setBrake(currentBrake * 0.2, 1);
                vehicle.setBrake(currentBrake * 1.0, 2); vehicle.setBrake(currentBrake * 1.0, 3);
                chassisBody.applyTorque(new CANNON.Vec3(0, 0, currentBrake * 50));
            } else {
                for (let i = 0; i < 4; i++) vehicle.setBrake(currentBrake, i);
            }
        }



        if (isHandbraking || handbrakeToggled) {
            currentHandbrake = lerp(currentHandbrake, handbrakeForce, dt);
            vehicle.setBrake(currentHandbrake, 2);
            vehicle.setBrake(currentHandbrake, 3);
            if (speed < -1) chassisBody.applyTorque(new CANNON.Vec3(0, 0, currentHandbrake * 80));
            vehicle.wheelInfos[2].frictionSlip = driftFrictionSlip;
            vehicle.wheelInfos[3].frictionSlip = driftFrictionSlip;
        } else {
            vehicle.wheelInfos[0].frictionSlip = normalFrontFriction;
            vehicle.wheelInfos[1].frictionSlip = normalFrontFriction;
            vehicle.wheelInfos[2].frictionSlip = normalRearFriction;
            vehicle.wheelInfos[3].frictionSlip = normalRearFriction;
        }



        const speedFactor = Math.max(0.25, 1.0 - Math.abs(speed) * 0.012);
        const steer = maxSteer * currentSteer * speedFactor;
        vehicle.setSteeringValue(steer, 0);
        vehicle.setSteeringValue(steer, 1);



        const displayGear = currentGear === -1 ? 'R' : currentGear === 0 ? 'N' : currentGear;
        const handbrakeHUDText = (handbrakeToggled !== isHandbraking) || handbrakeToggled ? '<span style="color:#ff3333; font-weight:bold;">[PARK]</span>' : '[OFF]';



        /* hud.innerHTML = `
            <span class="name">GEAR :</span><span style="color: #4CAF50;">${displayGear}</span><br>
            <span class="name">RPM &nbsp;:</span><span style="color: #4CAF50;">${Math.round(currentRPM)}</span><br>
            <span class="name">SPD &nbsp;:</span><span style="color: #4CAF50;">${speedKmH} KM/H</span><br>
            <span class="name">CLT &nbsp;:</span><span style="color: ${isManualClutch ? '#4CAF50' : '#F44336'}">${isManualClutch ? "Engaged" : "Disengaged"}</span><br>
            <span class="name">P-BRAKE:</span><span style="color: #4CAF50;">${handbrakeHUDText}</span><br>
            <span style="font-size:12px; color:#aaa;" class="info">[Q/E] Shift | [R] Reset | [Space] Handbrake Toggle</span>
        `; */



        updateHUDGauges(speedKmH, currentRPM, currentGear);

        // Track if either rear tire is experiencing a lateral slide or handbrake lock
        const isCarCurrentlyDrifting = wasWheelSlipping[0] || wasWheelSlipping[1];

        if (chassisBody) {
            // 1. Instantly stream the collision map surface nodes directly under the wheels
            updateStreamingPhysicsFloor(chassisBody.position.x, chassisBody.position.z, world);

            // 2. Then update your surrounding graphics rendering layout chunks
            updateDynamicWorldChunks(camera.position.x, camera.position.z, scene, camera, dt);
            updateGrassSystem(grassSystem, camera, dt);
        }

        // Maintain wind uniform timelines smoothly
        if (grassMaterialGlobal && grassMaterialGlobal.userData.shaderUniforms) {
            grassMaterialGlobal.userData.shaderUniforms.uTime.value = Date.now() * 0.001;
        }

        updateProceduralAudio(currentRPM, isCarCurrentlyDrifting, isEngineBroken);

        world.step(dt, dt, 10);

        if (animalFlockSystem && typeof animalFlockSystem.syncMeshes === 'function') {
            animalFlockSystem.syncMeshes(camera);
        }



        carVisualChassis.position.copy(chassisBody.position);
        carVisualChassis.quaternion.copy(chassisBody.quaternion);



        /* ===== REALISTIC WHEEL ROLLING ANIMATION ===== */
        for (let i = 0; i < vehicle.wheelInfos.length; i++) {
            vehicle.updateWheelTransform(i);
            const t = vehicle.wheelInfos[i].worldTransform;
            const wheel = visualWheelMeshes[i];


            const wheelInfo = vehicle.wheelInfos[i];
            let rollAngleDelta = 0;


            if (i === 0 || i === 1) {
                const steeringAngle = wheelInfo.steering;
                const effectiveSpeed = speed * Math.cos(steeringAngle);
                rollAngleDelta = effectiveSpeed / wheelInfo.radius * dt;
            } else {
                rollAngleDelta = speed / wheelInfo.radius * dt;
            }


            wheelRotationAccum[i] -= rollAngleDelta;


            const baseQuat = new THREE.Quaternion();
            baseQuat.copy(carVisualChassis.quaternion);


            const steerQuat = new THREE.Quaternion();
            if (i === 0 || i === 1) {
                steerQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), wheelInfo.steering);
            }


            const rollQuat = new THREE.Quaternion();
            rollQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), wheelRotationAccum[i]);


            wheel.quaternion.copy(baseQuat).multiply(steerQuat).multiply(rollQuat);
            wheel.position.copy(t.position);
        }



        carPos.copy(carVisualChassis.position);
        const newCamOffset = camOffset.clone().multiply(new THREE.Vector3(1, Math.min(1, 50 / Math.max(0.001, speed)), 1));
        // console.log(newCamOffset);
        const camGoal = newCamOffset.applyQuaternion(carVisualChassis.quaternion).add(carPos);
        camGoal.setY(Math.abs(camGoal.y));
        camera.position.lerp(camGoal, 0.1);
        // camera.position.setY(5);
        targetLook.lerp(carPos, 0.1);
        camera.lookAt(targetLook);



        /* ===== DYNAMIC CINEMATIC BOKEH SPEED-BLUR SYSTEM ===== */
        const distanceToCar = camera.position.distanceTo(chassisBody.position);

        // Convert physics velocity to KM/H
        const speedKmh = speed * 3.6;

        // 1. Base tracking behavior: keep the lens focused on the car's distance
        let targetFocus = distanceToCar;
        let targetAperture = 0.001; // Crystal-clear uniform focus when slow/stopped
        let targetMaxBlur = 0.015;  // Subtle background softness limit

        if (speedKmh > 20) {
            // 2. High-Speed Lens Stress Simulation
            // As the car gets faster, we narrow the focus pool and open the camera aperture wide
            const speedFactor = Math.min(1.0, (speedKmh - 20) / 100); // Max out effect at 120 KM/H

            // Push aperture wide open to create a razor-thin depth-of-field
            targetAperture = 0.0001 + (speedFactor * 0.002);

            // Crank max blur bounds so distant objects turn into smooth bokeh circles
            targetMaxBlur = 0.0002 + (speedFactor * 0.001);

            // 3. Focal Length Vibration (Optional Juice)
            // Adds tiny micro-adjustments to the lens tracking if you go off-road on hills
            if (speedKmh > 60) {
                targetFocus += Math.sin(Date.now() * 0.02) * (speedFactor * 0.15);
            }
        }

        /* if (grassMaterialPointer && grassMaterialPointer.userData.shaderUniforms) {
            // Sync browser timestamp to the vertex shader uniform register
            grassMaterialPointer.userData.shaderUniforms.uTime.value = Date.now() * 0.001;
        } */
        /* for (const chunkData of activeChunks.values()) {

            const grass = chunkData.chunkMesh.children.find(
                child => child.isInstancedMesh
            );

            if (!grass) continue;

            const box = new THREE.Box3().setFromObject(grass);

            grass.visible = frustum.intersectsBox(box);
        } */

        // Smoothly interpolate (lerp) the lens values over frames to prevent jarring jumps
        bokehPass.uniforms['focus'].value = lerp(bokehPass.uniforms['focus'].value, targetFocus, 0.1);
        // bokehPass.uniforms['aperture'].value = lerp(bokehPass.uniforms['aperture'].value, targetAperture, 0.08);
        // bokehPass.uniforms['maxblur'].value = lerp(bokehPass.uniforms['maxblur'].value, targetMaxBlur, 0.08);
        afterimagePass.uniforms["damp"].value = dt * 10;

        composer.render(scene, camera);
        stats.end();
        requestAnimationFrame(animate);
    }

    loadingDiv.style.display = "none";
    loadingDiv.style.opacity = "0%";
    requestAnimationFrame(animate);
}