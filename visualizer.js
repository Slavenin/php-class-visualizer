// --- Глобальные переменные ---
let scene, camera, renderer, controls, labelRenderer, dragControls;
let nodes = [], edges = [];
let graphData = null;
let nodeMeshes = new Map();
let edgeMeshes = new Map(); // key -> edge index in edgeList
let edgeList = [];
let activeEdges = [];
let edgeLines = null;
let edgeLineGeometry = null;
let nodeMaterialCache = new Map();
let forceSim = null;
let forcePhase = 'full'; // 'internal' = без external, 'full' = все узлы
let internalSimFrames = 0;
const EXTERNAL_REVEAL_ALPHA = 0.04;
const EXTERNAL_REVEAL_MIN_FRAMES = 240;
let labelVisibilityFrame = 0;
let animationId;
let nodeScale = 1;
let edgeOpacity = 0.4;
let nodeColorMode = 'degree';
let maxNodeDepCount = 1;
let degreeColorCache = new Map();
let forceStrengthScale = 1.2;
let simulationSpeed = 1.5;
let currentMaxDeps = 200;
let currentLayout = 'force';
let selectedNode = null;
let highlightedNodes = [];
let pointerDownPos = null;
let pointerMovedSinceDown = false;
let suppressNextClick = false;
let isDraggingNode = false;
let nodeDragMoved = false;
let nodeDragStartPosition = null;
const CLICK_MOVE_THRESHOLD = 5;

const keyState = {
    ArrowUp: false,
    ArrowDown: false,
    ArrowLeft: false,
    ArrowRight: false
};
const panSpeed = 2;   // скорость перемещения

// --- Силовая раскладка: Fruchterman–Reingold + spatial hash ---
class ForceSimulator {
    constructor() {
        this.alpha = 1;
        this.alphaMin = 0.001;
        this.alphaDecay = 0.012;
        this.k = 6;
        this.cellSize = 6;
        this.repulsionRadius = 12;
        this.linkDistance = 20;
        this.linkStrength = 0.038;
        this.repulsionStrength = 1;
        this.clusterStrength = 0.0025;
        this.linkForceScale = 1;
        this.centerStrength = 0.0008;
        this.velocityDecay = 0.88;
        this.maxVelocity = 1.8;
        this.timeScale = 1;
        this.meshList = [];
        this.meshToIndex = new Map();
        this.links = [];
        this.positions = null;
        this.velocities = null;
        this.forces = null;
        this.masses = null;
        this.expansionPulse = null;
        this._grid = new Map();
    }

    resetAlpha() {
        this.alpha = 1;
    }

    syncFromMeshes(meshes) {
        this.meshList = meshes;
        const n = meshes.length;
        this.meshToIndex.clear();
        for (let i = 0; i < n; i++) {
            this.meshToIndex.set(meshes[i], i);
        }
        if (!this.positions || this.positions.length !== n * 3) {
            this.positions = new Float32Array(n * 3);
            this.velocities = new Float32Array(n * 3);
            this.forces = new Float32Array(n * 3);
        }
        if (!this.masses || this.masses.length !== n) {
            this.masses = new Float32Array(n);
        }
        for (let i = 0; i < n; i++) {
            const p = meshes[i].position;
            const o = i * 3;
            this.positions[o] = p.x;
            this.positions[o + 1] = p.y;
            this.positions[o + 2] = p.z;
            this.masses[i] = 1;
        }

        const idealVolume = Math.max(12000, n * 620);
        this.k = Math.cbrt(idealVolume / Math.max(n, 1));
        this.linkDistance = this.k * 4.9;
        if (n > 2000) {
            this.alphaDecay = 0.0045;
            this.linkStrength = 0.044;
            this.repulsionStrength = 0.72;
            this.repulsionRadius = this.k * 3.4;
            this.clusterStrength = 0.006;
            this.centerStrength = 0.00035;
            this.velocityDecay = 0.9;
            this.maxVelocity = 3.6;
        } else if (n > 800) {
            this.alphaDecay = 0.007;
            this.linkStrength = 0.046;
            this.repulsionStrength = 0.68;
            this.repulsionRadius = this.k * 3.7;
            this.clusterStrength = 0.005;
            this.centerStrength = 0.00045;
            this.velocityDecay = 0.895;
            this.maxVelocity = 3;
        } else {
            this.alphaDecay = 0.014;
            this.linkStrength = 0.048;
            this.repulsionStrength = 0.62;
            this.repulsionRadius = this.k * 4;
            this.clusterStrength = 0.0035;
            this.centerStrength = 0.0008;
            this.velocityDecay = 0.88;
            this.maxVelocity = 2.2;
        }
        this.cellSize = Math.max(this.repulsionRadius * 0.5, 8);
        this.applyUserSettings();
    }

    applyUserSettings() {
        const forceScale = forceStrengthScale || 1;
        const speedScale = simulationSpeed || 1;

        this.linkStrength *= forceScale;
        this.repulsionStrength *= Math.sqrt(forceScale);
        this.clusterStrength *= forceScale;
        this.centerStrength *= Math.sqrt(forceScale);
        this.linkForceScale = forceScale;
        this.maxVelocity *= speedScale;
        this.timeScale = speedScale;
        this.alphaDecay = 1 - Math.pow(1 - this.alphaDecay, Math.max(speedScale, 0.25));
    }

    setLinks(links) {
        this.links = links;
    }

    setMasses(masses) {
        if (!this.masses || this.masses.length !== masses.length) {
            this.masses = new Float32Array(masses.length);
        }
        this.masses.set(masses);
    }

    startExpansionPulse(strength = 1) {
        const n = this.meshList.length;
        if (n === 0 || !this.positions) return;

        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let i = 0; i < n; i++) {
            const o = i * 3;
            cx += this.positions[o];
            cy += this.positions[o + 1];
            cz += this.positions[o + 2];
        }
        cx /= n;
        cy /= n;
        cz /= n;

        let maxRadius = 0;
        let radiusSum = 0;
        for (let i = 0; i < n; i++) {
            const o = i * 3;
            const dx = this.positions[o] - cx;
            const dy = this.positions[o + 1] - cy;
            const dz = this.positions[o + 2] - cz;
            const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
            maxRadius = Math.max(maxRadius, r);
            radiusSum += r;
        }

