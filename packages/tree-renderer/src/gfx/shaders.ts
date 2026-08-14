import { GlProgram, GpuProgram, Shader, Texture, UniformGroup } from 'pixi.js';
import type { TextureSource } from 'pixi.js';

/**
 * Custom shader programs.
 *
 * Pixi's `Mesh` pipe binds the global uniforms and the mesh's own local
 * uniforms for us — WebGL by name (group 100/101), WebGPU at bind groups 0 and
 * 1 — so custom resources start at group 2. The declarations below must match
 * Pixi's own `globalUniformsBit` / `localUniformBit` exactly or the bindings
 * silently mismatch.
 */

const GL_GLOBALS = /* glsl */ `
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform vec4 uWorldColorAlpha;
  uniform vec2 uResolution;
  uniform mat3 uTransformMatrix;
  uniform vec4 uColor;
  uniform float uRound;
`;

const WGSL_GLOBALS = /* wgsl */ `
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
};
@group(0) @binding(0) var<uniform> globalUniforms : GlobalUniforms;

struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
};
@group(1) @binding(0) var<uniform> localUniforms : LocalUniforms;
`;

/** Shared brightness animation. mode: 0 none, 1 hover pulse, 2 pending shimmer. */
const GL_ANIM = /* glsl */ `
  float animBrightness(float mode, float phase, float t) {
    if (mode > 1.5) return 0.62 + 0.16 * sin(t * 2.1 + phase);
    if (mode > 0.5) return 1.12 + 0.14 * sin(t * 7.0 + phase);
    return 1.0;
  }
`;

const WGSL_ANIM = /* wgsl */ `
fn animBrightness(mode: f32, phase: f32, t: f32) -> f32 {
  if (mode > 1.5) { return 0.62 + 0.16 * sin(t * 2.1 + phase); }
  if (mode > 0.5) { return 1.12 + 0.14 * sin(t * 7.0 + phase); }
  return 1.0;
}
`;

// ---------------------------------------------------------------------------
// Static textured quads: connectors and group backgrounds.
// Positions are baked tree-space coordinates straight from the schema, so
// curved orbit arcs keep their independent per-corner UVs.

const STATIC_VERT_GL = /* glsl */ `#version 300 es
  in vec2 aPosition;
  in vec2 aUV;
  in vec4 aColor;
  in vec2 aAnim;
  in vec4 aRect;

  ${GL_GLOBALS}
  uniform float uTime;

  out vec2 vUV;
  out vec4 vColor;
  out vec4 vRect;

  ${GL_ANIM}

  void main(void) {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vRect = aRect;
    float b = animBrightness(aAnim.x, aAnim.y, uTime);
    // Premultiplied output: Pixi's 'normal' blend is (ONE, 1-SRC_ALPHA) and the
    // sheet textures are uploaded premultiplied.
    vColor = vec4(aColor.rgb * b * aColor.a, aColor.a) * uColor * uWorldColorAlpha;
  }
`;

const STATIC_FRAG_GL = /* glsl */ `#version 300 es
  in vec2 vUV;
  in vec4 vColor;
  in vec4 vRect;
  uniform sampler2D uTexture;
  out vec4 finalColor;

  void main(void) {
    vec4 tex;
    if (vRect.z < 0.0) {
      // Common case: the quad's UVs are already absolute sheet coordinates.
      tex = texture(uTexture, vUV);
    } else {
      // A long link tiles a short strip along its length, so its UVs run past
      // 1. GL_REPEAT cannot do that inside an atlas, so the repeat is folded
      // here; derivatives come from the unwrapped coordinate so the seam
      // between tiles does not collapse to the smallest mip.
      vec2 size = vRect.zw - vRect.xy;
      vec2 uv = vRect.xy + fract(vUV) * size;
      tex = textureGrad(uTexture, uv, dFdx(vUV) * size, dFdy(vUV) * size);
    }
    finalColor = tex * vColor;
  }
`;

