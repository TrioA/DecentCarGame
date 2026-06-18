/**
 * ================================================================
 *  ANIMAL FLOCK SYSTEM  —  animals.js
 * ================================================================
 *  Boids-based flocking AI driving physics cubes that can be hit
 *  by the player car and sent flying.
 *
 *  HOW TO EDIT THE AI:
 *  -------------------
 *  All tuning knobs live in FLOCK_CONFIG below.
 *  Each boid behaviour has its own clearly labelled block.
 *  You can also add new rules in applyFlockingForces().
 * ================================================================
 */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// ================================================================
//  ★  FLOCK CONFIG  –  edit anything here to tune the AI  ★
// ================================================================
export const FLOCK_CONFIG = {
    // --- Herd setup ---
    FLOCK_COUNT: 20,     // total number of animals in one herd
    NUM_FLOCKS: 3,      // how many separate herds to spawn
    SPAWN_RADIUS: 50,     // animals scatter this far from their herd centre
    HERD_SPREAD: 250,    // how far apart herd centres are from the origin

    // --- Physics body ---
    ANIMAL_MASS: 40,     // kg – heavier = harder to launch, lighter = more satisfying
    ANIMAL_HALF_SIZE: 0.6,    // half-extent of the cube collider (full size = 2×this)
    LINEAR_DAMPING: 0.6,    // drag when sliding on ground
    ANGULAR_DAMPING: 0.7,    // rotational drag

    // --- AI perception ---
    PERCEPTION_RADIUS: 18,     // how far an animal can "see" its neighbours
    SEPARATION_RADIUS: 3.5,    // personal-space radius — push apart when closer than this

    // --- AI force weights (larger = stronger influence) ---
    WEIGHT_SEPARATION: 3.2,    // avoid crowding neighbours
    WEIGHT_ALIGNMENT: 1.0,    // steer toward average heading of neighbours
    WEIGHT_COHESION: 0.8,    // steer toward centre of neighbours
    WEIGHT_WANDER: 0.4,    // random wander so they don't freeze when alone
    WEIGHT_TERRAIN: 6.0,    // push upward to stay above ground (anti-sink)
    WEIGHT_HERD_HOME: 0.15,   // gentle pull back toward the herd's home position

    // --- Movement limits ---
    MAX_SPEED: 6.0,    // m/s horizontal cruise speed cap
    MAX_FORCE: 28.0,   // N per unit mass – max AI steering impulse
    GROUNDED_THRESHOLD: 1.5,   // if body is < this height above terrain, animal is "grounded"
    LAUNCH_SPEED: 3.5,    // m/s — if car hits animal above this, treat as a launch

    // --- Recovery ---
    RECOVERY_TIME: 4.0,    // seconds an animal stays in ragdoll mode after being hit
    RECOVERY_IMPULSE: 12.0,   // upward impulse when recovering from a hit
    // --- LOD / Physics ---
    PHYSICS_DISABLE_DISTANCE: 5,
    PHYSICS_ENABLE_DISTANCE: 30,
    PHYSICS_DISABLE_DELAY: 5,

    // --- Visual ---
    // PBR texture path for animal cubes (uses ganges pebbles set as a fun look)
    ANIMAL_TEXTURE_PATH: './images/pbr/ganges_river_pebbles_2k/textures/',
    ANIMAL_VISUAL_SCALE: 1.0,  // visual mesh scale relative to physics cube
};

// ================================================================
//  Internal helpers
// ================================================================

/** Clamp a vector's XZ magnitude, leave Y intact. */
function clampXZ(v3, maxLen) {
    const xzLenSq = v3.x * v3.x + v3.z * v3.z;
    const maxLenSq = maxLen * maxLen;

    if (xzLenSq > maxLenSq) {
        const invLen = maxLen / Math.sqrt(xzLenSq);
        v3.x *= invLen;
        v3.z *= invLen;
    }
}

/** Sample terrain height using the global getTerrainHeight exposed on window. */
function sampleGround(x, z) {
    if (typeof window.getTerrainHeight === 'function') return window.getTerrainHeight(x, z);
    return 0;
}