        const avgRadius = radiusSum / n || this.k * Math.cbrt(Math.max(n, 1));
        const reach = Math.max(maxRadius, avgRadius, this.k * Math.cbrt(Math.max(n, 1)) * 5.5);
        const duration = Math.min(170, Math.max(80, Math.sqrt(n) * 2.4));
        this.expansionPulse = {
            x: cx,
            y: cy,
            z: cz,
            age: 0,
            duration,
            speed: reach / (duration * 0.72),
            width: Math.max(this.k * 4, avgRadius * 0.16, 8),
            strength: Math.max(this.k * 0.16, 0.55) * strength
        };
        this.alpha = Math.max(this.alpha, 0.48);
    }

    _applyExpansionPulse(n) {
        const pulse = this.expansionPulse;
        if (!pulse) return;

        const { positions, forces, masses, alpha } = this;
        const progress = pulse.age / pulse.duration;
        const fade = Math.max(0, 1 - progress);
        const waveRadius = pulse.speed * pulse.age;
        const sigma = pulse.width;
        const sigmaSq2 = 2 * sigma * sigma;

        for (let i = 0; i < n; i++) {
            const o = i * 3;
            let dx = positions[o] - pulse.x;
            let dy = positions[o + 1] - pulse.y;
            let dz = positions[o + 2] - pulse.z;
            let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist < 0.001) {
                const a = i * 2.399963229728653;
                dx = Math.cos(a);
                dy = Math.sin(i * 1.171) * 0.45;
                dz = Math.sin(a);
                dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            }

            const waveOffset = dist - waveRadius;
            const influence = Math.exp(-(waveOffset * waveOffset) / sigmaSq2);
            if (influence < 0.02) continue;

            const invDist = 1 / dist;
            const rx = dx * invDist;
            const ry = dy * invDist;
            const rz = dz * invDist;
            const massDamping = 1 / Math.pow(Math.max(masses?.[i] || 1, 1), 0.22);
            const f = pulse.strength * influence * fade * alpha * massDamping;
            forces[o] += rx * f;
            forces[o + 1] += ry * f;
            forces[o + 2] += rz * f;

            const twist = f * 0.18 * Math.sin(i * 12.9898);
            forces[o] += -rz * twist;
            forces[o + 2] += rx * twist;
        }

        pulse.age++;
        if (pulse.age > pulse.duration) {
            this.expansionPulse = null;
        }
    }

    _cellKey(cx, cy, cz) {
        return cx + ',' + cy + ',' + cz;
    }

    _repulsePair(i, j) {
        const { positions, forces, masses, k, alpha, repulsionStrength, repulsionRadius } = this;
        const oi = i * 3;
        const oj = j * 3;
        let ddx = positions[oi] - positions[oj];
        let ddy = positions[oi + 1] - positions[oj + 1];
        let ddz = positions[oi + 2] - positions[oj + 2];
        let distSq = ddx * ddx + ddy * ddy + ddz * ddz;
        if (distSq < 0.01) distSq = 0.01;
        const dist = Math.sqrt(distSq);
        if (dist >= repulsionRadius) return;
        const charge = Math.pow(Math.max(masses?.[i] || 1, 1) * Math.max(masses?.[j] || 1, 1), 0.18);
        const softDist = Math.max(dist, k * 0.65);
        const taper = 1 - (dist / repulsionRadius);
        const f = ((k * k) / softDist) * repulsionStrength * charge * taper * taper * alpha;
        const fx = (ddx / dist) * f;
        const fy = (ddy / dist) * f;
        const fz = (ddz / dist) * f;
        forces[oi] += fx;
        forces[oi + 1] += fy;
        forces[oi + 2] += fz;
        forces[oj] -= fx;
        forces[oj + 1] -= fy;
        forces[oj + 2] -= fz;
    }

    _applyRepulsion(n) {
        const { positions, cellSize, repulsionRadius, _grid } = this;
        _grid.clear();
        for (let i = 0; i < n; i++) {
            const o = i * 3;
            const cx = Math.floor(positions[o] / cellSize);
            const cy = Math.floor(positions[o + 1] / cellSize);
            const cz = Math.floor(positions[o + 2] / cellSize);
            const key = this._cellKey(cx, cy, cz);
            let bucket = _grid.get(key);
            if (!bucket) {
                bucket = [];
                _grid.set(key, bucket);
            }
            bucket.push(i);
        }

        const range = Math.ceil(repulsionRadius / cellSize);
        for (let i = 0; i < n; i++) {
            const oi = i * 3;
            const xi = positions[oi];
            const yi = positions[oi + 1];
            const zi = positions[oi + 2];
            const cxi = Math.floor(xi / cellSize);
            const cyi = Math.floor(yi / cellSize);
            const czi = Math.floor(zi / cellSize);

            for (let dx = -range; dx <= range; dx++) {
                for (let dy = -range; dy <= range; dy++) {
                    for (let dz = -range; dz <= range; dz++) {
                        const bucket = _grid.get(this._cellKey(cxi + dx, cyi + dy, czi + dz));
                        if (!bucket) continue;
                        for (let b = 0; b < bucket.length; b++) {
                            const j = bucket[b];
                            if (j <= i) continue;
                            this._repulsePair(i, j);
                        }
                    }
                }
            }
        }
    }

    _applyLinks(n) {
        const { positions, forces, links, linkDistance, linkStrength, alpha, k, linkForceScale } = this;
        for (let t = 0; t < links.length; t++) {
            const { source, target, distance = linkDistance, strength = linkStrength, maxForceMultiplier = 1 } = links[t];
            if (source >= n || target >= n) continue;
            const os = source * 3;
            const ot = target * 3;
            let dx = positions[ot] - positions[os];
            let dy = positions[ot + 1] - positions[os + 1];
            let dz = positions[ot + 2] - positions[os + 2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
            const stretch = dist - distance;
            const maxForce = Math.max(k * 0.18, 0.8) * maxForceMultiplier * linkForceScale;
            const f = Math.max(-maxForce, Math.min(maxForce, stretch * strength * alpha));
            dx = (dx / dist) * f;
            dy = (dy / dist) * f;
            dz = (dz / dist) * f;
            forces[os] += dx;
            forces[os + 1] += dy;
            forces[os + 2] += dz;
            forces[ot] -= dx;
            forces[ot + 1] -= dy;
            forces[ot + 2] -= dz;
        }
    }

    _applyCenter(n) {
        const { positions, forces, masses, centerStrength, alpha } = this;
        if (!centerStrength) return;

        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let i = 0; i < n; i++) {
            const o = i * 3;
            cx += positions[o];
            cy += positions[o + 1];
            cz += positions[o + 2];
        }
        cx /= n;
        cy /= n;
        cz /= n;

        for (let i = 0; i < n; i++) {
            const o = i * 3;
            const mass = Math.max(masses?.[i] || 1, 0.25);
            forces[o] -= cx * centerStrength * alpha * mass;
            forces[o + 1] -= cy * centerStrength * alpha * mass;
            forces[o + 2] -= cz * centerStrength * alpha * mass;
        }
    }

    _applyClusterCohesion(n) {
        const { positions, forces, meshList, clusterStrength, alpha } = this;
        if (!clusterStrength) return;

        const clusters = new Map();
        for (let i = 0; i < n; i++) {
            const clusterIndex = meshList[i].userData.clusterIndex;
            if (clusterIndex === undefined) continue;

            let cluster = clusters.get(clusterIndex);
            if (!cluster) {
                cluster = { x: 0, y: 0, z: 0, count: 0 };
                clusters.set(clusterIndex, cluster);
            }

            const o = i * 3;
            cluster.x += positions[o];
            cluster.y += positions[o + 1];
            cluster.z += positions[o + 2];
            cluster.count++;
        }

        if (clusters.size === 0) return;
        clusters.forEach(cluster => {
            cluster.x /= cluster.count;
            cluster.y /= cluster.count;
            cluster.z /= cluster.count;
        });

        for (let i = 0; i < n; i++) {
            const clusterIndex = meshList[i].userData.clusterIndex;
            const cluster = clusters.get(clusterIndex);
            if (!cluster || cluster.count < 2) continue;

            const o = i * 3;
            forces[o] += (cluster.x - positions[o]) * clusterStrength * alpha;
            forces[o + 1] += (cluster.y - positions[o + 1]) * clusterStrength * alpha;
            forces[o + 2] += (cluster.z - positions[o + 2]) * clusterStrength * alpha;
        }
    }

    step() {
        if (this.alpha < this.alphaMin) return false;
        const n = this.meshList.length;
        if (n === 0) return false;

        const { positions, velocities, forces, meshList, masses, velocityDecay, maxVelocity, timeScale } = this;
        forces.fill(0);

        this._applyRepulsion(n);
        this._applyLinks(n);
        this._applyClusterCohesion(n);
        this._applyExpansionPulse(n);
        this._applyCenter(n);

        for (let i = 0; i < n; i++) {
            const o = i * 3;
            const invMass = 1 / Math.max(masses?.[i] || 1, 0.25);
            velocities[o] = (velocities[o] + forces[o] * invMass) * velocityDecay;
            velocities[o + 1] = (velocities[o + 1] + forces[o + 1] * invMass) * velocityDecay;
            velocities[o + 2] = (velocities[o + 2] + forces[o + 2] * invMass) * velocityDecay;
            let speed = Math.sqrt(velocities[o] ** 2 + velocities[o + 1] ** 2 + velocities[o + 2] ** 2);
            if (speed > maxVelocity) {
                const scale = maxVelocity / speed;
                velocities[o] *= scale;
                velocities[o + 1] *= scale;
                velocities[o + 2] *= scale;
            }
            positions[o] += velocities[o] * timeScale;
            positions[o + 1] += velocities[o + 1] * timeScale;
            positions[o + 2] += velocities[o + 2] * timeScale;

            const mesh = meshList[i];
            mesh.position.set(positions[o], positions[o + 1], positions[o + 2]);
            mesh.userData.velocity.set(velocities[o], velocities[o + 1], velocities[o + 2]);
        }

        updateEdgeLinePositions();
        this.alpha *= (1 - this.alphaDecay);
        return true;
    }
}