const STATIC_VERT_WGSL = /* wgsl */ `
${WGSL_GLOBALS}
struct SceneUniforms { uTime: f32 };
@group(2) @binding(2) var<uniform> sceneUniforms : SceneUniforms;

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vRect: vec4<f32>,
};

${WGSL_ANIM}

@vertex
fn main(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
  @location(2) aColor: vec4<f32>,
  @location(3) aAnim: vec2<f32>,
  @location(4) aRect: vec4<f32>,
) -> VSOut {
  var out: VSOut;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  out.position = vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
  out.vUV = aUV;
  out.vRect = aRect;
  let b = animBrightness(aAnim.x, aAnim.y, sceneUniforms.uTime);
  out.vColor = vec4<f32>(aColor.rgb * b * aColor.a, aColor.a) * localUniforms.uColor * globalUniforms.uWorldColorAlpha;
  return out;
}
`;

const STATIC_FRAG_WGSL = /* wgsl */ `
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;

@fragment
fn main(
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vRect: vec4<f32>,
) -> @location(0) vec4<f32> {
  var tex: vec4<f32>;
  if (vRect.z < 0.0) {
    tex = textureSample(uTexture, uSampler, vUV);
  } else {
    let size = vRect.zw - vRect.xy;
    let uv = vRect.xy + fract(vUV) * size;
    tex = textureSampleGrad(uTexture, uSampler, uv, dpdx(vUV) * size, dpdy(vUV) * size);
  }
  return tex * vColor;
}
`;

// ---------------------------------------------------------------------------
// Node quads: centre + corner offset so hover/selection scaling is a single
// float write per vertex instead of recomputing four corner positions.

const NODE_VERT_GL = /* glsl */ `#version 300 es
  in vec2 aPosition;
  in vec2 aOffset;
  in vec2 aUV;
  in vec4 aColor;
  in vec2 aAnim;
  in float aScale;

  ${GL_GLOBALS}
  uniform float uTime;

  out vec2 vUV;
  out vec4 vColor;

  ${GL_ANIM}

  void main(void) {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec2 p = aPosition + aOffset * aScale;
    gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    float b = animBrightness(aAnim.x, aAnim.y, uTime);
    // Premultiplied output: Pixi's 'normal' blend is (ONE, 1-SRC_ALPHA) and the
    // sheet textures are uploaded premultiplied.
    vColor = vec4(aColor.rgb * b * aColor.a, aColor.a) * uColor * uWorldColorAlpha;
  }
`;

const NODE_VERT_WGSL = /* wgsl */ `
${WGSL_GLOBALS}
struct SceneUniforms { uTime: f32 };
@group(2) @binding(2) var<uniform> sceneUniforms : SceneUniforms;

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
};

${WGSL_ANIM}

@vertex
fn main(
  @location(0) aPosition: vec2<f32>,
  @location(1) aOffset: vec2<f32>,
  @location(2) aUV: vec2<f32>,
  @location(3) aColor: vec4<f32>,
  @location(4) aAnim: vec2<f32>,
  @location(5) aScale: f32,
) -> VSOut {
  var out: VSOut;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let p = aPosition + aOffset * aScale;
  out.position = vec4<f32>((mvp * vec3<f32>(p, 1.0)).xy, 0.0, 1.0);
  out.vUV = aUV;
  let b = animBrightness(aAnim.x, aAnim.y, sceneUniforms.uTime);
  out.vColor = vec4<f32>(aColor.rgb * b * aColor.a, aColor.a) * localUniforms.uColor * globalUniforms.uWorldColorAlpha;
  return out;
}
`;

/**
 * Nodes never tile their art, so they get a plain sampler. This must NOT share
 * the static quads' fragment shader: that one declares a `vRect` varying the
 * node vertex shader does not write, and the mismatch fails to link — silently,
 * apart from a "program not valid" warning and every node vanishing.
 */
const NODE_FRAG_GL = /* glsl */ `#version 300 es
  in vec2 vUV;
  in vec4 vColor;
  uniform sampler2D uTexture;
  out vec4 finalColor;

  void main(void) {
    finalColor = texture(uTexture, vUV) * vColor;
  }
`;

const NODE_FRAG_WGSL = /* wgsl */ `
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;

@fragment
fn main(
  @location(0) vUV: vec2<f32>,
  @location(1) vColor: vec4<f32>,
) -> @location(0) vec4<f32> {
  return textureSample(uTexture, uSampler, vUV) * vColor;
}
`;

