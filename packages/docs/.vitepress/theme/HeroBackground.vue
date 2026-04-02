<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

const canvas = ref<HTMLCanvasElement>();
let gl: WebGLRenderingContext | null = null;
let animFrame: number;
let startTime: number;
let program: WebGLProgram | null = null;
let uTime: WebGLUniformLocation | null = null;
let uResolution: WebGLUniformLocation | null = null;

const vertexShaderSrc = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShaderSrc = `
  precision mediump float;
  uniform float u_time;
  uniform vec2 u_resolution;

  float blob(vec2 uv, vec2 center, float radius) {
    return smoothstep(radius, 0.0, length(uv - center));
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;

    vec2 c1 = vec2(0.3 + sin(u_time * 0.5) * 0.15, 0.4 + cos(u_time * 0.3) * 0.2);
    vec2 c2 = vec2(0.7 + cos(u_time * 0.4) * 0.15, 0.6 + sin(u_time * 0.6) * 0.15);
    vec2 c3 = vec2(0.5 + sin(u_time * 0.7) * 0.2,  0.3 + cos(u_time * 0.5) * 0.2);
    vec2 c4 = vec2(0.2 + cos(u_time * 0.35) * 0.12, 0.7 + sin(u_time * 0.45) * 0.15);
    vec2 c5 = vec2(0.8 + sin(u_time * 0.55) * 0.1,  0.2 + cos(u_time * 0.25) * 0.18);

    vec3 col = vec3(0.118, 0.161, 0.231);
    col = mix(col, vec3(0.388, 0.400, 0.945), blob(uv, c1, 0.50));
    col = mix(col, vec3(0.133, 0.827, 0.933), blob(uv, c2, 0.40));
    col = mix(col, vec3(0.388, 0.400, 0.945), blob(uv, c3, 0.35));
    col = mix(col, vec3(0.133, 0.827, 0.933), blob(uv, c4, 0.30));
    col = mix(col, vec3(0.388, 0.400, 0.945), blob(uv, c5, 0.28));

    gl_FragColor = vec4(col, 1.0);
  }
`;

function compileShader(glCtx: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
	const shader = glCtx.createShader(type);
	if (!shader) return null;
	glCtx.shaderSource(shader, src);
	glCtx.compileShader(shader);
	if (!glCtx.getShaderParameter(shader, glCtx.COMPILE_STATUS)) {
		glCtx.deleteShader(shader);
		return null;
	}
	return shader;
}

function createProgram(glCtx: WebGLRenderingContext): WebGLProgram | null {
	const vs = compileShader(glCtx, glCtx.VERTEX_SHADER, vertexShaderSrc);
	const fs = compileShader(glCtx, glCtx.FRAGMENT_SHADER, fragmentShaderSrc);
	if (!vs || !fs) return null;
	const prog = glCtx.createProgram();
	if (!prog) return null;
	glCtx.attachShader(prog, vs);
	glCtx.attachShader(prog, fs);
	glCtx.linkProgram(prog);
	if (!glCtx.getProgramParameter(prog, glCtx.LINK_STATUS)) {
		glCtx.deleteProgram(prog);
		return null;
	}
	return prog;
}

function render(elapsed: number) {
	if (!gl || !program || !canvas.value) return;
	const el = canvas.value;
	const w = el.clientWidth || 1280;
	const h = el.clientHeight || 500;
	if (el.width !== w || el.height !== h) {
		el.width = w;
		el.height = h;
		gl.viewport(0, 0, w, h);
		if (uResolution) gl.uniform2f(uResolution, w, h);
	}
	gl.useProgram(program);
	if (uTime) gl.uniform1f(uTime, elapsed);
	gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function animate() {
	const elapsed = (performance.now() - startTime) * 0.0003;
	render(elapsed);
	animFrame = requestAnimationFrame(animate);
}

const prefersReducedMotion =
	typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

function onResize() {
	if (!canvas.value || !gl) return;
	const el = canvas.value;
	el.width = el.clientWidth;
	el.height = el.clientHeight;
	gl.viewport(0, 0, el.width, el.height);
	if (uResolution) gl.uniform2f(uResolution, el.width, el.height);
	if (prefersReducedMotion) {
		render((performance.now() - startTime) * 0.0003);
	}
}

onMounted(() => {
	if (!canvas.value) return;

	gl = canvas.value.getContext('webgl');
	if (!gl) {
		canvas.value.classList.add('no-webgl');
		return;
	}

	program = createProgram(gl);
	if (!program) {
		gl = null;
		canvas.value.classList.add('no-webgl');
		return;
	}

	gl.useProgram(program);

	const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
	const buf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

	const posLoc = gl.getAttribLocation(program, 'a_position');
	gl.enableVertexAttribArray(posLoc);
	gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

	uTime = gl.getUniformLocation(program, 'u_time');
	uResolution = gl.getUniformLocation(program, 'u_resolution');

	const el = canvas.value;
	el.width = el.clientWidth || 1280;
	el.height = el.clientHeight || 500;
	gl.viewport(0, 0, el.width, el.height);
	if (uResolution) gl.uniform2f(uResolution, el.width, el.height);

	startTime = performance.now();

	if (prefersReducedMotion) {
		render(0);
	} else {
		animate();
	}

	window.addEventListener('resize', onResize);
});

onUnmounted(() => {
	cancelAnimationFrame(animFrame);
	window.removeEventListener('resize', onResize);
	gl = null;
	program = null;
});
</script>

<template>
  <canvas ref="canvas" class="hero-bg-canvas" aria-hidden="true" />
</template>

<style scoped>
.hero-bg-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  display: block;
}

.hero-bg-canvas.no-webgl {
  background: linear-gradient(135deg, #1e293b 0%, #312e81 50%, #164e63 100%);
}

:global(:not(.dark)) .hero-bg-canvas {
  opacity: 0.25;
}

:global(.dark) .hero-bg-canvas {
  opacity: 0.4;
}
</style>