// ================================================================
//  Boid  —  one animal instance
// ================================================================
class Boid {
    /**
     * @param {CANNON.World}  world
     * @param {THREE.Scene}   scene
     * @param {THREE.Object3D} mesh  shared InstancedMesh (we just update matrix)
     * @param {number}        index  instance index inside the InstancedMesh
     * @param {CANNON.Vec3}   home   herd home position
     * @param {THREE.Vector3} threeHome  same but THREE
     */
    constructor(world, scene, index, home, threeHome, material) {
        this.index = index;
        this.home = home.clone();

        // ---- Physics body ----
        const shape = new CANNON.Box(new CANNON.Vec3(
            FLOCK_CONFIG.ANIMAL_HALF_SIZE,
            FLOCK_CONFIG.ANIMAL_HALF_SIZE,
            FLOCK_CONFIG.ANIMAL_HALF_SIZE
        ));
        this.body = new CANNON.Body({
            mass: FLOCK_CONFIG.ANIMAL_MASS,
            linearDamping: FLOCK_CONFIG.LINEAR_DAMPING,
            angularDamping: FLOCK_CONFIG.ANGULAR_DAMPING,
        });
        this.body.addShape(shape);

        // Random spawn near home
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * FLOCK_CONFIG.SPAWN_RADIUS;
        const spawnX = home.x + Math.cos(angle) * radius;
        const spawnZ = home.z + Math.sin(angle) * radius;
        const spawnY = sampleGround(spawnX, spawnZ) + FLOCK_CONFIG.ANIMAL_HALF_SIZE * 2 + 1;
        this.body.position.set(spawnX, spawnY, spawnZ);
        this.body.velocity.set(
            (Math.random() - 0.5) * 2,
            0,
            (Math.random() - 0.5) * 2
        );

        world.addBody(this.body);

        this.body.allowSleep = true;
        this.body.sleepSpeedLimit = 0.1;
        this.body.sleepTimeLimit = 100.0;

        this.physicsDisabled = false;
        this.farTimer = 0;

        // ---- Visual mesh (one cube per boid) ----
        const size = FLOCK_CONFIG.ANIMAL_HALF_SIZE * 2 * FLOCK_CONFIG.ANIMAL_VISUAL_SCALE;
        const geo = new THREE.BoxGeometry(size, size * 1.4, size); // slightly taller so they look like creatures
        const mesh = new THREE.Mesh(geo, material);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        scene.add(mesh);
        this.mesh = mesh;

        // ---- State ----
        this.wanderAngle = Math.random() * Math.PI * 2;
        this.ragdollTimer = 0;   // > 0 = recently hit, no AI steering
        this.isRagdoll = false;
    }

    /** Sync Three.js mesh to Cannon body every frame. */
    syncMesh(camera) {
        this.mesh.visible = true;
        if (camera) {
            const dx = camera.position.x - this.body.position.x;
            const dz = camera.position.z - this.body.position.z;

            if (dx * dx + dz * dz > 400 * 400) {
                this.mesh.visible = false;
                return;
            }
        }

        this.mesh.position.copy(this.body.position);
        this.mesh.quaternion.copy(this.body.quaternion);
    }
}