// ---------------------------------------------------------------------------
// Decoration rings, drawn as analytic SDFs so they stay hairline-crisp at any
// zoom instead of turning into blurry scaled bitmaps the way PoB's do.
//
// aParams = (extent, radius, thickness, style)
//   style 0 = solid ring, 1 = rotating dashed ring, 2 = soft glow disc,
//         3 = filled disc with a soft rim.

const RING_VERT_GL = /* glsl */ `#version 300 es
  in vec2 aPosition;
  in vec2 aLocal;
  in vec4 aParams;
  in vec4 aColor;
  in float aPhase;

  ${GL_GLOBALS}

  out vec2 vLocal;
  out vec4 vParams;
  out vec4 vColor;
  out float vPhase;

  void main(void) {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec2 p = aPosition + aLocal * aParams.x;
    gl_Position = vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
    vLocal = aLocal;
    vParams = aParams;
    vColor = aColor * uColor * uWorldColorAlpha;
    vPhase = aPhase;
  }
`;

const RING_FRAG_GL = /* glsl */ `#version 300 es
  in vec2 vLocal;
  in vec4 vParams;
  in vec4 vColor;
  in float vPhase;

  uniform float uTime;

  out vec4 finalColor;

  const float TAU = 6.28318530718;

  void main(void) {
    float extent = vParams.x;
    float radius = vParams.y;
    float thick  = vParams.z;
    float style  = vParams.w;

    float d = length(vLocal) * extent;
    float w = max(fwidth(d), 1e-6);
    float a = 0.0;

    if (style < 0.5) {
      float h = thick * 0.5;
      a = 1.0 - smoothstep(h - w, h + w, abs(d - radius));
    } else if (style < 1.5) {
      float h = thick * 0.5;
      a = 1.0 - smoothstep(h - w, h + w, abs(d - radius));
      float ang = atan(vLocal.y, vLocal.x) / TAU;
      float dashes = 14.0;
      float f = fract(ang * dashes + uTime * 0.16 + vPhase);
      float aw = max(fwidth(f), 1e-4) * 1.5;
      float gate = smoothstep(0.5 - aw, 0.5 + aw, f);
      a *= mix(0.18, 1.0, gate);
    } else if (style < 2.5) {
      float t = clamp(d / max(radius, 1e-6), 0.0, 1.0);
      a = pow(1.0 - t, 2.4);
    } else {
      a = 1.0 - smoothstep(radius - w - thick, radius + w, d);
    }

    if (a <= 0.001) discard;
    finalColor = vec4(vColor.rgb, 1.0) * (vColor.a * a);
  }
`;

const RING_VERT_WGSL = /* wgsl */ `
${WGSL_GLOBALS}

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLocal: vec2<f32>,
  @location(1) vParams: vec4<f32>,
  @location(2) vColor: vec4<f32>,
  @location(3) vPhase: f32,
};

@vertex
fn main(
  @location(0) aPosition: vec2<f32>,
  @location(1) aLocal: vec2<f32>,
  @location(2) aParams: vec4<f32>,
  @location(3) aColor: vec4<f32>,
  @location(4) aPhase: f32,
) -> VSOut {
  var out: VSOut;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let p = aPosition + aLocal * aParams.x;
  out.position = vec4<f32>((mvp * vec3<f32>(p, 1.0)).xy, 0.0, 1.0);
  out.vLocal = aLocal;
  out.vParams = aParams;
  out.vColor = aColor * localUniforms.uColor * globalUniforms.uWorldColorAlpha;
  out.vPhase = aPhase;
  return out;
}
`;