function getLayoutSpread(nodeCount, k) {
    if (k) return Math.min(420, k * Math.cbrt(Math.max(nodeCount, 1)) * 4.8);
    return Math.min(420, 30 + Math.sqrt(nodeCount) * 4.2);
}

function buildAdjacencyForMeshes(meshByName) {
    const adj = new Map();
    const link = (a, b) => {
        if (!meshByName.has(a) || !meshByName.has(b)) return;
        if (!adj.has(a)) adj.set(a, new Set());
        if (!adj.has(b)) adj.set(b, new Set());
        adj.get(a).add(b);
        adj.get(b).add(a);
    };
    edgeList.forEach(edge => {
        if (!edge.visible) return;
        link(edge.from, edge.to);
    });
    return adj;
}

/**
 * Раскладка кластерами: узел-семя + его ещё не размещённые соседи по рёбрам,
 * каждый кластер — отдельный «остров» в пространстве (спираль), внутри — компактно.
 */
function layoutClustersForForce(meshes) {
    if (meshes.length === 0) return;

    const meshByName = new Map(meshes.map(m => [m.userData.className, m]));
    const adj = buildAdjacencyForMeshes(meshByName);
    const placed = new Set();
    const baseDistance = forceSim?.linkDistance || 36;
    const clusterStep = forceSim?.k ? forceSim.k * 4.8 : 38;
    let clusterIndex = 0;

    const pickSeed = () => {
        let best = null;
        let bestScore = -1;
        for (const mesh of meshes) {
            const name = mesh.userData.className;
            if (placed.has(name)) continue;
            const score = (isExternalNode(mesh) ? 0 : 10000) + mesh.userData.depCount;
            if (score > bestScore) {
                bestScore = score;
                best = mesh;
            }
        }
        return best;
    };

    while (placed.size < meshes.length) {
        const seed = pickSeed();
        if (!seed) break;

        const seedName = seed.userData.className;
        const cluster = [seed];
        const neighbors = adj.get(seedName);
        if (neighbors) {
            neighbors.forEach(name => {
                if (!placed.has(name) && meshByName.has(name)) {
                    cluster.push(meshByName.get(name));
                }
            });
        }

        const t = clusterIndex * 2.399963229728653;
        const ringR = clusterStep * Math.sqrt(clusterIndex + 1);
        const cx = ringR * Math.cos(t);
        const cy = ((clusterIndex % 5) - 2) * clusterStep * 0.28;
        const cz = ringR * Math.sin(t);
        clusterIndex++;

        const seedDegree = seed.userData.depCount || cluster.length;
        const localR = baseDistance * 0.18 + Math.sqrt(cluster.length) * (forceSim?.k || 8) * 0.48 + Math.log1p(seedDegree) * baseDistance * 0.07;
        cluster.forEach((mesh, i) => {
            let ox = 0;
            let oy = 0;
            let oz = 0;
            if (mesh !== seed) {
                const a = (2 * Math.PI * i) / cluster.length;
                const radialJitter = 0.75 + Math.random() * 0.5;
                ox = localR * radialJitter * Math.cos(a);
                oy = (Math.random() - 0.5) * localR * 0.55;
                oz = localR * radialJitter * Math.sin(a);
            }
            mesh.position.set(cx + ox, cy + oy, cz + oz);
            mesh.userData.velocity.set(0, 0, 0);
            mesh.userData.clusterIndex = clusterIndex - 1;
            placed.add(mesh.userData.className);
        });
    }
}

function scatterNodesForForce(meshes) {
    if (meshes.length === 0) return;
    const hasVisibleEdges = edgeList.some(e => e.visible);
    if (hasVisibleEdges) {
        layoutClustersForForce(meshes);
        return;
    }
    const spread = getLayoutSpread(meshes.length, forceSim?.k);
    meshes.forEach(mesh => {
        mesh.position.set(
            (Math.random() - 0.5) * spread,
            (Math.random() - 0.5) * spread,
            (Math.random() - 0.5) * spread
        );
        mesh.userData.velocity.set(0, 0, 0);
    });
}

function isExternalNode(mesh) {
    return mesh.userData.classInfo?.type === 'external';
}

function getVisibleNodes() {
    return nodes.filter(n => n.visible);
}

function getForceSimulationNodes() {
    return getVisibleNodes().filter(n => {
        if (currentLayout !== 'force' || forcePhase === 'full') {
            return true;
        }
        return !n.userData.deferredExternal;
    });
}

function shouldRevealExternalNodes() {
    if (forcePhase !== 'internal' || !forceSim) return false;
    return internalSimFrames >= EXTERNAL_REVEAL_MIN_FRAMES
        && forceSim.alpha <= EXTERNAL_REVEAL_ALPHA;
}

function positionExternalNearNeighbors(mesh) {
    const neighbors = [];
    edgeList.forEach(edge => {
        const name = mesh.userData.className;
        let other = null;
        if (edge.from === name) other = nodeMeshes.get(edge.to);
        if (edge.to === name) other = nodeMeshes.get(edge.from);
        if (other && other.visible && !other.userData.deferredExternal) {
            neighbors.push(other);
        }
    });
    if (neighbors.length === 0) return;
    const center = new THREE.Vector3();
    neighbors.forEach(n => center.add(n.position));
    center.divideScalar(neighbors.length);
    mesh.position.copy(center).add(new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2
    ));
}

function revealExternalNodes() {
    forcePhase = 'full';
    nodes.forEach(mesh => {
        if (!mesh.userData.deferredExternal) return;
        mesh.userData.deferredExternal = false;
        positionExternalNearNeighbors(mesh);
    });
    applyNodeAndEdgeFilters();
    rebuildEdgeLines();
    rebuildForceSim();
    refreshDragControls();
    if (forceSim) {
        forceSim.resetAlpha();
        forceSim.alpha = 0.5;
        forceSim.startExpansionPulse(0.65);
    }
    document.getElementById('visibleNodeCount').textContent = getVisibleNodes().length;
}

function beginForceLayout() {
    forcePhase = 'internal';
    internalSimFrames = 0;
    nodes.forEach(mesh => {
        if (mesh.userData.classInfo?.type === 'external') {
            mesh.userData.deferredExternal = true;
        }
    });
    applyNodeAndEdgeFilters();
    refreshDragControls();
    const simNodes = getForceSimulationNodes();
    scatterNodesForForce(simNodes);
    rebuildEdgeLines();
    fitCameraToVisibleNodes();
    rebuildForceSim();
    if (forceSim) {
        forceSim.resetAlpha();
        for (let i = 0; i < simNodes.length; i++) {
            const idx = forceSim.meshToIndex.get(simNodes[i]);
            if (idx === undefined) continue;
            const o = idx * 3;
            forceSim.velocities[o] = (Math.random() - 0.5) * 2;
            forceSim.velocities[o + 1] = (Math.random() - 0.5) * 2;
            forceSim.velocities[o + 2] = (Math.random() - 0.5) * 2;
        }
        forceSim.startExpansionPulse(0.85);
    }
    document.getElementById('visibleNodeCount').textContent = getVisibleNodes().length;
}

