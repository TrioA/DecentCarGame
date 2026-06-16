/* ===== IMPORTS ===== */
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import Stats from 'three/addons/libs/stats.module';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as CANNON from 'cannon-es';



/* ===== POST-PROCESSING IMPORTS ===== */
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';



const exrLoader = new EXRLoader();
const fbxLoader = new FBXLoader();



let width = window.innerWidth;
let height = window.innerHeight;



/* ===== HELPER ===== */
function lerp(a, b, t) {
    if (typeof a == "object" && a.constructor == Object) {
        let res = {};
        for (let k of Object.keys(a)) res[k] = lerp(a[k], b[k], t);
        return res;
    }
    return a + (b - a) * t;
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



    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 2000);
    camera.position.set(-10, 5, 0);



    const stats = new Stats();
    document.body.appendChild(stats.dom);



    let assetsLoading = 2;



    /* ===== SKYBOX ===== */
    await new Promise(res => exrLoader.load('./images/autumn_field_puresky_1k.exr', (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        scene.background = texture;
        scene.environment = texture;
        assetsLoading--;
        // if (assetsLoading <= 0) loadingDiv.style.display = 'none';
        res();
    }));



    /* ===== COMPOSITOR SETUP ===== */
    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);



    const bokehPass = new BokehPass(scene, camera, {
        focus: 7.0,
        aperture: 0.0001,
        maxblur: 0.005,
        width: width,
        height: height
    });
    composer.addPass(bokehPass);



    const fxaaPass = new ShaderPass(FXAAShader);
    fxaaPass.material.uniforms['resolution'].value.set(1 / width, 1 / height);
    composer.addPass(fxaaPass);



    const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.01, 0.7, 0);
    composer.addPass(bloomPass);



    const vignettePass = new ShaderPass(VignetteShader);
    vignettePass.uniforms['darkness'].value = 0.8;
    vignettePass.uniforms['offset'].value = 1.0;
    composer.addPass(vignettePass);



    const outputPass = new OutputPass();
    composer.addPass(outputPass);



    /* ===== LIGHTS ===== */
    const dirLight = new THREE.DirectionalLight(0xffffff, 3);
    dirLight.position.set(30, 80, 30);
    scene.add(dirLight);
    scene.add(new THREE.AmbientLight(0x506070, 0.8));



    /* ===== PHYSICS WORLD ===== */
    const world = new CANNON.World();
    world.gravity.set(0, -9.82, 0);
    world.broadphase = new CANNON.NaiveBroadphase();
    world.solver.iterations = 30;



    /* ===== STATIC GROUND MAP ===== */
    const PLANE_SIZE = 10000;
    const gridCanvas = document.createElement('canvas');
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
    /* const groundBody = new CANNON.Body({ mass: 0, material: groundMaterial });
    groundBody.addShape(new CANNON.Plane());
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody); */
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
    scene.add(planeMesh);



    /* ===== CHASSIS VISUAL INITIALIZATION ===== */
    const carVisualChassis = new THREE.Group();
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



    const chassisBody = new CANNON.Body({ mass: 15000 });
    chassisBody.addShape(new CANNON.Box(new CANNON.Vec3(0.9, 0.35, 2.15)), new CANNON.Vec3(0, -0.32, 0.2));
    chassisBody.position.set(0, 1.8, 0);
    chassisBody.linearDamping = 0.1;
    chassisBody.angularDamping = 0.5;
    world.addBody(chassisBody);



    /* ===== RAYCAST VEHICLE SYSTEM ===== */
    const vehicle = new CANNON.RaycastVehicle({ chassisBody, indexUpAxis: 1, indexForwardAxis: 2 });
    const wheelMaterial = new CANNON.Material('wheel');



    const frontWheelOptions = {
        radius: 0.45, directionLocal: new CANNON.Vec3(0, -1, 0), axleLocal: new CANNON.Vec3(0, 0, -1),
        suspensionStiffness: 35, suspensionRestLength: 0.4, maxSuspensionTravel: 0.15,
        dampingRelaxation: 2.8, dampingCompression: 2.0, frictionSlip: 7.5, rollInfluence: 0.01, maxSuspensionForce: 1e12
    };



    const rearWheelOptions = {
        radius: 0.45, directionLocal: new CANNON.Vec3(0, -1, 0), axleLocal: new CANNON.Vec3(0, 0, -1),
        suspensionStiffness: 30, suspensionRestLength: 0.4, maxSuspensionTravel: 0.15,
        dampingRelaxation: 2.5, dampingCompression: 1.8, frictionSlip: 8.5, rollInfluence: 0.01, maxSuspensionForce: 1e12
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
        friction: 0.9, restitution: 0.0, contactEquationStiffness: 1e8, contactEquationRelaxation: 3
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

    // Complete Recovery Sequence 
    function repairAndResetVehicle() {
        isEngineBroken = false;
        document.getElementById('engine-broken-overlay').style.display = 'none';

        // Smoothly restore the resting engine volume scale
        if (audioInitialized && engineGain) {
            engineGain.gain.setTargetAtTime(0.15, audioCtx.currentTime, 0.1);
        }

        // Teleport structural frame body safely above your ground map plane mesh
        chassisBody.position.y = 2;
        chassisBody.quaternion.set(0, 0, 0, 1);
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
            const targetFrequency = (rpm / 1000) * 22;
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



    const maxEngineTorque = 5100;
    const maxBrakeForce = 500;
    const handbrakeForce = 1200;
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



    /* ===== INTERNAL ANIMATE FRAMELOOP ===== */
    function animate() {
        stats.begin();
        timer.update();
        let dt = timer.getDelta();
        if (dt > 0.05) dt = 0.05;



        dirLight.position.set(chassisBody.position.x, chassisBody.position.y + 5, chassisBody.position.z);
        dirLight.lookAt(chassisBody.position);

        // groundBody.position.set(chassisBody.position.x, -10, chassisBody.position.z);
        // Physics body
        // Visual mesh
        /* planeMesh.position.set(Math.floor(chassisBody.position.x / 10) * 10, 0, Math.floor(chassisBody.position.z / 10) * 10);
        groundBody.position.set(planeMesh.position.x, -10, planeMesh.position.z); */



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
        const speedKmH = Math.abs(Math.round(speed * 3.6));



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

        updateProceduralAudio(currentRPM, isCarCurrentlyDrifting, isEngineBroken);

        world.step(1 / 120, dt, 10);



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
        camera.position.lerp(camGoal, 0.1);
        // camera.position.setY(5);
        targetLook.lerp(carPos, 0.1);
        camera.lookAt(targetLook);



        const distanceToCar = camera.position.distanceTo(chassisBody.position);
        bokehPass.uniforms['focus'].value = lerp(bokehPass.uniforms['focus'].value, distanceToCar, 0.1);



        composer.render(scene, camera);
        stats.end();
        requestAnimationFrame(animate);
    }

    loadingDiv.style.display = "none";
    loadingDiv.style.opacity = "0%";
    requestAnimationFrame(animate);
}