const RING_FRAG_WGSL = /* wgsl */ `
struct SceneUniforms { uTime: f32 };
@group(2) @binding(2) var<uniform> sceneUniforms : SceneUniforms;

const TAU: f32 = 6.28318530718;

@fragment
fn main(
  @location(0) vLocal: vec2<f32>,
  @location(1) vParams: vec4<f32>,
  @location(2) vColor: vec4<f32>,
  @location(3) vPhase: f32,
) -> @location(0) vec4<f32> {
  let extent = vParams.x;
  let radius = vParams.y;
  let thick  = vParams.z;
  let style  = vParams.w;

  let d = length(vLocal) * extent;
  let w = max(fwidth(d), 1e-6);
  var a: f32 = 0.0;

  if (style < 0.5) {
    let h = thick * 0.5;
    a = 1.0 - smoothstep(h - w, h + w, abs(d - radius));
  } else if (style < 1.5) {
    let h = thick * 0.5;
    a = 1.0 - smoothstep(h - w, h + w, abs(d - radius));
    let ang = atan2(vLocal.y, vLocal.x) / TAU;
    let f = fract(ang * 14.0 + sceneUniforms.uTime * 0.16 + vPhase);
    let aw = max(fwidth(f), 1e-4) * 1.5;
    let gate = smoothstep(0.5 - aw, 0.5 + aw, f);
    a = a * mix(0.18, 1.0, gate);
  } else if (style < 2.5) {
    let t = clamp(d / max(radius, 1e-6), 0.0, 1.0);
    a = pow(1.0 - t, 2.4);
  } else {
    a = 1.0 - smoothstep(radius - w - thick, radius + w, d);
  }

  return vec4<f32>(vColor.rgb, 1.0) * (vColor.a * a);
}
`;

// ---------------------------------------------------------------------------

export interface SceneUniformState {
  /** Seconds since load; drives every shader-side animation. */
  uTime: number;
}

export function createSceneUniforms(): UniformGroup<{ uTime: { value: number; type: 'f32' } }> {
  return new UniformGroup(
    { uTime: { value: 0, type: 'f32' } },
    { ubo: false, isStatic: false },
  );
}

function glProgram(name: string, vertex: string, fragment: string): GlProgram {
  return GlProgram.from({ name, vertex, fragment });
}

function gpuProgram(name: string, vertex: string, fragment: string): GpuProgram | undefined {
  try {
    return GpuProgram.from({
      name,
      vertex: { source: vertex, entryPoint: 'main' },
      fragment: { source: fragment, entryPoint: 'main' },
    });
  } catch {
    // WebGPU shader compilation is best-effort; the WebGL path is the default.
    return undefined;
  }
}

export type SceneUniformGroup = ReturnType<typeof createSceneUniforms>;

function makeShader(
  name: string,
  glVert: string,
  glFrag: string,
  gpuVert: string,
  gpuFrag: string,
  texture: Texture,
  sceneUniforms: SceneUniformGroup,
): Shader {
  const source = texture.source as TextureSource;
  return new Shader({
    glProgram: glProgram(name, glVert, glFrag),
    gpuProgram: gpuProgram(name, gpuVert, gpuFrag),
    resources: {
      uTexture: source,
      uSampler: source.style,
      sceneUniforms,
    },
  });
}

export function createStaticQuadShader(texture: Texture, scene: SceneUniformGroup): Shader {
  return makeShader(
    'tree-static-quad',
    STATIC_VERT_GL,
    STATIC_FRAG_GL,
    STATIC_VERT_WGSL,
    STATIC_FRAG_WGSL,
    texture,
    scene,
  );
}

export function createNodeQuadShader(texture: Texture, scene: SceneUniformGroup): Shader {
  return makeShader(
    'tree-node-quad',
    NODE_VERT_GL,
    NODE_FRAG_GL,
    NODE_VERT_WGSL,
    NODE_FRAG_WGSL,
    texture,
    scene,
  );
}

export function createRingShader(scene: SceneUniformGroup): Shader {
  return new Shader({
    glProgram: glProgram('tree-ring', RING_VERT_GL, RING_FRAG_GL),
    gpuProgram: gpuProgram('tree-ring', RING_VERT_WGSL, RING_FRAG_WGSL),
    resources: {
      // The ring shader is procedural, but Pixi's mesh pipe still expects a
      // texture slot to exist for the WebGPU bind-group layout.
      uTexture: Texture.WHITE.source,
      uSampler: Texture.WHITE.source.style,
      sceneUniforms: scene,
    },
  });
}

/** Swap the texture a shader samples without rebuilding the program. */
export function setShaderTexture(shader: Shader, texture: Texture): void {
  const source = texture.source as TextureSource;
  shader.resources.uTexture = source;
  shader.resources.uSampler = source.style;
}
