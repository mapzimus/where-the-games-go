import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const TEXTURE_ROOT = "https://cdn.jsdelivr.net/npm/three-globe@2.45.0/example";
const TEXTURES = {
  day: `${TEXTURE_ROOT}/img/earth-blue-marble.jpg`,
  night: `${TEXTURE_ROOT}/img/earth-night.jpg`,
  water: `${TEXTURE_ROOT}/img/earth-water.png`,
  topo: `${TEXTURE_ROOT}/img/earth-topology.png`,
  sky: `${TEXTURE_ROOT}/img/night-sky.png`,
  clouds: `${TEXTURE_ROOT}/clouds/clouds.png`
};

export const PALETTE = {
  route: "#cfe0f5",
  destination: "#ffc46b",
  selected: "#7fe9ff",
  hub: "#f2a7c3",
  onward: "#c9b0ff",
  origin: "#ffffff"
};

// Sun position relative to the viewer, so Night stays dark wherever the globe is turned.
const LIGHT_OFFSETS = { day: 12, dusk: 84, night: 180 };
const SUN_LATITUDE = 12;

const ATMOSPHERE_RADIUS = 1.16;
const CLOSEST_DISTANCE = 1.3;
const MAX_ZOOM = 1.5;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export function lngLatToVector(lng, lat, radius = 1) {
  const phi = lat * Math.PI / 180;
  const lambda = lng * Math.PI / 180;
  return new THREE.Vector3(
    radius * Math.cos(phi) * Math.cos(lambda),
    radius * Math.sin(phi),
    -radius * Math.cos(phi) * Math.sin(lambda)
  );
}

const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Build one great-circle arc as line-segment vertices, lifted slightly off the surface. */
function buildArc(start, end) {
  const a = lngLatToVector(start[0], start[1]);
  const b = lngLatToVector(end[0], end[1]);
  const omega = a.angleTo(b);
  const steps = Math.max(6, Math.ceil(omega * 180 / Math.PI / 3));
  const lift = Math.min(.1, .008 + omega * .05);
  const point = new THREE.Vector3();
  const samples = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (omega < 1e-6) point.copy(a);
    else {
      const sinOmega = Math.sin(omega);
      point.copy(a).multiplyScalar(Math.sin((1 - t) * omega) / sinOmega)
        .addScaledVector(b, Math.sin(t * omega) / sinOmega);
    }
    const radius = 1.002 + lift * Math.sin(Math.PI * t);
    samples.push([point.x * radius, point.y * radius, point.z * radius, t]);
  }
  const positions = new Float32Array(steps * 6);
  const progress = new Float32Array(steps * 2);
  for (let i = 0; i < steps; i += 1) {
    positions.set(samples[i].slice(0, 3), i * 6);
    positions.set(samples[i + 1].slice(0, 3), i * 6 + 3);
    progress[i * 2] = samples[i][3];
    progress[i * 2 + 1] = samples[i + 1][3];
  }
  return { positions, progress };
}

const routeVertex = /* glsl */`
  attribute float aProgress;
  varying float vProgress;
  void main() {
    vProgress = aProgress;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const routeFragment = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uDash;
  uniform float uReveal;
  uniform float uOriginFade;
  varying float vProgress;
  void main() {
    if (vProgress > uReveal) discard;
    if (uDash > 0.0 && fract(vProgress * uDash) > 0.55) discard;
    // Hundreds of routes share one start point. Fading each line out near the
    // start keeps Salem from turning into a solid white knot.
    float fade = mix(1.0, smoothstep(0.04, 0.8, vProgress), uOriginFade);
    gl_FragColor = vec4(uColor, uOpacity * fade);
  }
`;

const pointVertex = /* glsl */`
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  uniform float uDistance;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio * clamp(2.9 / uDistance, 0.72, 1.5);
    gl_Position = projectionMatrix * mv;
  }
`;

const pointFragment = /* glsl */`
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.34, 0.2, d);
    float glow = pow(1.0 - d, 2.2) * 0.55;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.45), clamp(core + glow, 0.0, 1.0));
  }
`;

