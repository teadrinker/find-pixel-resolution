
const canvas = document.getElementById('gl-canvas');
const dropZone = document.getElementById('drop-zone');
const instruction = document.getElementById('instruction');
const resultsDiv = document.getElementById('results');
const maxScaleInput = document.getElementById('max-scale');
const sampleCenterCheckbox = document.getElementById('sample-center');

const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
if (!gl) {
    alert("WebGL 2 not supported");
}

// Extensions
const ext = gl.getExtension('EXT_color_buffer_float');
if (!ext) {
    console.error("EXT_color_buffer_float not supported");
}

let imageTexture = null;
let imgWidth = 0;
let imgHeight = 0;
let animationId = null;
let lastResult = null;
let showReconstructed = false;
let lastToggleTime = 0;
const TOGGLE_INTERVAL = 1000; // ms

// Shaders
function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(gl, vsSrc, fsSrc) {
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(prog));
        return null;
    }
    return prog;
}

const vsSource = `#version 300 es
in vec4 position;
void main() {
    gl_Position = position;
}
`;

const fsDisplaySource = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uResolution;
uniform float uScaleX;
uniform float uOffsetX;
uniform float uScaleY;
uniform float uOffsetY;
uniform bool uShowReconstructed;
uniform bool uSampleCenterOnly;

out vec4 outColor;
void main() {
    float x = gl_FragCoord.x;
    float y = gl_FragCoord.y;
    
    if (uShowReconstructed && uScaleX > 1.0 && uScaleY > 1.0) {
        // Calculate Grid Index
        float kx = floor((x - uOffsetX) / uScaleX);
        float ky = floor((y - uOffsetY) / uScaleY);
        
        // Center of the grid cell
        float centerX = uOffsetX + kx * uScaleX + uScaleX * 0.5;
        float centerY = uOffsetY + ky * uScaleY + uScaleY * 0.5;
        
        if (uSampleCenterOnly) {
             // Nearest Neighbor from Center
             vec2 samplePos = vec2(centerX, centerY) / uResolution;
             outColor = texture(uImage, samplePos);
        } else {
             // Box Filter (Average)
             // Radius 0.3 * Scale
             float rx = uScaleX * 0.3;
             float ry = uScaleY * 0.3;
             
             ivec2 texSize = textureSize(uImage, 0);
             int minX = max(0, int(ceil(centerX - rx)));
             int maxX = min(texSize.x - 1, int(floor(centerX + rx)));
             int minY = max(0, int(ceil(centerY - ry)));
             int maxY = min(texSize.y - 1, int(floor(centerY + ry)));
             
             vec4 sum = vec4(0.0);
             float count = 0.0;
             
             for(int sy = minY; sy <= maxY; sy++) {
                 for(int sx = minX; sx <= maxX; sx++) {
                     sum += texelFetch(uImage, ivec2(sx, sy), 0);
                     count += 1.0;
                 }
             }
             
             if (count > 0.0) {
                 outColor = sum / count;
             } else {
                 vec2 samplePos = vec2(centerX, centerY) / uResolution;
                 outColor = texture(uImage, samplePos);
             }
        }
    } else {
        // Original exact position
        vec2 samplePos = gl_FragCoord.xy / uResolution;
        outColor = texture(uImage, samplePos);
    }
}
`;

const fsColDiffSource = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform int uWidth;
uniform int uHeight;
out vec4 outColor;

void main() {
    int x = int(gl_FragCoord.x);
    if (x >= uWidth) { outColor = vec4(0); return; }
    
    float sum = 0.0;
    for (int y = 0; y < uHeight; y++) {
        vec4 c = texelFetch(uImage, ivec2(x, y), 0);
        int prevX = x > 0 ? x - 1 : 0;
        vec4 l = texelFetch(uImage, ivec2(prevX, y), 0);
        vec3 diff = abs(c.rgb - l.rgb);
        sum += diff.r + diff.g + diff.b;
    }
    outColor = vec4(sum, 0, 0, 1);
}
`;