function endForceLayoutDeferral() {
    forcePhase = 'full';
    nodes.forEach(mesh => {
        if (mesh.userData.classInfo?.type === 'external') {
            mesh.userData.deferredExternal = false;
        }
    });
}

function fitCameraToVisibleNodes() {
    const visible = getVisibleNodes();
    if (visible.length === 0) return;

    const box = new THREE.Box3();
    visible.forEach(mesh => box.expandByPoint(mesh.position));
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const radius = Math.max(size.length() * 0.5, 20);
    const distanceScale = currentLayout === 'force' ? 0.45 : 0.9;
    const minDistance = currentLayout === 'force' ? 24 : 45;
    const distance = Math.max(minDistance, radius / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * distanceScale);
    const direction = new THREE.Vector3(0.85, 0.55, 0.85).normalize();
    camera.position.copy(center).add(direction.multiplyScalar(distance));
    controls.target.copy(center);
    updateFogForView(distance, radius);
    controls.update();
}

function updateFogForView(distance, radius) {
    if (!scene.fog) return;
    scene.fog.near = Math.max(200, distance + radius * 1.5);
    scene.fog.far = Math.max(1000, distance + radius * 8);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function calculateVisibleDegrees() {
    nodes.forEach(mesh => {
        mesh.userData.visibleDegree = 0;
        mesh.userData.visibleOutDegree = 0;
        mesh.userData.visibleInDegree = 0;
    });
    edgeList.forEach(edge => {
        if (!edge.visible) return;
        const fromMesh = nodeMeshes.get(edge.from);
        const toMesh = nodeMeshes.get(edge.to);
        if (fromMesh?.visible) {
            fromMesh.userData.visibleDegree++;
            fromMesh.userData.visibleOutDegree++;
        }
        if (toMesh?.visible) {
            toMesh.userData.visibleDegree++;
            toMesh.userData.visibleInDegree++;
        }
    });
}

function isTerminalLink(edge, fromMesh, toMesh) {
    return isSingleLeafEndpoint(fromMesh) || isSingleLeafEndpoint(toMesh);
}

function isSingleLeafEndpoint(mesh) {
    const visibleDegree = mesh.userData.visibleDegree || 0;
    return visibleDegree === 1;
}

function isLowBranchLink(fromMesh, toMesh) {
    const fromDegree = fromMesh.userData.visibleDegree || 0;
    const toDegree = toMesh.userData.visibleDegree || 0;
    return Math.min(fromDegree, toDegree) <= 2;
}

function calculateNodeMass(mesh) {
    const visibleDegree = mesh.userData.visibleDegree || 0;
    const totalDegree = mesh.userData.depCount || 0;
    const externalFactor = isExternalNode(mesh) ? 0.75 : 1;
    return externalFactor * (1 + Math.log1p(totalDegree) * 0.5 + Math.sqrt(visibleDegree) * 0.45);
}

function calculateLinkDistance(edge, fromMesh, toMesh, baseDistance) {
    const types = edge.dependency.types || [];
    const restDistanceScale = 0.2;
    let typeFactor = 1.12;
    if (types.includes('extends')) typeFactor = 0.78;
    else if (types.includes('implements')) typeFactor = 0.9;

    if (isTerminalLink(edge, fromMesh, toMesh)) {
        return isExternalNode(fromMesh) || isExternalNode(toMesh) ? 0.8 : 0.6;
    }

    const fromDegree = fromMesh.userData.visibleDegree || 0;
    const toDegree = toMesh.userData.visibleDegree || 0;
    if (isLowBranchLink(fromMesh, toMesh)) {
        const lowDegreeFactor = isExternalNode(fromMesh) || isExternalNode(toMesh) ? 0.72 : 0.82;
        return clamp(baseDistance * typeFactor * lowDegreeFactor * restDistanceScale, baseDistance * 0.09, baseDistance * 1.05);
    }

    const maxDegree = Math.max(fromDegree, toDegree);
    const minDegree = Math.min(fromDegree, toDegree);
    const hubStretch = Math.min(Math.sqrt(Math.min(maxDegree, minDegree * 4)) * baseDistance * 0.16, baseDistance * 1.35);
    const externalStretch = (isExternalNode(fromMesh) || isExternalNode(toMesh)) ? baseDistance * 0.16 : 0;
    const baseRestDistance = baseDistance * typeFactor * restDistanceScale;

    return clamp(baseRestDistance + hubStretch + externalStretch, baseDistance * 0.136, baseDistance * 2.75);
}

function calculateLinkStrength(edge, fromMesh, toMesh, baseStrength) {
    const types = edge.dependency.types || [];
    let strength = baseStrength;
    if (types.includes('extends')) strength *= 1.35;
    else if (types.includes('implements')) strength *= 1.18;
    else strength *= 0.72;

    if (isTerminalLink(edge, fromMesh, toMesh)) {
        return strength * 1.35;
    }

    if (isLowBranchLink(fromMesh, toMesh)) {
        return strength * 1.05;
    }

    const degreeLoad = (fromMesh.userData.visibleDegree || 0) + (toMesh.userData.visibleDegree || 0);
    return (strength * 1.1) / (1 + Math.sqrt(degreeLoad) * 0.025);
}

function calculateLinkMaxForceMultiplier(edge, fromMesh, toMesh) {
    if (isTerminalLink(edge, fromMesh, toMesh)) return 0.85;
    if (isLowBranchLink(fromMesh, toMesh)) return 1.2;
    return 1.15;
}

function rebuildForceSim() {
    const visible = getForceSimulationNodes();
    if (!forceSim) forceSim = new ForceSimulator();
    forceSim.syncFromMeshes(visible);
    calculateVisibleDegrees();
    const masses = new Float32Array(visible.length);
    visible.forEach((mesh, i) => {
        masses[i] = calculateNodeMass(mesh);
    });
    forceSim.setMasses(masses);

    const links = [];
    edgeList.forEach(edge => {
        if (!edge.visible) return;
        const fromMesh = nodeMeshes.get(edge.from);
        const toMesh = nodeMeshes.get(edge.to);
        if (!fromMesh?.visible || !toMesh?.visible) return;
        const source = forceSim.meshToIndex.get(fromMesh);
        const target = forceSim.meshToIndex.get(toMesh);
        if (source !== undefined && target !== undefined) {
            links.push({
                source,
                target,
                distance: calculateLinkDistance(edge, fromMesh, toMesh, forceSim.linkDistance),
                strength: calculateLinkStrength(edge, fromMesh, toMesh, forceSim.linkStrength),
                maxForceMultiplier: calculateLinkMaxForceMultiplier(edge, fromMesh, toMesh)
            });
        }
    });
    forceSim.setLinks(links);
}

// --- Инициализация Three.js ---
function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);
    scene.fog = new THREE.Fog(0x0a0a0a, 200, 1000);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000000);
    camera.position.set(30, 20, 40);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.getElementById('container').appendChild(renderer.domElement);

    labelRenderer = new THREE.CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0px';
    labelRenderer.domElement.style.pointerEvents = 'none';
    document.getElementById('container').appendChild(labelRenderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.addEventListener('end', () => {
        if (pointerMovedSinceDown) suppressNextClick = true;
    });

    const ambientLight = new THREE.AmbientLight(0x404060, 0.5);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown);
    renderer.domElement.addEventListener('pointermove', onCanvasPointerMove);
    renderer.domElement.addEventListener('pointerup', onCanvasPointerUp);
    renderer.domElement.addEventListener('pointerleave', onCanvasPointerUp);
    window.addEventListener('keydown', (e) => {
        if (e.key in keyState) {
            keyState[e.key] = true;
            e.preventDefault();
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.key in keyState) {
            keyState[e.key] = false;
            e.preventDefault();
        }
    });

    animate();
}