const earthVertex = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const earthFragment = /* glsl */`
  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uWater;
  uniform sampler2D uTopo;
  uniform sampler2D uClouds;
  uniform float uHasClouds;
  uniform float uCloudOffset;
  uniform vec3 uSun;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vNormalW;

  vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 v = normalize(cameraPosition - vWorld);

    // Terrain relief. Sampling neighbouring texels stays smooth when zoomed in,
    // where screen-space derivatives of a low-resolution height map turn blocky.
    vec2 step = vec2(1.5 / 4096.0, 1.5 / 2048.0);
    float east = texture2D(uTopo, vUv + vec2(step.x, 0.0)).r - texture2D(uTopo, vUv - vec2(step.x, 0.0)).r;
    float north = texture2D(uTopo, vUv + vec2(0.0, step.y)).r - texture2D(uTopo, vUv - vec2(0.0, step.y)).r;
    vec3 eastAxis = normalize(cross(vec3(0.0, 1.0, 0.0), n));
    vec3 northAxis = cross(n, eastAxis);
    vec3 surface = normalize(n - 0.9 * (east * eastAxis + north * northAxis));

    float sunAngle = dot(n, uSun);
    float dayMix = smoothstep(-0.14, 0.2, sunAngle);
    float water = texture2D(uWater, vUv).r;

    float cloudShadow = 1.0;
    if (uHasClouds > 0.5) {
      vec2 cloudUv = vec2(fract(vUv.x - uCloudOffset), vUv.y);
      vec4 cloud = texture2D(uClouds, cloudUv + vec2(0.0012, 0.0008));
      cloudShadow = 1.0 - 0.42 * cloud.a * cloud.r;
    }

    vec3 albedo = toLinear(texture2D(uDay, vUv).rgb);
    vec3 lit = albedo * (max(dot(surface, uSun), 0.0) * 1.5 + 0.015) * cloudShadow;

    // Sunlight glinting off open water.
    vec3 halfway = normalize(uSun + v);
    float glint = pow(max(dot(n, halfway), 0.0), 260.0) * water * dayMix;
    lit += vec3(0.72, 0.82, 0.95) * glint * 0.07;

    // Warm band along the line between day and night.
    float dusk = smoothstep(-0.1, 0.0, sunAngle) * smoothstep(0.1, 0.0, sunAngle);
    lit += vec3(0.42, 0.15, 0.05) * dusk * 0.04 * (0.3 + albedo);

    vec3 cityLights = toLinear(texture2D(uNight, vUv).rgb) * vec3(1.0, 0.82, 0.6);
    vec3 color = lit + cityLights * (1.0 - dayMix) * 0.62;

    // Air thickens toward the edge of the disc.
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.4);
    color += vec3(0.24, 0.46, 0.92) * rim * smoothstep(-0.3, 0.45, sunAngle) * 0.8;

    color = 1.0 - exp(-color * 1.5);
    gl_FragColor = vec4(pow(color, vec3(1.0 / 2.2)), 1.0);
  }
`;

const cloudFragment = /* glsl */`
  uniform sampler2D uClouds;
  uniform vec3 uSun;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vec4 cloud = texture2D(uClouds, vUv);
    float light = smoothstep(-0.16, 0.34, dot(normalize(vNormalW), uSun));
    vec3 color = mix(vec3(0.015, 0.02, 0.035), vec3(1.0), light);
    gl_FragColor = vec4(color, cloud.a * cloud.r * uOpacity * (0.14 + 0.86 * light));
  }
`;

const atmosphereFragment = /* glsl */`
  uniform vec3 uSun;
  uniform float uRadius;
  varying vec3 vWorld;
  void main() {
    vec3 ray = normalize(vWorld - cameraPosition);
    vec3 closest = cameraPosition + ray * dot(-cameraPosition, ray);
    float height = (length(closest) - 1.0) / (uRadius - 1.0);
    if (height < 0.0 || height > 1.0) discard;
    float density = exp(-height * 5.2);
    float sun = dot(normalize(closest), uSun);
    float lit = smoothstep(-0.32, 0.42, sun);
    vec3 sky = mix(vec3(0.95, 0.38, 0.16), vec3(0.3, 0.58, 1.0), smoothstep(-0.08, 0.5, sun));
    gl_FragColor = vec4(sky, density * lit * 0.86);
  }
`;