const fsRowDiffSource = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform int uWidth;
uniform int uHeight;
out vec4 outColor;

void main() {
    int y = int(gl_FragCoord.y);
    if (y >= uHeight) { outColor = vec4(0); return; }
    
    float sum = 0.0;
    for (int x = 0; x < uWidth; x++) {
        vec4 c = texelFetch(uImage, ivec2(x, y), 0);
        int prevY = y > 0 ? y - 1 : 0;
        vec4 t = texelFetch(uImage, ivec2(x, prevY), 0);
        vec3 diff = abs(c.rgb - t.rgb);
        sum += diff.r + diff.g + diff.b;
    }
    outColor = vec4(sum, 0, 0, 1);
}
`;

const fsDownsampleSource = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform float uScaleX;
uniform float uOffsetX;
uniform float uScaleY;
uniform float uOffsetY;
uniform float uGridOffsetX;
uniform float uGridOffsetY;
uniform int uTargetHeight;
uniform bool uSampleCenterOnly;

out vec4 outColor;

void main() {
    float kx = floor(gl_FragCoord.x) + uGridOffsetX;
    float ky = floor(gl_FragCoord.y) + uGridOffsetY;
    
    float centerX = uOffsetX + kx * uScaleX + uScaleX * 0.5;
    float centerY = uOffsetY + ky * uScaleY + uScaleY * 0.5;
    
    if (uSampleCenterOnly) {
         ivec2 texSize = textureSize(uImage, 0);
         int cx = clamp(int(centerX), 0, texSize.x - 1);
         int cy = clamp(int(centerY), 0, texSize.y - 1);
         outColor = texelFetch(uImage, ivec2(cx, cy), 0);
    } else {
         float rx = uScaleX * 0.3;
         float ry = uScaleY * 0.3;
         
         ivec2 texSize = textureSize(uImage, 0);
         int minX = max(0, int(ceil(centerX - rx)));
         int maxX = min(texSize.x - 1, int(floor(centerX + rx)));
         int minY = max(0, int(ceil(centerY - ry)));
         int maxY = min(texSize.y - 1, int(floor(centerY + ry)));
         
         vec4 sum = vec4(0.0);
         float count = 0.0;
         
         for(int sy = minY; sy <= maxY; sy++) {
             for(int sx = minX; sx <= maxX; sx++) {
                 sum += texelFetch(uImage, ivec2(sx, sy), 0);
                 count += 1.0;
             }
         }
         
         if (count > 0.0) {
             outColor = sum / count;
         } else {
             int cx = clamp(int(centerX), 0, texSize.x - 1);
             int cy = clamp(int(centerY), 0, texSize.y - 1);
             outColor = texelFetch(uImage, ivec2(cx, cy), 0);
         }
    }
}
`;

const programDisplay = createProgram(gl, vsSource, fsDisplaySource);
const programCol = createProgram(gl, vsSource, fsColDiffSource);
const programRow = createProgram(gl, vsSource, fsRowDiffSource);
const programDownsample = createProgram(gl, vsSource, fsDownsampleSource);

// Quad Buffer
const positionBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
    1, -1,
    -1, 1,
    -1, 1,
    1, -1,
    1, 1,
]), gl.STATIC_DRAW);

// FBOs
let fboCol = null;
let texCol = null;
let fboRow = null;
let texRow = null;