function bindUiEvents() {
    document.getElementById('fileInput').addEventListener('change', handleFileSelect);
    document.getElementById('classSearch').addEventListener('keyup', searchClass);
    document.getElementById('nodeScale').addEventListener('change', updateNodeScale);
    document.getElementById('nodeColorMode').addEventListener('change', updateNodeColors);
    document.getElementById('edgeOpacity').addEventListener('change', updateEdgeOpacity);
    document.getElementById('forceStrength').addEventListener('input', () => updateForceSettings(false));
    document.getElementById('forceStrength').addEventListener('change', () => updateForceSettings(true));
    document.getElementById('simulationSpeed').addEventListener('input', () => updateForceSettings(false));
    document.getElementById('simulationSpeed').addEventListener('change', () => updateForceSettings(true));
    document.getElementById('layoutType').addEventListener('change', changeLayout);
    document.getElementById('showEdges').addEventListener('change', toggleEdges);
    document.getElementById('maxDeps').addEventListener('change', filterByDependencies);
    document.getElementById('applyFiltersBtn').addEventListener('click', applyFilters);
    document.getElementById('resetViewBtn').addEventListener('click', resetView);
    document.getElementById('expandGraphBtn').addEventListener('click', expandGraphPulse);
    document.getElementById('clearGraphBtn').addEventListener('click', clearGraph);
    document.getElementById('stopForceBtn').addEventListener('click', stopForce);
}

function animate() {
    animationId = requestAnimationFrame(animate);
    if (currentLayout === 'force' && forceSim) {
        const n = forceSim.meshList.length;
        const substeps = n > 1500 ? 1 : (n > 500 ? 2 : 3);
        for (let s = 0; s < substeps; s++) {
            if (forcePhase === 'internal') {
                internalSimFrames++;
                forceSim.step();
            } else {
                forceSim.step();
            }
        }
        if (forcePhase === 'internal' && shouldRevealExternalNodes()) {
            revealExternalNodes();
        }
    }

    labelVisibilityFrame++;
    if (currentLayout !== 'force' || labelVisibilityFrame % 8 === 0) {
        updateLabelVisibility();
    }

    if (keyState.ArrowLeft || keyState.ArrowRight || keyState.ArrowUp || keyState.ArrowDown) {
        const moveDir = new THREE.Vector3();
        // Направление взгляда камеры
        const cameraDir = new THREE.Vector3();
        camera.getWorldDirection(cameraDir);
        // Боковое направление (перпендикулярно взгляду и вертикали)
        const right = new THREE.Vector3();
        right.crossVectors(camera.up, cameraDir).normalize();

        if (keyState.ArrowLeft) moveDir.add(right);
        if (keyState.ArrowRight) moveDir.sub(right);
        if (keyState.ArrowUp) moveDir.add(cameraDir);
        if (keyState.ArrowDown) moveDir.sub(cameraDir);

        moveDir.normalize().multiplyScalar(panSpeed);
        // Смещаем и камеру, и цель OrbitControls
        camera.position.add(moveDir);
        controls.target.add(moveDir);
    }

    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
}

// --- Загрузка данных и создание графа ---
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    document.getElementById('loading').style.display = 'block';
    const reader = new FileReader();
    reader.onload = e => {
        try {
            graphData = JSON.parse(e.target.result);
            visualizeGraph(graphData);
            document.getElementById('loading').style.display = 'none';
        } catch (ex) { alert('Invalid JSON'); document.getElementById('loading').style.display = 'none'; }
    };
    reader.readAsText(file);
}

function stopForce() {
    if (currentLayout === 'force') {
        if (forcePhase === 'internal') {
            revealExternalNodes();
        }
        currentLayout = 'free';
        document.getElementById('layoutType').value = 'free';
        endForceLayoutDeferral();
        applyFilters();
        rebuildEdgeLines();
        nodes.forEach(n => n.userData.velocity.set(0, 0, 0));
    }
}

function getNodeMaterial(color, emissiveColor = color, emissiveIntensity = 0.18) {
    const key = `${color}:${emissiveColor}:${emissiveIntensity}`;
    let material = nodeMaterialCache.get(key);
    if (!material) {
        material = new THREE.MeshLambertMaterial({
            color,
            emissive: emissiveColor,
            emissiveIntensity
        });
        nodeMaterialCache.set(key, material);
    }
    return material;
}

function setNodeNormalMaterial(mesh) {
    mesh.material = mesh.userData.baseMaterial || getNodeMaterial(mesh.userData.originalColor);
}

function setNodeEmphasis(mesh, emissiveColor, emissiveIntensity) {
    mesh.material = getNodeMaterial(mesh.userData.originalColor, emissiveColor, emissiveIntensity);
}

function disposeNodeMaterials() {
    nodeMaterialCache.forEach(material => material.dispose());
    nodeMaterialCache.clear();
}

function getDegreeColor(depCnt) {
    const count = Math.max(depCnt || 0, 0);
    const key = `${count}:${maxNodeDepCount}`;
    let color = degreeColorCache.get(key);
    if (color !== undefined) return color;

    const ratio = maxNodeDepCount > 0
        ? clamp(Math.log1p(count) / Math.log1p(maxNodeDepCount), 0, 1)
        : 0;
    const hue = (1 - ratio) * 0.33;
    color = new THREE.Color().setHSL(hue, 0.82, 0.46).getHex();
    degreeColorCache.set(key, color);
    return color;
}

function getNodeColor(info, depCnt) {
    if (nodeColorMode === 'type') {
        return getClassColor(info.type);
    }
    return getDegreeColor(depCnt);
}

function updateColorLegend() {
    const degreeLegend = document.getElementById('degreeColorLegend');
    const typeLegend = document.getElementById('typeColorLegend');
    if (!degreeLegend || !typeLegend) return;
    degreeLegend.classList.toggle('is-hidden', nodeColorMode !== 'degree');
    typeLegend.classList.toggle('is-hidden', nodeColorMode !== 'type');
}

function updateNodeColors() {
    nodeColorMode = document.getElementById('nodeColorMode').value;
    updateColorLegend();
    const previousCache = nodeMaterialCache;
    nodeMaterialCache = new Map();

    nodes.forEach(mesh => {
        const color = getNodeColor(mesh.userData.classInfo, mesh.userData.depCount);
        mesh.userData.originalColor = color;
        mesh.userData.baseMaterial = getNodeMaterial(color);
        mesh.material = mesh.userData.baseMaterial;
    });

    if (selectedNode?.visible) {
        setNodeEmphasis(selectedNode, 0xffffff, 0.8);
    }
    highlightedNodes.forEach(mesh => {
        if (mesh.visible) setNodeEmphasis(mesh, 0xffaa00, 0.7);
    });

    previousCache.forEach(material => material.dispose());
}

function visualizeGraph(data) {
    clearGraph();
    if (!data || !data.classes || !data.dependencies) return;

    const classes = data.classes;
    const deps = data.dependencies;
    const classArray = Object.values(classes);
    const depArray = Object.values(deps);

    const depCount = new Map();
    depArray.forEach(d => {
        depCount.set(d.from, (depCount.get(d.from) || 0) + 1);
        depCount.set(d.to, (depCount.get(d.to) || 0) + 1);
    });

    let maxDeps = 0;
    depCount.forEach(v => { if (v > maxDeps) maxDeps = v; });
    maxNodeDepCount = Math.max(maxDeps, 1);
    degreeColorCache.clear();
    nodeColorMode = document.getElementById('nodeColorMode')?.value || 'degree';
    document.getElementById('maxDeps').max = Math.max(maxDeps, 200);
    document.getElementById('maxDeps').value = Math.max(maxDeps, 200);
    currentMaxDeps = Math.max(maxDeps, 200);

    // 1. Создаём узлы
    classArray.forEach(info => {
        const cnt = depCount.get(info.name) || 0;
        createNode(info, cnt);
    });

    // 2. Сразу задаём случайные позиции
    applyInitialPositions();

    // 3. Рёбра (батч LineSegments)
    depArray.forEach(dep => {
        if (nodeMeshes.has(dep.from) && nodeMeshes.has(dep.to)) {
            createEdge(dep);
        }
    });
    rebuildEdgeLines();

    // Drag controls
    refreshDragControls();

    // Статистика
    document.getElementById('nodeCount').textContent = classArray.length;
    document.getElementById('edgeCount').textContent = depArray.length;
    document.getElementById('visibleNodeCount').textContent = classArray.length;
    const nss = new Set(classArray.map(c => c.namespace).filter(Boolean));
    document.getElementById('nsCount').textContent = nss.size;

    // Force mode is the most useful default for large dependency graphs.
    document.getElementById('layoutType').value = 'force';
    currentLayout = 'force';
    beginForceLayout();
}

