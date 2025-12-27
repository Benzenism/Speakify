(() => {
  const ORIGIN_PROJECT_URL = "https://github.com/Spu7Nix/obamify";
  const CREATOR_GITHUB_URL = "https://github.com/Benzenism/Speakify";
  const CREATOR_YOUTUBE_URL = "https://www.youtube.com/watch?v=yBihj5P3pWU";

  document.getElementById("originBtn").href = ORIGIN_PROJECT_URL;
  document.getElementById("creatorGitBtn").href = CREATOR_GITHUB_URL;
  document.getElementById("creatorYouBtn").href = CREATOR_YOUTUBE_URL;

  const DEFAULT_SRC_IMG = "ner.jpg";
  const DEFAULT_TGT_IMG = "speaki.png";
  const DEFAULT_MP3     = "dontNerSpeaki.mp3";

  const N = 256;
  const PULL = 15.0;
  const SWIRL = 10.0;
  const STEPS_PER_FRAME = 2;
  const POINT_MUL = 1.0;
  const EPS = 0.001;
  const NEED_STREAK = 30;

  const SPEED_START = 0.01;
  const SPEED_END   = 0.75;
  const SPEED_RAMP_SECONDS = 20.0;

  const CHECK_EVERY_N_FRAMES = 10;

  const $ = (id) => document.getElementById(id);

  const srcFile = $("srcFile");
  const tgtFile = $("tgtFile");
  const mp3File = $("mp3File");

  const runBtn  = $("runBtn");
  const stopBtn = $("stopBtn");
  const dlBtn   = $("downloadBtn");

  const canvas = $("glCanvas");
  const srcC = $("srcC");
  const tgtC = $("tgtC");
  const doneAudio = $("doneAudio");

  let srcObjUrl = null;
  let tgtObjUrl = null;
  let mp3ObjUrl = null;

  let gl = null;

  let raf = null;
  let running = false;
  let lastT = 0;
  let startT = 0;

  let progUpdate = null, progRender = null;
  let vaoUpdate = [null, null];
  let vaoRender = [null, null];
  let posBuf = [null, null];
  let targetBuf = null, seedBuf = null, colorBuf = null;
  let tf = [null, null];
  let count = 0;
  let ping = 0;

  let cpuTarget = null;
  let cpuPosReadback = null;

  let belowStreak = 0;
  let mp3Triggered = false;

  let idleSrcData = null;

  function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
  function smoothstep01(x){ x = clamp(x,0,1); return x*x*(3 - 2*x); }

  function stopEverything() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;

    doneAudio.pause();
    doneAudio.currentTime = 0;
  }

  function resizeCanvasToDisplaySize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      if (gl) gl.viewport(0, 0, w, h);
    }
  }

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("Shader compile error:\n" + log);
    }
    return sh;
  }

  function linkProgram(vsSrc, fsSrc, transformVaryings) {
    const vs = compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    if (transformVaryings) gl.transformFeedbackVaryings(p, transformVaryings, gl.SEPARATE_ATTRIBS);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error("Program link error:\n" + log);
    }
    return p;
  }

  function initWebGL2() {
    if (gl) return;

    gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true
    });

    if (!gl) throw new Error("This Browser is not Supporting WebGL2");

    resizeCanvasToDisplaySize();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const vsUpdate = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_target;
layout(location=2) in float a_seed;
uniform float u_dt;
uniform float u_pull;
uniform float u_swirl;
uniform float u_time;
out vec2 v_newPos;
void main() {
  vec2 toT = a_target - a_pos;
  vec2 sw = vec2(-toT.y, toT.x);
  float s = sin(u_time * 2.0 + a_seed * 6.2831853);
  float swirlDecay = exp(-u_time * 0.25);
  vec2 vel = toT * u_pull + sw * (u_swirl * s * swirlDecay);
  vec2 p = a_pos + vel * u_dt;
  p = clamp(p, vec2(-1.2), vec2(1.2));
  v_newPos = p;
}`;
    const fsUpdate = `#version 300 es