function setupFBOs(w, h) {
    if (fboCol) gl.deleteFramebuffer(fboCol);
    if (texCol) gl.deleteTexture(texCol);
    if (fboRow) gl.deleteFramebuffer(fboRow);
    if (texRow) gl.deleteTexture(texRow);

    // Col Diffs: Width x 1
    texCol = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texCol);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, 1, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    fboCol = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboCol);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texCol, 0);

    // Row Diffs: 1 x Height
    texRow = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texRow);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, h, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    fboRow = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboRow);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texRow, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function processImage(imageBitmap) {
    imgWidth = imageBitmap.width;
    imgHeight = imageBitmap.height;

    // Set Canvas Size
    canvas.width = imgWidth;
    canvas.height = imgHeight;
    canvas.style.display = 'block';

    // Setup Texture
    if (imageTexture) gl.deleteTexture(imageTexture);
    imageTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageBitmap);

    setupFBOs(imgWidth, imgHeight);

    document.getElementById('download-lowres-btn').disabled = false;
    runAnalysis();

    // Start interval
    if (animationId) clearInterval(animationId);
    animationId = setInterval(runAnalysis, 1000);
}

function runAnalysis() {
    if (!imageTexture) return;

    // 1. Col Diffs
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboCol);
    gl.viewport(0, 0, imgWidth, 1);
    gl.useProgram(programCol);

    // Attributes need to be rebound/enabled for each program if context state changed (VAOs help here but simplistic approach)
    let positionLoc = gl.getAttribLocation(programCol, "position");
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1i(gl.getUniformLocation(programCol, "uWidth"), imgWidth);
    gl.uniform1i(gl.getUniformLocation(programCol, "uHeight"), imgHeight);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const colData = new Float32Array(imgWidth);
    gl.readPixels(0, 0, imgWidth, 1, gl.RED, gl.FLOAT, colData);

    // 2. Row Diffs
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboRow);
    gl.viewport(0, 0, 1, imgHeight);
    gl.useProgram(programRow);

    positionLoc = gl.getAttribLocation(programRow, "position");
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1i(gl.getUniformLocation(programRow, "uWidth"), imgWidth);
    gl.uniform1i(gl.getUniformLocation(programRow, "uHeight"), imgHeight);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const rowData = new Float32Array(imgHeight);
    gl.readPixels(0, 0, 1, imgHeight, gl.RED, gl.FLOAT, rowData);

    // 3. Analyze Data (CPU)
    const maxScale = parseInt(maxScaleInput.value) || 16;
    const resX = analyzePeriodicity(colData, maxScale);
    const resY = analyzePeriodicity(rowData, maxScale);

    lastResult = { resX, resY };
    updateUI(resX, resY);

    // 4. Draw Image to Screen (Alternating)
    const now = performance.now();
    if (now - lastToggleTime > TOGGLE_INTERVAL) {
        showReconstructed = !showReconstructed;
        lastToggleTime = now;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, imgWidth, imgHeight);
    gl.useProgram(programDisplay);

    positionLoc = gl.getAttribLocation(programDisplay, "position");
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(gl.getUniformLocation(programDisplay, "uResolution"), imgWidth, imgHeight);
    gl.uniform1i(gl.getUniformLocation(programDisplay, "uImage"), 0);

    // Pass Params
    gl.uniform1f(gl.getUniformLocation(programDisplay, "uScaleX"), resX.scale);
    gl.uniform1f(gl.getUniformLocation(programDisplay, "uOffsetX"), resX.offset);
    gl.uniform1f(gl.getUniformLocation(programDisplay, "uScaleY"), resY.scale);
    gl.uniform1f(gl.getUniformLocation(programDisplay, "uOffsetY"), resY.offset);
    gl.uniform1i(gl.getUniformLocation(programDisplay, "uShowReconstructed"), showReconstructed ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(programDisplay, "uSampleCenterOnly"), sampleCenterCheckbox.checked ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // UI Update (with current view state)
    // We only update if periodicity didn't drift, but for now just update always
    updateUI(resX, resY, showReconstructed);
}