function createNode(info, depCnt) {
    const color = getNodeColor(info, depCnt);
    const size = calculateNodeSize(info, depCnt);

    const geo = new THREE.SphereGeometry(size, 8, 8);
    const mat = getNodeMaterial(color);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = {
        className: info.name,
        classInfo: info,
        depCount: depCnt,
        originalColor: color,
        baseMaterial: mat,
        velocity: new THREE.Vector3(),
        deferredExternal: info.type === 'external'
    };
    scene.add(mesh);
    nodeMeshes.set(info.name, mesh);
    nodes.push(mesh);

    if (size > 0.5 && info.type !== 'external') {
        // Лейбл
        const div = document.createElement('div');
        div.textContent = info.shortName;
        const fontSize = Math.min(size * 6, 14);
        div.style.cssText = `
        color: #fff;
        font-size: ${fontSize}px;
        font-weight: bold;
        text-shadow: 1px 1px 2px black;
        background: rgba(0,0,0,0.7);
        padding: 4px 8px;
        border-radius: 4px;
        white-space: nowrap;
    `;
        const label = new THREE.CSS2DObject(div);
        label.position.y += size + 0.8;
        mesh.add(label);
        mesh.userData.label = label;   // сохраняем для управления видимостью
    }
}

function calculateNodeSize(info, depCnt) {
    if (info.type === 'external') {
        return 0.8 * nodeScale;
    }
    const baseSize = depCnt === 0 ? 0.3 : 0.3 + Math.log(depCnt + 1) * 1.5;
    return Math.min(baseSize, 3) * nodeScale;
}

// Управление видимостью подписей по расстоянию
function updateLabelVisibility() {
    const maxDist = 150;   // дальше этого расстояния подписи скрываются
    nodes.forEach(node => {
        if (!node.visible || !node.userData.label) return;
        const dist = camera.position.distanceTo(node.position);
        node.userData.label.visible = dist < maxDist;
    });
}

function createEdge(dep) {
    const idx = edgeList.length;
    edgeList.push({
        from: dep.from,
        to: dep.to,
        dependency: dep,
        visible: true,
        lineIndex: idx
    });
    edgeMeshes.set(dep.from + '->' + dep.to, idx);
}

function rebuildEdgeLines() {
    if (edgeLines) {
        scene.remove(edgeLines);
        edgeLineGeometry?.dispose();
        edgeLines.material?.dispose();
        edgeLines = null;
        edgeLineGeometry = null;
    }
    edges = [];

    activeEdges = edgeList.filter(e => e.visible);
    if (activeEdges.length === 0) return;

    const positions = new Float32Array(activeEdges.length * 6);
    const colors = new Float32Array(activeEdges.length * 6);
    activeEdges.forEach((edge, i) => {
        edge.lineIndex = i;
        const from = nodeMeshes.get(edge.from);
        const to = nodeMeshes.get(edge.to);
        const o = i * 6;
        if (from && to) {
            positions[o] = from.position.x;
            positions[o + 1] = from.position.y;
            positions[o + 2] = from.position.z;
            positions[o + 3] = to.position.x;
            positions[o + 4] = to.position.y;
            positions[o + 5] = to.position.z;
        }
        const c = new THREE.Color(getEdgeColor(edge.dependency.types));
        colors[o] = colors[o + 3] = c.r;
        colors[o + 1] = colors[o + 4] = c.g;
        colors[o + 2] = colors[o + 5] = c.b;
    });

    edgeLineGeometry = new THREE.BufferGeometry();
    edgeLineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    edgeLineGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: edgeOpacity,
        depthWrite: false
    });
    edgeLines = new THREE.LineSegments(edgeLineGeometry, material);
    scene.add(edgeLines);
    edges.push(edgeLines);
}

function updateEdgeLinePositions() {
    if (!edgeLineGeometry) return;
    const posAttr = edgeLineGeometry.attributes.position;
    const arr = posAttr.array;
    for (let i = 0; i < activeEdges.length; i++) {
        const edge = activeEdges[i];
        const from = nodeMeshes.get(edge.from);
        const to = nodeMeshes.get(edge.to);
        if (!from || !to) continue;
        const o = i * 6;
        arr[o] = from.position.x;
        arr[o + 1] = from.position.y;
        arr[o + 2] = from.position.z;
        arr[o + 3] = to.position.x;
        arr[o + 4] = to.position.y;
        arr[o + 5] = to.position.z;
    }
    posAttr.needsUpdate = true;
}

function applyInitialPositions() {
    scatterNodesForForce(nodes);
    updateEdgeLinePositions();
}

function updateAllEdges() {
    updateEdgeLinePositions();
}

// --- Статические раскладки ---
function changeLayout() {
    currentLayout = document.getElementById('layoutType').value;
    if (currentLayout === 'force') {
        beginForceLayout();
    } else {
        endForceLayoutDeferral();
        const visCnt = applyNodeAndEdgeFilters();
        rebuildEdgeLines();
        refreshDragControls();
        if (selectedNode && !selectedNode.visible) {
            clearSelection();
        }
        document.getElementById('visibleNodeCount').textContent = visCnt;
        if (currentLayout !== 'free') {
            applyStaticLayout(currentLayout);
        }
    }
}

function applyStaticLayout(layout) {
    const visible = nodes.filter(n => n.visible);
    if (visible.length === 0) {
        updateAllEdges();
        return;
    }
    if (layout === 'sphere') {
        const r = 20;
        visible.forEach((n, i) => {
            const phi = Math.acos(-1 + (2 * i) / visible.length);
            const theta = Math.sqrt(visible.length * Math.PI) * phi;
            n.position.set(r * Math.cos(theta) * Math.sin(phi), r * Math.sin(theta) * Math.sin(phi), r * Math.cos(phi));
        });
    } else if (layout === 'grid') {
        const side = Math.ceil(Math.sqrt(visible.length));
        const sp = 3;
        visible.forEach((n, i) => {
            n.position.set((i % side - side / 2) * sp, 0, (Math.floor(i / side) - side / 2) * sp);
        });
    } else if (layout === 'radial') {
        const sorted = [...visible].sort((a, b) => b.userData.depCount - a.userData.depCount);
        const hubCnt = Math.min(5, Math.max(1, Math.floor(visible.length * 0.1)));
        sorted.slice(0, hubCnt).forEach((n, i) => {
            const ang = (i / hubCnt) * Math.PI * 2;
            n.position.set(Math.cos(ang) * 2, 0, Math.sin(ang) * 2);
        });
        const others = sorted.slice(hubCnt);
        others.forEach((n, i) => {
            const denom = Math.max(others.length, 1);
            const ang = (i / denom) * Math.PI * 2;
            const r = 5 + (i / denom) * 15;
            n.position.set(Math.cos(ang) * r, (Math.random() - 0.5) * 5, Math.sin(ang) * r);
        });
    }
    nodes.forEach(n => n.userData.velocity.set(0, 0, 0));
    updateAllEdges();
    fitCameraToVisibleNodes();
}