precision highp float;
out vec4 outColor;
void main(){ outColor = vec4(0.0); }`;
    progUpdate = linkProgram(vsUpdate, fsUpdate, ["v_newPos"]);

    const vsRender = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_color;
uniform float u_pointSize;
out vec4 v_color;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  gl_PointSize = u_pointSize;
  v_color = a_color;
}`;
    const fsRender = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 outColor;
void main(){ outColor = v_color; }`;
    progRender = linkProgram(vsRender, fsRender, null);
  }

  function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image Load Failed: " + url));
      img.src = url;
    });
  }

  function drawToCanvas(img, canvas2d, w, h) {
    canvas2d.width = w; canvas2d.height = h;
    const ctx = canvas2d.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0,0,w,h);
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0,0,w,h);
  }

  function luma(r,g,b){ return 0.2126*r + 0.7152*g + 0.0722*b; }
  function makeIndexArray(n){ const a = new Array(n); for (let i=0;i<n;i++) a[i]=i; return a; }

  function buildPermutationByLumaSort(srcData, tgtData) {
    const n = N*N;
    const s = srcData.data;
    const t = tgtData.data;

    const srcIdx = makeIndexArray(n);
    const tgtIdx = makeIndexArray(n);

    const srcL = new Float32Array(n);
    const tgtL = new Float32Array(n);

    for (let i=0;i<n;i++) {
      const si = i*4;
      srcL[i] = luma(s[si], s[si+1], s[si+2]);
      tgtL[i] = luma(t[si], t[si+1], t[si+2]);
    }

    srcIdx.sort((a,b) => srcL[a] - srcL[b]);
    tgtIdx.sort((a,b) => tgtL[a] - tgtL[b]);

    const map = new Int32Array(n);
    for (let k=0;k<n;k++) map[srcIdx[k]] = tgtIdx[k];
    return map;
  }

  function idxToClipPos(i) {
    const x = i % N;
    const y = (i / N) | 0;
    const u = (x + 0.5) / N;
    const v = (y + 0.5) / N;
    return [u * 2 - 1, 1 - v * 2];
  }

  function destroyGLObjects() {
    for (const v of vaoUpdate) if (v) gl.deleteVertexArray(v);
    for (const v of vaoRender) if (v) gl.deleteVertexArray(v);
    for (const b of posBuf) if (b) gl.deleteBuffer(b);
    if (targetBuf) gl.deleteBuffer(targetBuf);
    if (seedBuf) gl.deleteBuffer(seedBuf);
    if (colorBuf) gl.deleteBuffer(colorBuf);
    for (const t of tf) if (t) gl.deleteTransformFeedback(t);

    vaoUpdate = [null, null];
    vaoRender = [null, null];
    posBuf = [null, null];
    targetBuf = seedBuf = colorBuf = null;
    tf = [null, null];
  }

  function createOrResetBuffers(srcData, map) {
    stopEverything();

    belowStreak = 0;
    mp3Triggered = false;

    if (vaoUpdate[0] || vaoRender[0] || posBuf[0] || targetBuf) destroyGLObjects();

    vaoUpdate = [gl.createVertexArray(), gl.createVertexArray()];
    vaoRender = [gl.createVertexArray(), gl.createVertexArray()];
    posBuf = [gl.createBuffer(), gl.createBuffer()];
    targetBuf = gl.createBuffer();
    seedBuf = gl.createBuffer();
    colorBuf = gl.createBuffer();
    tf = [gl.createTransformFeedback(), gl.createTransformFeedback()];

    count = N * N;

    const pos0 = new Float32Array(count * 2);
    const pos1 = new Float32Array(count * 2);
    const target = new Float32Array(count * 2);
    const seed = new Float32Array(count);
    const colors = new Uint8Array(count * 4);

    for (let i=0;i<count;i++) {
      const [x,y] = idxToClipPos(i);
      pos0[i*2] = x; pos0[i*2+1] = y;
      pos1[i*2] = x; pos1[i*2+1] = y;

      const tIdx = map[i];
      const [tx,ty] = idxToClipPos(tIdx);
      target[i*2] = tx; target[i*2+1] = ty;

      seed[i] = (i * 0.61803398875) % 1.0;

      const si = i * 4;
      colors[si]   = srcData.data[si];
      colors[si+1] = srcData.data[si+1];
      colors[si+2] = srcData.data[si+2];
      colors[si+3] = 255;
    }

    cpuTarget = target;
    cpuPosReadback = new Float32Array(count * 2);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf[0]);
    gl.bufferData(gl.ARRAY_BUFFER, pos0, gl.DYNAMIC_COPY);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf[1]);
    gl.bufferData(gl.ARRAY_BUFFER, pos1, gl.DYNAMIC_COPY);

    gl.bindBuffer(gl.ARRAY_BUFFER, targetBuf);
    gl.bufferData(gl.ARRAY_BUFFER, target, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf);
    gl.bufferData(gl.ARRAY_BUFFER, seed, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    for (let i=0;i<2;i++) {
      gl.bindVertexArray(vaoUpdate[i]);

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf[i]);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, targetBuf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);

      gl.bindVertexArray(vaoRender[i]);

      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf[i]);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    }

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    ping = 0;
  }

  function renderOnce() {
    resizeCanvasToDisplaySize();

    gl.clearColor(0,0,0,1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(progRender);

    const base = Math.min(canvas.width, canvas.height) / N;
    const pointSize = Math.max(1.0, base * POINT_MUL);
    gl.uniform1f(gl.getUniformLocation(progRender, "u_pointSize"), pointSize);

    gl.bindVertexArray(vaoRender[ping]);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.bindVertexArray(null);
  }

  function stepSimulation(dt, timeSec) {
    const srcIdx = ping;
    const dstIdx = 1 - ping;

    gl.useProgram(progUpdate);
    gl.uniform1f(gl.getUniformLocation(progUpdate, "u_dt"), dt);
    gl.uniform1f(gl.getUniformLocation(progUpdate, "u_pull"), PULL);
    gl.uniform1f(gl.getUniformLocation(progUpdate, "u_swirl"), SWIRL);
    gl.uniform1f(gl.getUniformLocation(progUpdate, "u_time"), timeSec);

    gl.bindVertexArray(vaoUpdate[srcIdx]);

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf[dstIdx]);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, posBuf[dstIdx]);

    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);

    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);

    ping = dstIdx;
  }

  function computeMSEFromGPU() {
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf[ping]);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, cpuPosReadback);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    let sum = 0.0;
    for (let i=0;i<count;i++) {
      const px = cpuPosReadback[i*2], py = cpuPosReadback[i*2+1];
      const tx = cpuTarget[i*2], ty = cpuTarget[i*2+1];
      const dx = px - tx, dy = py - ty;
      sum += dx*dx + dy*dy;
    }
    return sum / count;
  }

  async function tryUnlockAudio() {
    if (!doneAudio.src) return;
    try {
      doneAudio.muted = true;
      await doneAudio.play();
      doneAudio.pause();
      doneAudio.currentTime = 0;
      doneAudio.muted = false;
    } catch {
      doneAudio.muted = false;
    }
  }

  async function playMp3Once() {
    if (!doneAudio.src) return;
    if (mp3Triggered) return;
    mp3Triggered = true;

    try {
      doneAudio.currentTime = 0;
      await doneAudio.play();
    } catch (e) {
      console.warn("Audio play blocked:", e);
    }
  }

  function loop() {
    running = true;
    lastT = performance.now();
    startT = lastT;

    let frameCount = 0;

    const frame = async (now) => {
      if (!running) return;

      const rawDt = (now - lastT) / 1000;
      lastT = now;

      const tSec = (now - startT) / 1000;
      const a = smoothstep01(tSec / SPEED_RAMP_SECONDS);
      const speed = SPEED_START + (SPEED_END - SPEED_START) * a;

      const dt = clamp(rawDt * speed, 0.0, 0.05);
      const sdt = dt / STEPS_PER_FRAME;

      for (let i=0;i<STEPS_PER_FRAME;i++) stepSimulation(sdt, tSec + i*sdt);
      renderOnce();

      frameCount++;
      if (frameCount % CHECK_EVERY_N_FRAMES === 0 && cpuTarget && cpuPosReadback) {
        const mse = computeMSEFromGPU();
        if (mse <= EPS) belowStreak++;
        else belowStreak = 0;

        if (!mp3Triggered && belowStreak >= NEED_STREAK) {
          await playMp3Once();
        }
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
  }

  srcFile?.addEventListener("change", () => {
    const f = srcFile.files?.[0];
    if (srcObjUrl) URL.revokeObjectURL(srcObjUrl);
    srcObjUrl = f ? URL.createObjectURL(f) : null;
    initIdle().catch((e) => alert(String(e?.message || e)));
  });

  tgtFile?.addEventListener("change", () => {
    const f = tgtFile.files?.[0];
    if (tgtObjUrl) URL.revokeObjectURL(tgtObjUrl);
    tgtObjUrl = f ? URL.createObjectURL(f) : null;
  });

  mp3File?.addEventListener("change", () => {
    const f = mp3File.files?.[0];
    if (mp3ObjUrl) URL.revokeObjectURL(mp3ObjUrl);
    mp3ObjUrl = f ? URL.createObjectURL(f) : null;

    doneAudio.src = mp3ObjUrl || DEFAULT_MP3;
    doneAudio.load();
  });

  async function initIdle() {
    initWebGL2();

    const srcUrl = srcObjUrl || DEFAULT_SRC_IMG;
    const srcImg = await loadImageFromUrl(srcUrl);
    const srcData = drawToCanvas(srcImg, srcC, N, N);
    idleSrcData = srcData;

    const map = new Int32Array(N*N);
    for (let i=0;i<N*N;i++) map[i] = i;

    createOrResetBuffers(srcData, map);
    renderOnce();
    dlBtn.disabled = true;
  }

  runBtn.addEventListener("click", async () => {
    try {
      stopEverything();
      initWebGL2();

      if (!doneAudio.src) doneAudio.src = DEFAULT_MP3;
      doneAudio.load();
      await tryUnlockAudio();

      const srcUrl = srcObjUrl || DEFAULT_SRC_IMG;
      const tgtUrl = tgtObjUrl || DEFAULT_TGT_IMG;

      const [srcImg, tgtImg] = await Promise.all([
        loadImageFromUrl(srcUrl),
        loadImageFromUrl(tgtUrl)
      ]);

      const srcData = drawToCanvas(srcImg, srcC, N, N);
      const tgtData = drawToCanvas(tgtImg, tgtC, N, N);
      idleSrcData = srcData;

      const map = buildPermutationByLumaSort(srcData, tgtData);
      createOrResetBuffers(srcData, map);

      dlBtn.disabled = false;

      belowStreak = 0;
      mp3Triggered = false;

      loop();
    } catch (e) {
      console.error(e);
      alert(String(e?.message || e));
      try { await initIdle(); } catch {}
    }
  });

  stopBtn.addEventListener("click", async () => {
    try {
      stopEverything();
      if (!idleSrcData) {
        await initIdle();
        return;
      }
      const map = new Int32Array(N*N);
      for (let i=0;i<N*N;i++) map[i] = i;
      createOrResetBuffers(idleSrcData, map);
      renderOnce();
      dlBtn.disabled = true;
    } catch (e) {
      console.error(e);
    }
  });

  dlBtn.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = "speakify.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  });

  window.addEventListener("resize", () => {
    if (!gl) return;
    resizeCanvasToDisplaySize();
    if (!running && idleSrcData) renderOnce();
  });

  doneAudio.src = DEFAULT_MP3;
  doneAudio.load();
  initIdle().catch((e) => {
    console.error(e);
    alert("File Location Error");
  });

})();