function updateUI(resX, resY, isReconstructed) {
    const minGridX = Math.floor((0 - resX.offset) / resX.scale);
    const maxGridX = Math.floor((imgWidth - 1 - resX.offset) / resX.scale);
    const recW = maxGridX - minGridX + 1;

    const minGridY = Math.floor((0 - resY.offset) / resY.scale);
    const maxGridY = Math.floor((imgHeight - 1 - resY.offset) / resY.scale);
    const recH = maxGridY - minGridY + 1;

    const viewMode = isReconstructed ? "RECONSTRUCTED (Upscaled)" : "ORIGINAL INPUT";

    resultsDiv.innerHTML = `
        <div style="background:#000; color:#fff; padding:5px; margin-bottom:10px; font-weight:bold; text-align:center;">
            Showing: ${viewMode}
        </div>
        <strong>X:</strong> Scale ${resX.scale.toFixed(3)}, Offset ${resX.offset.toFixed(3)} <small title="Confidence">(${resX.confidence.toFixed(2)})</small><br>
        <strong>Y:</strong> Scale ${resY.scale.toFixed(3)}, Offset ${resY.offset.toFixed(3)} <small title="Confidence">(${resY.confidence.toFixed(2)})</small><br>
        <strong>Reconstructed:</strong> ${recW} x ${recH} px<br>
    `;
}

// Drag & Drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    instruction.style.display = 'none';

    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
        createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'flipY' }).then(processImage).catch(err => {
            console.error(err);
            alert("Could not load image");
        });
    }
});


// Download Low Res
document.getElementById('download-lowres-btn').addEventListener('click', () => {
    if (!imageTexture || !lastResult) return;

    const scaleX = lastResult.resX.scale;
    const scaleY = lastResult.resY.scale;

    if (scaleX < 1.5 || scaleY < 1.5) {
        alert("Scale too small to downsample");
        return;
    }

    const minGridX = Math.floor((0 - lastResult.resX.offset) / scaleX);
    const maxGridX = Math.floor((imgWidth - 1 - lastResult.resX.offset) / scaleX);
    const newW = maxGridX - minGridX + 1;

    const minGridY = Math.floor((0 - lastResult.resY.offset) / scaleY);
    const maxGridY = Math.floor((imgHeight - 1 - lastResult.resY.offset) / scaleY);
    const newH = maxGridY - minGridY + 1;

    // Resize canvas to new size
    canvas.width = newW;
    canvas.height = newH;
    gl.viewport(0, 0, newW, newH);

    gl.useProgram(programDownsample);

    const positionLoc = gl.getAttribLocation(programDownsample, "position");
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1f(gl.getUniformLocation(programDownsample, "uScaleX"), scaleX);
    gl.uniform1f(gl.getUniformLocation(programDownsample, "uOffsetX"), lastResult.resX.offset);
    gl.uniform1f(gl.getUniformLocation(programDownsample, "uGridOffsetX"), minGridX);
    gl.uniform1f(gl.getUniformLocation(programDownsample, "uScaleY"), scaleY);
    gl.uniform1f(gl.getUniformLocation(programDownsample, "uOffsetY"), lastResult.resY.offset);
    gl.uniform1f(gl.getUniformLocation(programDownsample, "uGridOffsetY"), minGridY);
    gl.uniform1i(gl.getUniformLocation(programDownsample, "uTargetHeight"), newH);
    gl.uniform1i(gl.getUniformLocation(programDownsample, "uSampleCenterOnly"), sampleCenterCheckbox.checked ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(programDownsample, "uImage"), 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Download
    const link = document.createElement('a');
    link.download = 'recovered-pixel-art.png';
    // Use nearest neighbor for the data url if possible? or just default (png)
    link.href = canvas.toDataURL();
    link.click();

    // Restore
    canvas.width = imgWidth;
    canvas.height = imgHeight;
    // Analysis loop will restore viewport and content on next tick (or right now)
    runAnalysis();
});

// Redraw when max scale changes
maxScaleInput.addEventListener('change', () => {
    runAnalysis();
});

sampleCenterCheckbox.addEventListener('change', () => {
    runAnalysis();
});