function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(.07, "rgba(255,247,226,.95)");
  gradient.addColorStop(.2, "rgba(255,214,150,.24)");
  gradient.addColorStop(.55, "rgba(255,180,110,.05)");
  gradient.addColorStop(1, "rgba(255,170,100,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

function createStars() {
  const count = 3200;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const tints = [[1, 1, 1], [.78, .86, 1], [1, .9, .76]];
  const random = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    random.randomDirection().multiplyScalar(70);
    positions.set([random.x, random.y, random.z], i * 3);
    const brightness = .3 + Math.pow(Math.random(), 3) * .7;
    const tint = tints[i % tints.length];
    colors.set(tint.map(channel => channel * brightness), i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
}

class RouteLayer {
  constructor(scene, color, { dash = 0, originFade = 1, order = 3 } = {}) {
    this.uniforms = {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0 },
      uDash: { value: dash },
      uReveal: { value: 1.01 },
      uOriginFade: { value: originFade }
    };
    this.mesh = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: routeVertex,
      fragmentShader: routeFragment,
      transparent: true,
      depthWrite: false
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    scene.add(this.mesh);
  }

  setArcs(arcs) {
    const total = arcs.reduce((sum, arc) => sum + arc.positions.length, 0);
    const positions = new Float32Array(total);
    const progress = new Float32Array(total / 3);
    let offset = 0;
    arcs.forEach(arc => {
      positions.set(arc.positions, offset);
      progress.set(arc.progress, offset / 3);
      offset += arc.positions.length;
    });
    this.mesh.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aProgress", new THREE.BufferAttribute(progress, 1));
    this.mesh.geometry = geometry;
  }
}

class PointLayer {
  constructor(scene, uniforms, order) {
    this.items = [];
    this.mesh = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms,
      vertexShader: pointVertex,
      fragmentShader: pointFragment,
      transparent: true,
      depthWrite: false
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    scene.add(this.mesh);
  }

  setItems(items) {
    this.items = items;
    const positions = new Float32Array(items.length * 3);
    const sizes = new Float32Array(items.length);
    const colors = new Float32Array(items.length * 3);
    const color = new THREE.Color();
    items.forEach((item, index) => {
      const point = lngLatToVector(item.lng, item.lat, 1.004);
      positions.set([point.x, point.y, point.z], index * 3);
      sizes[index] = item.size;
      color.set(item.color);
      colors.set([color.r, color.g, color.b], index * 3);
    });
    this.mesh.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    this.mesh.geometry = geometry;
  }
}

export function createGlobe({ canvas, startLng = -92, startLat = 34, onPick, onFrame, onTextureError }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x03050b);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, .02, 200);
  camera.position.copy(lngLatToVector(startLng, startLat, 3));

  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = true;
  controls.dampingFactor = .07;
  controls.minPolarAngle = .12;
  controls.maxPolarAngle = Math.PI - .12;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: null };
  canvas.style.touchAction = "none";

  const sun = { value: new THREE.Vector3() };
  const sunTarget = new THREE.Vector3();
  let lightOffset = LIGHT_OFFSETS.dusk;
  const aimSun = vector => {
    const viewerLng = Math.atan2(-camera.position.z, camera.position.x) * 180 / Math.PI;
    return vector.copy(lngLatToVector(viewerLng + lightOffset, SUN_LATITUDE)).normalize();
  };
  aimSun(sun.value);

  const blank = new THREE.DataTexture(new Uint8Array([8, 18, 38, 255]), 1, 1);
  blank.needsUpdate = true;
  const earthUniforms = {
    uDay: { value: blank },
    uNight: { value: blank },
    uWater: { value: blank },
    uTopo: { value: blank },
    uClouds: { value: blank },
    uHasClouds: { value: 0 },
    uCloudOffset: { value: 0 },
    uSun: sun
  };
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 128, 96),
    new THREE.ShaderMaterial({ uniforms: earthUniforms, vertexShader: earthVertex, fragmentShader: earthFragment })
  );
  earth.renderOrder = 0;
  scene.add(earth);

  const cloudUniforms = { uClouds: { value: blank }, uSun: sun, uOpacity: { value: 0 } };
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(1.007, 96, 72),
    new THREE.ShaderMaterial({ uniforms: cloudUniforms, vertexShader: earthVertex, fragmentShader: cloudFragment, transparent: true, depthWrite: false })
  );
  clouds.renderOrder = 1;
  scene.add(clouds);

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(ATMOSPHERE_RADIUS, 96, 64),
    new THREE.ShaderMaterial({
      uniforms: { uSun: sun, uRadius: { value: ATMOSPHERE_RADIUS } },
      vertexShader: earthVertex,
      fragmentShader: atmosphereFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending
    })
  );
  atmosphere.renderOrder = 2;
  scene.add(atmosphere);

  scene.add(createStars());
  const skyMaterial = new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, color: 0x8c96a8 });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 48, 32), skyMaterial);
  scene.add(sky);

  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  sunSprite.scale.setScalar(26);
  scene.add(sunSprite);

  const routes = new RouteLayer(scene, PALETTE.route);
  const onward = new RouteLayer(scene, PALETTE.onward, { dash: 26, originFade: 0 });
  const highlightRoutes = new RouteLayer(scene, PALETTE.selected, { originFade: .4, order: 4 });
  const highlightOnward = new RouteLayer(scene, PALETTE.selected, { dash: 26, originFade: 0, order: 4 });
  const freshRoutes = new RouteLayer(scene, PALETTE.destination, { originFade: .3, order: 4 });
  highlightRoutes.uniforms.uOpacity.value = .42;
  highlightOnward.uniforms.uOpacity.value = .6;
  freshRoutes.uniforms.uOpacity.value = .85;

  const pointUniforms = { uPixelRatio: { value: renderer.getPixelRatio() }, uDistance: { value: 3 } };
  const destinations = new PointLayer(scene, pointUniforms, 5);
  const hubs = new PointLayer(scene, pointUniforms, 6);
  const origin = new PointLayer(scene, pointUniforms, 7);

  // View state. The page sets distance and framing from scroll; the viewer adds zoom on top.
  const view = { distance: 2.2, offsetX: 0, offsetY: 0 };
  const viewTarget = { distance: 2.2, offsetX: 0, offsetY: 0 };
  let zoom = 1;
  let zoomTarget = 1;
  let interactive = false;
  let flight = null;
  let reveal = null;
  let width = 1;
  let height = 1;

  const resize = () => {
    width = window.innerWidth;
    height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  const scratch = new THREE.Vector3();
  const project = (lng, lat) => {
    const point = lngLatToVector(lng, lat, 1.004);
    const facing = point.clone().normalize().dot(camera.position.clone().normalize());
    const visible = facing > 1 / camera.position.length() + .01;
    scratch.copy(point).project(camera);
    return { x: (scratch.x + 1) / 2 * width, y: (1 - scratch.y) / 2 * height, visible };
  };

  const nearest = (x, y, radius) => {
    let best = null;
    let bestDistance = radius;
    [[origin, "origin"], [hubs, "hub"], [destinations, "destination"]].forEach(([layer, type]) => {
      layer.items.forEach(item => {
        const screen = project(item.lng, item.lat);
        if (!screen.visible) return;
        const distance = Math.hypot(screen.x - x, screen.y - y);
        if (distance < bestDistance) {
          best = { ...item, type };
          bestDistance = distance;
        }
      });
    });
    return best;
  };

  const clampZoom = value => THREE.MathUtils.clamp(value, CLOSEST_DISTANCE / viewTarget.distance, MAX_ZOOM);

  // Zooming in leans toward the point under the cursor, so people can fly to a place.
  const leanToward = (x, y, amount) => {
    const ray = new THREE.Vector3(x / width * 2 - 1, 1 - y / height * 2, .5).unproject(camera).sub(camera.position).normalize();
    const along = -camera.position.dot(ray);
    const closest = camera.position.clone().addScaledVector(ray, along);
    if (closest.lengthSq() >= 1) return;
    const hit = camera.position.clone().addScaledVector(ray, along - Math.sqrt(1 - closest.lengthSq())).normalize();
    const length = camera.position.length();
    camera.position.normalize().lerp(hit, amount).setLength(length);
  };

  let press = null;
  const touches = new Map();
  let pinchSpan = 0;
  const touchSpan = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener("pointerdown", event => {
    press = { x: event.clientX, y: event.clientY };
    flight = null;
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) pinchSpan = touchSpan();
      if (touches.size > 1) press = null;
    }
  });
  canvas.addEventListener("pointermove", event => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size !== 2) return;
    const span = touchSpan();
    zoomTarget = clampZoom(zoomTarget * pinchSpan / Math.max(span, 1));
    pinchSpan = span;
  });
  const releaseTouch = event => { touches.delete(event.pointerId); };
  canvas.addEventListener("pointerup", releaseTouch);
  canvas.addEventListener("pointercancel", releaseTouch);
  canvas.addEventListener("pointerup", event => {
    if (!press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) return;
    onPick?.(nearest(event.clientX, event.clientY, event.pointerType === "touch" ? 24 : 14));
  });
  canvas.addEventListener("pointermove", event => {
    if (event.buttons) return;
    canvas.style.cursor = nearest(event.clientX, event.clientY, 14) ? "pointer" : "grab";
  });
  canvas.addEventListener("wheel", event => {
    // Scrolling down at the normal view leaves the globe, so the page never traps the wheel.
    if (event.deltaY > 0 && zoomTarget >= 1 && !event.ctrlKey) return;
    event.preventDefault();
    flight = null;
    const pixels = event.deltaY * (event.deltaMode === 1 ? 32 : 1);
    const next = clampZoom(zoomTarget * Math.exp(pixels * (event.ctrlKey ? .01 : .0016)));
    if (next < zoomTarget) leanToward(event.clientX, event.clientY, Math.min(.08, (zoomTarget - next) * .9));
    zoomTarget = event.deltaY > 0 && !event.ctrlKey ? Math.min(next, 1) : next;
  }, { passive: false });

  const flyTo = (lng, lat, zoomLevel = zoomTarget, duration = 1400) => new Promise(resolve => {
    if (zoomLevel !== undefined) zoomTarget = zoomLevel;
    const to = lngLatToVector(lng, lat).normalize();
    if (reducedMotion.matches || duration === 0) {
      camera.position.copy(to.multiplyScalar(camera.position.length()));
      resolve();
      return;
    }
    flight = { from: camera.position.clone().normalize(), to, start: performance.now(), duration, resolve };
  });

  const clock = new THREE.Clock();
  const animate = () => {
    const delta = Math.min(clock.getDelta(), .1);
    const now = performance.now();
    const moving = !reducedMotion.matches;

    if (flight) {
      const t = Math.min((now - flight.start) / flight.duration, 1);
      const direction = flight.from.clone().lerp(flight.to, easeInOut(t)).normalize();
      camera.position.copy(direction.multiplyScalar(camera.position.length()));
      if (t >= 1) {
        const { resolve } = flight;
        flight = null;
        resolve();
      }
    }

    const ease = 1 - Math.exp(-delta * 5);
    Object.keys(view).forEach(key => { view[key] += (viewTarget[key] - view[key]) * ease; });
    zoom += ((interactive ? zoomTarget : 1) - zoom) * ease;
    const distance = Math.max(CLOSEST_DISTANCE, view.distance * zoom);
    camera.position.setLength(distance);
    controls.rotateSpeed = THREE.MathUtils.clamp((distance - 1) / 2.6, .03, .9);
    controls.update();
    camera.position.setLength(distance);
    camera.setViewOffset(width, height, -view.offsetX * width, -view.offsetY * height, width, height);
    pointUniforms.uDistance.value = distance;

    sun.value.lerp(aimSun(sunTarget), ease * .55).normalize();
    sunSprite.position.copy(sun.value).multiplyScalar(62);

    if (moving) {
      clouds.rotation.y += delta * .0028;
      earthUniforms.uCloudOffset.value = clouds.rotation.y / (Math.PI * 2);
    }
    if (reveal) {
      const t = moving ? Math.min((now - reveal.start) / reveal.duration, 1) : 1;
      freshRoutes.uniforms.uReveal.value = t * 1.02;
      freshRoutes.uniforms.uOpacity.value = t < .72 ? .85 : .85 * (1 - (t - .72) / .28) + .12;
      if (t >= 1) reveal = null;
    }

    renderer.render(scene, camera);
    onFrame?.();
    requestAnimationFrame(animate);
  };

  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin("anonymous");
  const load = (url, colorful = false) => new Promise((resolve, reject) => {
    loader.load(url, texture => {
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.wrapS = THREE.RepeatWrapping;
      if (colorful) texture.generateMipmaps = true;
      resolve(texture);
    }, undefined, () => reject(new Error(`Texture failed: ${url}`)));
  });

  // The surface loads first so the page is usable before the larger cloud map arrives.
  const ready = Promise.all([load(TEXTURES.day, true), load(TEXTURES.night, true), load(TEXTURES.water), load(TEXTURES.topo)])
    .then(([day, night, water, topo]) => {
      earthUniforms.uDay.value = day;
      earthUniforms.uNight.value = night;
      earthUniforms.uWater.value = water;
      earthUniforms.uTopo.value = topo;
      load(TEXTURES.clouds).then(texture => {
        cloudUniforms.uClouds.value = texture;
        cloudUniforms.uOpacity.value = .72;
        earthUniforms.uClouds.value = texture;
        earthUniforms.uHasClouds.value = 1;
      }).catch(() => {});
      load(TEXTURES.sky).then(texture => {
        texture.colorSpace = THREE.SRGBColorSpace;
        skyMaterial.map = texture;
        skyMaterial.opacity = .42;
        skyMaterial.needsUpdate = true;
      }).catch(() => {});
    })
    .catch(error => {
      console.error(error);
      onTextureError?.();
    });

  requestAnimationFrame(animate);

  return {
    ready,
    buildArc,
    project,
    flyTo,
    setPoints({ destinationItems, hubItems, originItem }) {
      destinations.setItems(destinationItems);
      hubs.setItems(hubItems);
      origin.setItems([originItem]);
    },
    setRoutes({ base, onwardArcs, highlight, highlightOnwardArcs }) {
      routes.setArcs(base);
      onward.setArcs(onwardArcs);
      highlightRoutes.setArcs(highlight);
      highlightOnward.setArcs(highlightOnwardArcs);
    },
    showFreshRoutes(arcs) {
      freshRoutes.setArcs(arcs);
      freshRoutes.uniforms.uReveal.value = reducedMotion.matches ? 1.02 : 0;
      reveal = arcs.length ? { start: performance.now(), duration: 800 } : null;
    },
    setRouteStrength(strength) {
      routes.uniforms.uOpacity.value = strength * .34;
      onward.uniforms.uOpacity.value = Math.min(1, strength * .9);
      const shown = strength > 0;
      highlightRoutes.mesh.visible = shown;
      highlightOnward.mesh.visible = shown;
      freshRoutes.mesh.visible = shown;
    },
    setFraming(next) {
      Object.assign(viewTarget, next);
    },
    jumpFraming(next) {
      Object.assign(viewTarget, next);
      Object.assign(view, next);
    },
    setInteractive(active) {
      interactive = active;
      canvas.style.pointerEvents = active ? "auto" : "none";
    },
    zoomBy(factor) {
      zoomTarget = clampZoom(zoomTarget * factor);
    },
    resetZoom() {
      zoomTarget = 1;
    },
    setLight(name) {
      lightOffset = LIGHT_OFFSETS[name] ?? LIGHT_OFFSETS.dusk;
    }
  };
}
