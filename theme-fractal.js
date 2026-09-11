// Shared WebGL fractal-theme engine for every THE SIGNAL page. Kept as one
// external file (not duplicated per page) specifically because it's the
// large, fiddly piece -- the shader/palette went through several rounds of
// debugging on locurio/index.html (invisible -> washed out -> disconnected
// "dust" Julia parametrization -> rainbow clashing with brand -> the final
// HSL-locked cyan/violet/magenta palette below) and 11 independent copies
// would be exactly the kind of silent-drift risk that already produced one
// real bug this session (the analytics "78 vs 77" truncated-total mismatch).
//
// Mounts/unmounts a <canvas>+scrim pair into the page in response to
// <html data-theme="..."> rather than requiring markup on every page. Safe
// to load on every page regardless of which theme is active or ever
// selected -- it only does anything once data-theme="fractal".
(() => {
  const THEME_ATTR = "data-theme";
  const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const VERT_SRC = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;
  const FRAG_SRC = `
    precision highp float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_mouse;

    // HSL->RGB so the hue range can be precisely constrained to the brand's
    // cyan/violet/magenta family instead of sweeping a full rainbow.
    vec3 hsl2rgb(float h, float s, float l) {
      vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
    }
    vec3 palette(float t) {
      // 188deg (cyan) through 245deg (blue/violet) to 305deg (magenta) and
      // back -- never leaves that arc, so it always reads as "brand," never
      // as a generic rainbow demo. Lightness/saturation kept moderate so it
      // sits behind text as a mood, not a spotlight.
      float hueDeg = 188.0 + 117.0 * (0.5 + 0.5 * sin(t));
      float l = 0.30 + 0.10 * sin(t * 1.7 + 1.0);
      return hsl2rgb(hueDeg / 360.0, 0.7, l);
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - vec2(0.6, 0.48) * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
      float zoom = 2.2;
      uv *= zoom;
      uv += u_mouse * 0.06;

      // Bounded oscillation (not a full circular sweep) -- keeps the Julia
      // constant inside "connected" territory continuously; a wider sweep
      // drifts into disconnected "dust" (nearly everywhere escapes almost
      // immediately) for large stretches of angle.
      float t = 0.35 + 0.22 * sin(u_time * 0.08);
      vec2 c = vec2(0.45 * cos(t), 0.45 * sin(t * 0.87));

      vec2 z = uv;
      float iter = 0.0;
      const float MAX_ITER = 140.0;
      for (float i = 0.0; i < MAX_ITER; i += 1.0) {
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        if (dot(z, z) > 4.0) break;
        iter += 1.0;
      }

      vec3 col;
      if (iter >= MAX_ITER - 1.0) {
        col = vec3(0.02, 0.018, 0.035);
      } else {
        float logZn = log(dot(z, z) + 1e-6) * 0.5;
        float nu = log(logZn / log(2.0)) / log(2.0);
        float smoothIter = iter + 1.0 - nu;
        // Deliberately not normalized by MAX_ITER -- escape time is heavily
        // skewed toward low values, so dividing by 140 crushes nearly the
        // whole image into a sliver of the palette.
        col = palette(smoothIter * 0.045 + u_time * 0.025);
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  let canvas = null, scrim = null, gl = null, rafId = null;
  let resizeHandler = null, pointerHandler = null, contextLostHandler = null;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error("theme-fractal shader compile error", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function mount() {
    if (canvas) return; // already mounted

    const stage = document.getElementById("stage");
    const host = stage || document.body;

    canvas = document.createElement("canvas");
    canvas.id = "signal-fractal-canvas";
    scrim = document.createElement("div");
    scrim.id = "signal-fractal-scrim";
    // spotlight.html/intel.html already darken further via their own
    // scanline+vignette overlays, so #stage needs a lighter scrim
    // underneath to land at the same effective legibility as flat pages.
    if (stage) scrim.style.background = "rgba(5, 7, 10, 0.55)";

    host.prepend(scrim);
    host.prepend(canvas);

    gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return; // CSS fallback gradient on #signal-fractal-canvas (theme.css) carries it

    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = (vs && fs) ? gl.createProgram() : null;
    if (!program) return;

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, "u_resolution");
    const uTime = gl.getUniformLocation(program, "u_time");
    const uMouse = gl.getUniformLocation(program, "u_mouse");

    let mouseX = 0, mouseY = 0, targetX = 0, targetY = 0;
    pointerHandler = (e) => {
      targetX = (e.clientX / window.innerWidth) * 2 - 1;
      targetY = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("pointermove", pointerHandler, { passive: true });

    // Internal render resolution capped well below display size -- a
    // full-screen per-pixel fractal iterated up to 140 times is needlessly
    // heavy at native device pixel ratio on a large panel for what's purely
    // a background decoration. CSS stretches the low-res canvas back up.
    const MAX_RENDER_DIM = 900;
    function resize() {
      const w = window.innerWidth, h = window.innerHeight;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      const scale = Math.min(1, MAX_RENDER_DIM / Math.max(w, h));
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resizeHandler = resize;
    window.addEventListener("resize", resizeHandler);
    resize();

    const start = performance.now();
    function frame(now) {
      const t = (now - start) / 1000;
      mouseX += (targetX - mouseX) * 0.03;
      mouseY += (targetY - mouseY) * 0.03;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, t);
      gl.uniform2f(uMouse, mouseX, mouseY);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!REDUCED_MOTION) rafId = requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // A lost WebGL context (GPU driver reset, mobile tab backgrounding,
    // etc.) would otherwise leave the last rendered frame frozen -- fall
    // back to the CSS gradient instead of a stuck image.
    contextLostHandler = (e) => {
      e.preventDefault();
      if (rafId) cancelAnimationFrame(rafId);
      canvas.style.background = "";
    };
    canvas.addEventListener("webglcontextlost", contextLostHandler);
  }

  // Not needed by locurio's single-theme page (this file's source), but
  // required here since the theme can toggle back to cyber/neutral at
  // runtime -- listeners and the RAF loop must actually stop, not just be
  // hidden behind a removed canvas.
  function unmount() {
    if (!canvas) return;
    if (rafId) cancelAnimationFrame(rafId);
    if (resizeHandler) window.removeEventListener("resize", resizeHandler);
    if (pointerHandler) window.removeEventListener("pointermove", pointerHandler);
    if (contextLostHandler) canvas.removeEventListener("webglcontextlost", contextLostHandler);
    canvas.remove();
    scrim.remove();
    canvas = null; scrim = null; gl = null; rafId = null;
    resizeHandler = null; pointerHandler = null; contextLostHandler = null;
  }

  function syncTheme() {
    const active = document.documentElement.getAttribute(THEME_ATTR) === "fractal";
    if (active) mount(); else unmount();
  }

  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [THEME_ATTR],
  });
})();
