/*
 * SideRays shader adapted from React Bits.
 * Copyright (c) 2026 David Haz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, and distribute the Software as part of
 * an application, website, or product, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * You may use this Software, including for any commercial purpose, so long as
 * you do not sell, sublicense, or redistribute the components themselves,
 * whether alone, in a bundle, or as a ported version.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md
 */

import { Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef } from "react";

const vertex = `
attribute vec2 position;
void main() {
	gl_Position = vec4(position, 0.0, 1.0);
}`;

const fragment = `
precision highp float;

uniform float iTime;
uniform vec2 iResolution;

float rayStrength(vec2 source, vec2 direction, vec2 coord, float seedA, float seedB, float speed) {
	vec2 sourceToCoord = coord - source;
	float angle = dot(normalize(sourceToCoord), direction);
	return clamp(
		(0.45 + 0.15 * sin(angle * seedA + iTime * speed)) +
		(0.3 + 0.2 * cos(-angle * seedB + iTime * speed)),
		0.0, 1.0
	) * clamp((iResolution.x - length(sourceToCoord)) / iResolution.x, 0.5, 1.0);
}

void main() {
	vec2 fragCoord = gl_FragCoord.xy;
	vec2 coord = vec2(fragCoord.x, iResolution.y - fragCoord.y);
	vec2 source = vec2(iResolution.x * 1.1, -0.5 * iResolution.y);
	float halfSpread = 1.5 * 0.275;
	vec2 direction1 = normalize(vec2(cos(0.785398 + halfSpread), sin(0.785398 + halfSpread)));
	vec2 direction2 = normalize(vec2(cos(0.785398 - halfSpread), sin(0.785398 - halfSpread)));
	vec4 ray1 = vec4(1.0, 1.0, 1.0, 1.0) * rayStrength(source, direction1, coord, 36.2214, 21.11349, 2.5);
	vec4 ray2 = vec4(0.5804, 0.6392, 0.7216, 1.0) * rayStrength(source, direction2, coord, 22.3991, 18.0234, 0.5);
	vec4 color = ray1 * 0.45 + ray2 * 0.45;
	float distanceToLight = length(fragCoord - vec2(source.x, iResolution.y - source.y)) / iResolution.y;
	color.rgb *= 1.2 / pow(max(distanceToLight, 0.001), 1.5);
	color.a = max(color.r, max(color.g, color.b)) * 0.75;
	gl_FragColor = color;
}`;

export function SideRays() {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || typeof WebGLRenderingContext === "undefined") return;

		let renderer: Renderer;
		try {
			renderer = new Renderer({ alpha: true, dpr: Math.min(window.devicePixelRatio, 2) });
		} catch {
			return;
		}

		const { gl } = renderer;
		const uniforms = { iTime: { value: 0 }, iResolution: { value: [1, 1] } };
		const scene = new Mesh(gl, {
			geometry: new Triangle(gl),
			program: new Program(gl, { fragment, uniforms, vertex }),
		});
		container.appendChild(gl.canvas);

		const resize = () => {
			const { clientHeight: height, clientWidth: width } = container;
			if (width === 0 || height === 0) return;
			renderer.dpr = Math.min(window.devicePixelRatio, 2);
			renderer.setSize(width, height);
			uniforms.iResolution.value = [width * renderer.dpr, height * renderer.dpr];
		};
		const resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(container);
		resize();

		let animationFrame = 0;
		const render = (time: number) => {
			uniforms.iTime.value = time * 0.001;
			renderer.render({ scene });
			animationFrame = requestAnimationFrame(render);
		};
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			renderer.render({ scene });
		} else {
			animationFrame = requestAnimationFrame(render);
		}

		return () => {
			cancelAnimationFrame(animationFrame);
			resizeObserver.disconnect();
			gl.getExtension("WEBGL_lose_context")?.loseContext();
			gl.canvas.remove();
		};
	}, []);

	return <div aria-hidden="true" className="new-task-side-rays" ref={containerRef} />;
}