// --- Перетаскивание ---
function onDragStart(event) {
    isDraggingNode = true;
    nodeDragMoved = false;
    nodeDragStartPosition = event.object.position.clone();
    controls.enabled = false;
    setNodeEmphasis(event.object, 0xffffff, 0.8);
}
function onDrag(event) {
    if (nodeDragStartPosition && event.object.position.distanceToSquared(nodeDragStartPosition) > 0.01) {
        nodeDragMoved = true;
    }
    updateEdgeLinePositions();
    if (forceSim && currentLayout === 'force') {
        const idx = forceSim.meshToIndex.get(event.object);
        if (idx !== undefined) {
            const o = idx * 3;
            forceSim.positions[o] = event.object.position.x;
            forceSim.positions[o + 1] = event.object.position.y;
            forceSim.positions[o + 2] = event.object.position.z;
            forceSim.velocities[o] = 0;
            forceSim.velocities[o + 1] = 0;
            forceSim.velocities[o + 2] = 0;
        }
    }
}
function onDragEnd(event) {
    isDraggingNode = false;
    suppressNextClick = nodeDragMoved || pointerMovedSinceDown;
    nodeDragMoved = false;
    nodeDragStartPosition = null;
    controls.enabled = true;
    setNodeNormalMaterial(event.object);
}
function updateEdgesForNode(node) {
    updateEdgeLinePositions();
}

function refreshDragControls() {
    if (dragControls) {
        dragControls.dispose();
        dragControls = null;
    }
    const draggableNodes = nodes.filter(n => n.visible);
    if (draggableNodes.length === 0) return;
    dragControls = new THREE.DragControls(draggableNodes, camera, renderer.domElement);
    dragControls.addEventListener('dragstart', onDragStart);
    dragControls.addEventListener('drag', onDrag);
    dragControls.addEventListener('dragend', onDragEnd);
}

function onCanvasPointerDown(event) {
    pointerDownPos = { x: event.clientX, y: event.clientY };
    pointerMovedSinceDown = false;
}

function onCanvasPointerMove(event) {
    if (!pointerDownPos) return;
    const dx = event.clientX - pointerDownPos.x;
    const dy = event.clientY - pointerDownPos.y;
    if (Math.sqrt(dx * dx + dy * dy) > CLICK_MOVE_THRESHOLD) {
        pointerMovedSinceDown = true;
    }
}

function onCanvasPointerUp(event) {
    if (pointerDownPos) {
        const dx = event.clientX - pointerDownPos.x;
        const dy = event.clientY - pointerDownPos.y;
        if (Math.sqrt(dx * dx + dy * dy) > CLICK_MOVE_THRESHOLD) {
            pointerMovedSinceDown = true;
            suppressNextClick = true;
        }
    }
    pointerDownPos = null;
}

function clearSelection(updateInfo = true) {
    if (selectedNode) {
        setNodeNormalMaterial(selectedNode);
        selectedNode = null;
    }
    highlightedNodes.forEach(n => {
        setNodeNormalMaterial(n);
    });
    highlightedNodes = [];
    if (updateInfo) {
        document.getElementById('nodeInfo').innerHTML = 'Click on a node for details';
    }
}