// ================================================================
//  Animal Flock System
// ================================================================
export function createAnimalFlockSystem(scene, world, chassisBody) {
    const cfg = FLOCK_CONFIG;
    const boids = [];

    // ---- Shared PBR material for all animal cubes ----
    /* const tl = new THREE.TextureLoader();
    const exr = new (window._EXRLoaderClass || THREE.EXRLoader || (() => {
        // fallback: if EXRLoader not directly accessible, use a basic material
        return { load: (_, cb) => { const t = new THREE.DataTexture(); cb(t); return t; } };
    }))();

    // Simple helper — load a texture and configure wrapping
    function loadTex(path, sRGB = false) {
        const t = tl.load(cfg.ANIMAL_TEXTURE_PATH + path);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(1, 1);
        if (sRGB) t.colorSpace = THREE.SRGBColorSpace;
        return t;
    }
    function loadEXR(path) {
        const t = exr.load(cfg.ANIMAL_TEXTURE_PATH + path);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(1, 1);
        return t;
    }

    const animalMaterial = new THREE.MeshStandardMaterial({
        map: loadTex('diff.jpg', true),
        roughnessMap: loadEXR('rough.exr'),
        normalMap: loadEXR('nor.exr'),
        aoMap: loadTex('ao.jpg'),
        displacementMap: loadTex('disp.jpg'),
        displacementScale: 0.04,
        roughness: 1.0,
        metalness: 0.0,
    }); */

    const animalMaterial = new THREE.MeshBasicMaterial({
        color: 0xff0000,
    })

    // ---- Spawn herds ----
    for (let h = 0; h < cfg.NUM_FLOCKS; h++) {
        const hAngle = (h / cfg.NUM_FLOCKS) * Math.PI * 2;
        const homeDist = cfg.HERD_SPREAD * (0.6 + Math.random() * 0.4);
        const homeX = Math.cos(hAngle) * homeDist;
        const homeZ = Math.sin(hAngle) * homeDist;
        const homeY = sampleGround(homeX, homeZ);
        const home = new CANNON.Vec3(homeX, homeY, homeZ);

        for (let i = 0; i < cfg.FLOCK_COUNT; i++) {
            boids.push(new Boid(world, scene, i, home, null, animalMaterial));
            const boid = boids[i];
            boid.body.addEventListener('collide', (e) => {
                if (e.body.type == 2) return;
                console.log("collided");
                if (e.body.id == chassisBody.id) {
                    console.log("Car collided!");
                    const len = Math.sqrt(e.body.velocity.x * e.body.velocity.x + e.body.velocity.z * e.body.velocity.z) + 0.001;
                    const impulseMag = Math.sqrt(e.body.velocity.x * e.body.velocity.x + e.body.velocity.z * e.body.velocity.z) * boid.body.mass * 0.18;
                    _impulse.set(
                        (e.body.velocity.x / len) * impulseMag,
                        impulseMag * 0.75 + 5,
                        (e.body.velocity.z / len) * impulseMag
                    );
                    boid.body.applyImpulse(_impulse, CANNON.Vec3.ZERO);
                    boid.isRagdoll = true;
                    boid.ragdollTimer = cfg.RECOVERY_TIME;
                }
                // if(e.body === chassisBody){
                //     
                // }
            })
        }
    }

    const boidBodySet = new Set(boids.map(boid => boid.body));

    // ---- Temp vectors (reused every frame to avoid GC pressure) ----
    const _steer = new CANNON.Vec3();
    const _sep = new CANNON.Vec3();
    const _ali = new CANNON.Vec3();
    const _coh = new CANNON.Vec3();
    const _wan = new CANNON.Vec3();
    const _home = new CANNON.Vec3();
    const _diff = new CANNON.Vec3();
    const _totalVel = new CANNON.Vec3();
    const _totalPos = new CANNON.Vec3();

    let isTouching = false;

    /* chassisBody.addEventListener('collide', (e) => {
        // e.body is the body that collided with bodyA (will be bodyB)
        // e.contact contains contact details
        isTouching = true
        console.log('bodyA collided with', e.body)

        // You can also get contact point:
        const contactNormal = new THREE.Vector3()
        e.contact.getContactNormal(contactNormal)
        console.log('Contact normal:', contactNormal)
    }) */

    // ================================================================
    //  ★  FLOCKING RULES  —  edit / add rules here  ★
    // ================================================================

    /**
     * Computes the combined AI steering force for one boid.
     * Returns a CANNON.Vec3 impulse vector (XZ only, Y is terrain push).
     *
     * To add a new rule:
     *   1. Compute a Vec3 force.
     *   2. Multiply by a weight from FLOCK_CONFIG.
     *   3. Add to `steer`.
     */
    function applyFlockingForces(boid, dt, force, impulse) {
        const pos = boid.body.position;
        const vel = boid.body.velocity;

        _sep.set(0, 0, 0);
        _ali.set(0, 0, 0);
        _coh.set(0, 0, 0);
        _totalVel.set(0, 0, 0);
        _totalPos.set(0, 0, 0);
        let neighbourCount = 0;

        const perceptionRadiusSq = cfg.PERCEPTION_RADIUS * cfg.PERCEPTION_RADIUS;
        const separationRadiusSq = cfg.SEPARATION_RADIUS * cfg.SEPARATION_RADIUS;

        for (const other of boids) {
            if (other === boid || other.physicsDisabled) continue;

            const opos = other.body.position;
            const dx = opos.x - pos.x;
            const dz = opos.z - pos.z;
            const distSq = dx * dx + dz * dz;

            if (distSq < perceptionRadiusSq) {
                _totalVel.x += other.body.velocity.x;
                _totalVel.z += other.body.velocity.z;
                _totalPos.x += opos.x;
                _totalPos.z += opos.z;
                neighbourCount++;
            }

            if (distSq < separationRadiusSq && distSq > 0.000001) {
                const invDist = 1 / Math.sqrt(distSq);
                _sep.x -= dx * invDist;
                _sep.z -= dz * invDist;
            }
        }

        _steer.set(0, 0, 0);

        _steer.x += _sep.x * cfg.WEIGHT_SEPARATION;
        _steer.z += _sep.z * cfg.WEIGHT_SEPARATION;

        if (neighbourCount > 0) {
            const invN = 1 / neighbourCount;
            _ali.x = _totalVel.x * invN - vel.x;
            _ali.z = _totalVel.z * invN - vel.z;
            _steer.x += _ali.x * cfg.WEIGHT_ALIGNMENT;
            _steer.z += _ali.z * cfg.WEIGHT_ALIGNMENT;

            _coh.x = _totalPos.x * invN - pos.x;
            _coh.z = _totalPos.z * invN - pos.z;
            _steer.x += _coh.x * cfg.WEIGHT_COHESION;
            _steer.z += _coh.z * cfg.WEIGHT_COHESION;
        }

        boid.wanderAngle += (Math.random() - 0.5) * 1.5 * dt;
        _wan.x = Math.cos(boid.wanderAngle);
        _wan.z = Math.sin(boid.wanderAngle);
        _steer.x += _wan.x * cfg.WEIGHT_WANDER;
        _steer.z += _wan.z * cfg.WEIGHT_WANDER;

        _home.x = boid.home.x - pos.x;
        _home.z = boid.home.z - pos.z;
        const homeDistSq = _home.x * _home.x + _home.z * _home.z;
        if (homeDistSq > 3600) {
            const homeDist = Math.sqrt(homeDistSq);
            const pull = cfg.WEIGHT_HERD_HOME * (homeDist / 60);
            _steer.x += (_home.x / homeDist) * pull;
            _steer.z += (_home.z / homeDist) * pull;
        }

        clampXZ(_steer, cfg.MAX_FORCE);
        clampXZ(boid.body.velocity, cfg.MAX_SPEED);

        force.set(_steer.x * boid.body.mass, 0, _steer.z * boid.body.mass);
        boid.body.applyForce(force, CANNON.Vec3.ZERO);

        const groundY = sampleGround(pos.x, pos.z);
        const heightAboveGround = pos.y - (groundY + cfg.ANIMAL_HALF_SIZE);
        if (heightAboveGround < cfg.GROUNDED_THRESHOLD) {
            const pushStrength = cfg.WEIGHT_TERRAIN * boid.body.mass * Math.max(0, 1 - heightAboveGround / cfg.GROUNDED_THRESHOLD);
            impulse.set(0, pushStrength, 0);
            boid.body.applyForce(impulse, CANNON.Vec3.ZERO);
        }
    }

    const enableDistanceSq = cfg.PHYSICS_ENABLE_DISTANCE * cfg.PHYSICS_ENABLE_DISTANCE;
    const ragdollNearSq = 3 * 3;
    const ragdollFarSq = 5 * 5;
    const impactDistanceSq = 3.5 * 3.5;
    const launchSpeedSq = cfg.LAUNCH_SPEED * cfg.LAUNCH_SPEED;
    const _force = new CANNON.Vec3();
    const _impulse = new CANNON.Vec3();

    function enableBoidPhysics(boid) {
        if (boid.physicsDisabled) {
            boid.physicsDisabled = false;
            boid.farTimer = 0;
            boid.body.type = CANNON.Body.DYNAMIC;
            boid.body.mass = cfg.ANIMAL_MASS;
            boid.body.updateMassProperties();
            boid.body.collisionResponse = true;
            boid.body.wakeUp();
        }
    }

    function disableBoidPhysics(boid) {
        boid.physicsDisabled = true;
        boid.farTimer = 0;
        boid.body.velocity.set(0, 0, 0);
        boid.body.angularVelocity.set(0, 0, 0);
        boid.body.force.set(0, 0, 0);
        boid.body.torque.set(0, 0, 0);
        boid.body.sleep();
        boid.body.type = CANNON.Body.STATIC;
        boid.body.mass = 0;
        boid.body.updateMassProperties();
        boid.body.collisionResponse = false;
        boid.body.aabbNeedsUpdate = true;
    }

    function hasNearbyBody(boid, distanceSq) {
        const pos = boid.body.position;

        for (const body of world.bodies) {
            if (body.type === CANNON.Body.STATIC || boidBodySet.has(body)) continue;

            const dx = body.position.x - pos.x;
            const dz = body.position.z - pos.z;

            if (dx * dx + dz * dz < distanceSq) return true;
        }

        return false;
    }

    // ================================================================
    //  Update  —  called once per frame before world.step
    // ================================================================
    function update(dt, chassisBody) {
        for (const boid of boids) {
            const boidPos = boid.body.position;
            const nearBody = hasNearbyBody(boid, enableDistanceSq);

            if (boid.physicsDisabled) {
                if (!nearBody) continue;
                enableBoidPhysics(boid);
            }

            if (!nearBody) {
                boid.farTimer += dt;
                if (boid.farTimer >= cfg.PHYSICS_DISABLE_DELAY) {
                    disableBoidPhysics(boid);
                    continue;
                }
            } else {
                boid.farTimer = 0;
            }

            if (chassisBody) {
                const cp = chassisBody.position;
                const dx = cp.x - boidPos.x;
                const dz = cp.z - boidPos.z;
                const distSq = dx * dx + dz * dz;

                if (distSq < ragdollNearSq && !boid.isRagdoll) {
                    boid.isRagdoll = true;
                    boid.ragdollTimer = cfg.RECOVERY_TIME;
                } else if (distSq > ragdollFarSq && boid.isRagdoll) {
                    boid.ragdollTimer -= dt;
                    if (boid.ragdollTimer <= 0) {
                        boid.isRagdoll = false;
                        boid.ragdollTimer = cfg.RECOVERY_TIME;
                    }
                }
            }

            if (boid.isRagdoll) {
                boid.ragdollTimer -= dt;
                if (boid.ragdollTimer <= 0) {
                    boid.isRagdoll = false;
                    _impulse.set(0, cfg.RECOVERY_IMPULSE, 0);
                    boid.body.applyImpulse(_impulse, CANNON.Vec3.ZERO);
                    boid.body.angularVelocity.set(0, 0, 0);
                }
                continue;
            }

            if (chassisBody) {
                const cp = chassisBody.position;
                const dx = cp.x - boidPos.x;
                const dy = cp.y - boidPos.y;
                const dz = cp.z - boidPos.z;
                const distSq = dx * dx + dy * dy + dz * dz;
                const cv = chassisBody.velocity;
                const carSpeedSq = cv.x * cv.x + cv.y * cv.y + cv.z * cv.z;

                if (distSq < impactDistanceSq && carSpeedSq > launchSpeedSq) {
                    /* const len = Math.sqrt(cv.x * cv.x + cv.z * cv.z) + 0.001;
                    const impulseMag = Math.sqrt(carSpeedSq) * boid.body.mass * 0.18 * 4;
                    _impulse.set(
                        (cv.x / len) * impulseMag,
                        impulseMag * 0.55 + 5,
                        (cv.z / len) * impulseMag
                    );
                    boid.body.applyImpulse(_impulse, CANNON.Vec3.ZERO);
                    boid.isRagdoll = true;
                    boid.ragdollTimer = cfg.RECOVERY_TIME; */
                    continue;
                }
            }

            applyFlockingForces(boid, dt, _force, _impulse);

            boid.body.angularVelocity.x *= 0.85;
            boid.body.angularVelocity.z *= 0.85;
        }
    }

    // ================================================================
    //  syncMeshes  —  called after world.step
    // ================================================================
    function syncMeshes(camera) {
        for (const boid of boids) {
            boid.syncMesh(camera);
        }
    }

    return { update, syncMeshes, boids };
}