// --- Выделение узла кликом ---
function onMouseClick(event) {
    if (suppressNextClick || pointerMovedSinceDown || isDraggingNode) {
        suppressNextClick = false;
        pointerMovedSinceDown = false;
        return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const visNodes = nodes.filter(n => n.visible);
    const intersects = raycaster.intersectObjects(visNodes);
    if (intersects.length > 0) {
        focusOnClass(intersects[0].object.userData.className);
    } else {
        clearSelection();
    }
}

function focusOnClass(className) {
    const mesh = nodeMeshes.get(className);
    if (!mesh || !mesh.visible) return;

    // Снять предыдущую подсветку
    clearSelection(false);

    // Подсветить выбранный
    setNodeEmphasis(mesh, 0xffffff, 0.8);
    selectedNode = mesh;

    // Найти соседей (1 уровень)
    const neighbors = new Set();
    edgeList.forEach(edge => {
        if (!edge.visible) return;
        if (edge.from === className) {
            const toMesh = nodeMeshes.get(edge.to);
            if (toMesh && toMesh.visible) neighbors.add(toMesh);
        }
        if (edge.to === className) {
            const fromMesh = nodeMeshes.get(edge.from);
            if (fromMesh && fromMesh.visible) neighbors.add(fromMesh);
        }
    });

    // Подсветить соседей
    neighbors.forEach(n => {
        setNodeEmphasis(n, 0xffaa00, 0.7);
        highlightedNodes.push(n);
    });

    // Информация об узле
    const info = mesh.userData;
    const depList = Array.from(neighbors).map(n => n.userData.className).sort();

    // Строим кликабельный список
    const connectionsHtml = depList.length
        ? depList.map(name =>
            `<div class="conn-link" style="cursor:pointer; color:#64ffda; text-decoration:underline;margin-top: 5px"
          data-class="${name.replace(/"/g, '&quot;')}">${name}</div>`
        ).join('')
        : 'No visible connections';

    document.getElementById('nodeInfo').innerHTML = `
<strong style="color:#64ffda">${info.className}</strong><br>
Type: <span style="color:#ffd700">${info.classInfo.type}</span><br>
Namespace: <span style="color:#64b5f6">${info.classInfo.namespace || 'global'}</span><br>
Connections: <span style="color:#ff9800">${info.depCount}</span><br>
File: <span style="color:#81c784;font-size:11px">${info.classInfo.file}</span><br>
Complexity: <span style="color:#ff9800">${info.classInfo.complexity}</span><br>
Size: <span style="color:#ce93d8">${Math.round(info.classInfo.size / 1024)} KB</span>

<details style="margin-top: 8px;word-wrap: break-word;">
    <summary style="cursor:pointer; color:#64ffda;">Show connections (${neighbors.size})</summary>
    <div style="max-height: 150px; overflow-y: auto; font-size: 15px; margin-top: 15px;" id="connList">
        ${connectionsHtml}
    </div>
</details>
    `;

    // Навешиваем обработчики на ссылки
    document.querySelectorAll('.conn-link').forEach(el => {
        el.addEventListener('click', (e) => {
            const targetClass = e.target.dataset.class;
            if (targetClass) focusOnClass(targetClass);
        });
    });

    // Анимация камеры к узлу
    const targetPos = mesh.position.clone();
    const offset = new THREE.Vector3(8, 5, 8);
    const newCamPos = targetPos.clone().add(offset);
    const startPos = camera.position.clone();
    const startTarget = controls.target.clone();
    const duration = 1000;
    const startTime = Date.now();

    function animateCamera() {
        const elapsed = Date.now() - startTime;
        const t = Math.min(elapsed / duration, 1.0);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        camera.position.lerpVectors(startPos, newCamPos, ease);
        controls.target.lerpVectors(startTarget, targetPos, ease);
        controls.update();
        if (t < 1.0) requestAnimationFrame(animateCamera);
    }
    animateCamera();
}

// --- Фильтры и UI ---
function applyNodeAndEdgeFilters() {
    const edgeType = document.getElementById('showEdges').value;
    const search = document.getElementById('classSearch').value.toLowerCase();
    let visCnt = 0;
    const regex = new RegExp(search, 'gi');

    nodeMeshes.forEach((mesh, className) => {
        const matchSearch = !search
            || regex.test(className)
            || regex.test((mesh.userData.classInfo.shortName || ''));

        const matchDeps = mesh.userData.depCount <= currentMaxDeps;
        let visible = matchSearch && matchDeps;
        if (visible && mesh.userData.deferredExternal && currentLayout === 'force' && forcePhase === 'internal') {
            visible = false;
        }
        mesh.visible = visible;
        if (!visible && mesh.userData.label) {
            mesh.userData.label.visible = false;
        }
        if (mesh.visible) visCnt++;
    });
    edgeList.forEach(edge => {
        const from = nodeMeshes.get(edge.from);
        const to = nodeMeshes.get(edge.to);
        edge.visible = from && to && from.visible && to.visible &&
            (edgeType === 'all' || edge.dependency.types.includes(edgeType));
    });
    return visCnt;
}

function applyFilters() {
    const prevVisibleCount = getVisibleNodes().length;
    let visCnt = applyNodeAndEdgeFilters();

    if (currentLayout === 'force' && forcePhase === 'full' &&
        visCnt > 1800 && visCnt > Math.max(prevVisibleCount * 1.35, prevVisibleCount + 300)) {
        forcePhase = 'internal';
        internalSimFrames = 0;
        nodes.forEach(mesh => {
            mesh.userData.deferredExternal = mesh.userData.classInfo?.type === 'external';
        });
        visCnt = applyNodeAndEdgeFilters();
    }

    rebuildEdgeLines();
    refreshDragControls();
    if (selectedNode && !selectedNode.visible) {
        clearSelection();
    }
    document.getElementById('visibleNodeCount').textContent = visCnt;
    if (currentLayout === 'force') {
        rebuildForceSim();
        if (forceSim) {
            forceSim.alpha = Math.max(forceSim.alpha, forcePhase === 'internal' ? 0.6 : 0.25);
        }
    } else if (currentLayout !== 'free') {
        changeLayout();
    }
}

function filterByDependencies() {
    currentMaxDeps = parseInt(document.getElementById('maxDeps').value);
    applyFilters();
}
function updateNodeScale() {
    nodeScale = parseFloat(document.getElementById('nodeScale').value);
    nodeMeshes.forEach(mesh => {
        const size = calculateNodeSize(mesh.userData.classInfo, mesh.userData.depCount);
        mesh.geometry.dispose();
        mesh.geometry = new THREE.SphereGeometry(size, 8, 8);
    });
}
function updateEdgeOpacity() {
    edgeOpacity = parseFloat(document.getElementById('edgeOpacity').value);
    if (edgeLines) edgeLines.material.opacity = edgeOpacity;
}
function updateForceSettings(rebuild = true) {
    forceStrengthScale = parseFloat(document.getElementById('forceStrength').value);
    simulationSpeed = parseFloat(document.getElementById('simulationSpeed').value);
    document.getElementById('forceStrengthValue').textContent = forceStrengthScale.toFixed(1) + 'x';
    document.getElementById('simulationSpeedValue').textContent = simulationSpeed.toFixed(1) + 'x';

    if (rebuild && currentLayout === 'force' && forceSim) {
        rebuildForceSim();
        forceSim.alpha = Math.max(forceSim.alpha, 0.35);
    }
}

function resumeForceFromCurrentPositions() {
    currentLayout = 'force';
    document.getElementById('layoutType').value = 'force';
    endForceLayoutDeferral();
    internalSimFrames = 0;

    const visCnt = applyNodeAndEdgeFilters();
    rebuildEdgeLines();
    refreshDragControls();
    if (selectedNode && !selectedNode.visible) {
        clearSelection();
    }
    document.getElementById('visibleNodeCount').textContent = visCnt;
    rebuildForceSim();
    if (forceSim?.velocities) {
        forceSim.velocities.fill(0);
    }
}

function expandGraphPulse() {
    if (!nodes.length) return;
    if (currentLayout !== 'force') {
        resumeForceFromCurrentPositions();
    } else if (!forceSim) {
        rebuildForceSim();
    }
    if (forceSim) {
        forceSim.alpha = Math.max(forceSim.alpha, 0.45);
        forceSim.startExpansionPulse(1);
    }
}

function toggleEdges() { applyFilters(); }
function searchClass(e) {
    const term = document.getElementById('classSearch').value.toLowerCase();
    const res = document.getElementById('searchResults');
    if (term.length < 2) {
        res.innerHTML = '';
        return;
    }
    const matches = [];
    nodeMeshes.forEach((_, name) => {
        const regex = new RegExp(term, 'gi');
        if (regex.test(name)) matches.push(name);
    });
    // Очищаем и строим элементы
    res.innerHTML = '';
    if (matches.length === 0) {
        res.innerHTML = '<span style="color:#888">No matches</span>';
        return;
    }
    matches.slice(0, 10).forEach(name => {
        const div = document.createElement('div');
        div.className = 'badge highlight';
        div.style.cursor = 'pointer';
        div.textContent = name;
        div.addEventListener('click', () => focusOnClass(name));
        res.appendChild(div);
        res.appendChild(document.createElement('br'));
    });

    e.stopPropagation();
}

function resetView() {
    if (nodes.length === 0) {
        camera.position.set(30, 20, 40);
        controls.reset();
    }
    currentLayout = 'free';
    document.getElementById('layoutType').value = 'free';
    endForceLayoutDeferral();
    forceSim = null;
    nodes.forEach(n => n.userData.velocity.set(0, 0, 0));
    const maxDepsSlider = document.getElementById('maxDeps');
    maxDepsSlider.value = maxDepsSlider.max;
    currentMaxDeps = parseInt(maxDepsSlider.max);
    document.getElementById('nodeScale').value = 1; nodeScale = 1;
    document.getElementById('nodeColorMode').value = 'degree';
    nodeColorMode = 'degree';
    updateNodeColors();
    document.getElementById('edgeOpacity').value = 0.4; edgeOpacity = 0.4;
    document.getElementById('showEdges').value = 'all';
    document.getElementById('classSearch').value = '';
    document.getElementById('searchResults').innerHTML = '';
    applyInitialPositions();
    applyFilters();
    if (nodes.length > 0) {
        fitCameraToVisibleNodes();
    }
}
function clearGraph() {
    nodeMeshes.forEach(m => { scene.remove(m); m.geometry?.dispose(); });
    disposeNodeMaterials();
    nodeMeshes.clear();
    nodes = [];
    if (edgeLines) {
        scene.remove(edgeLines);
        edgeLineGeometry?.dispose();
        edgeLines.material?.dispose();
    }
    edgeLines = null;
    edgeLineGeometry = null;
    edgeMeshes.clear();
    edgeList = [];
    activeEdges = [];
    edges = [];
    maxNodeDepCount = 1;
    degreeColorCache.clear();
    forceSim = null;
    forcePhase = 'full';
    internalSimFrames = 0;
    if (dragControls) { dragControls.dispose(); dragControls = null; }
    selectedNode = null;
    ['nodeCount', 'visibleNodeCount', 'edgeCount', 'nsCount'].forEach(id => document.getElementById(id).textContent = '0');
    document.getElementById('nodeInfo').innerHTML = 'Click on a node for details';
    highlightedNodes = [];
}
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
}
function getClassColor(t) {
    return {
        class: 0x4CAF50,
        interface: 0x2196F3,
        trait: 0xFF9800,
        abstract_class: 0x9C27B0,
        external: 0x888888
    }[t] || 0x9E9E9E;
}
function getEdgeColor(types) {
    if (types.includes('extends')) return 0xFF5252;
    if (types.includes('implements')) return 0x448AFF;
    return 0xBDBDBD;
}

// --- Старт ---
window.addEventListener('DOMContentLoaded', () => {
    bindUiEvents();
    nodeColorMode = document.getElementById('nodeColorMode').value;
    updateColorLegend();
    updateForceSettings(false);
    init();
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('data')) {
        document.getElementById('loading').style.display = 'block';
        fetch(urlParams.get('data'))
            .then(r => r.json())
            .then(d => { graphData = d; visualizeGraph(d); document.getElementById('loading').style.display = 'none'; })
            .catch(() => document.getElementById('loading').style.display = 'none');
    }
    renderer.domElement.addEventListener('click', onMouseClick);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.json')) {
        document.getElementById('loading').style.display = 'block';
        const reader = new FileReader();
        reader.onload = ev => { graphData = JSON.parse(ev.target.result); visualizeGraph(graphData); document.getElementById('loading').style.display = 'none'; };
        reader.readAsText(file);
    }
});
