
const toggleListening = document.getElementById("toggle-listening");
const listeningStatus = document.getElementById("listening-status");
const sargamNote = document.getElementById("sargam-note");     // the BIG note
const westernNote = document.getElementById("western-note");   // the small note
const frequencyText = document.getElementById("frequency");
const centsValue = document.getElementById("cents-value");
const centsIndicator = document.getElementById("cents-indicator");
const pitchLine = document.getElementById("pitch-line");
const currentPitch = document.getElementById("current-pitch");

const FFT_SIZE = 4096;         
const MIN_FREQ = 70;            
const MAX_FREQ = 1000;          
const YIN_THRESHOLD = 0.2;      
const GATE_RMS = 0.01;          
const HOLD_MS = 250;            
const TRAIL_MS = 6000;          
const SMOOTHING = 5;            


const SWARAS = ["Sa", "re", "Re", "ga", "Ga", "Ma", "ma", "Pa", "dha", "Dha", "ni", "Ni"];


const SWARA_SEMITONES = [0, 2, 4, 5, 7, 9, 11, 12];  
const GRAPH_TOP = 10;
const GRAPH_BOTTOM = 140;
const GRAPH_LEFT = 30;
const GRAPH_RIGHT = 500;
const STEP_HEIGHT = (GRAPH_BOTTOM - GRAPH_TOP) / 7;

// ---- State ----
let listening = false;
let starting = false;
let micStream = null;
let micSource = null;
let micGain = null;
let analyser = null;
let samples = null;
let frameId = null;
let frameCount = 0;
let recentReadings = [];   // last few semitone readings, for smoothing
let points = [];           // the trail: { t: time in ms, y: graph y or null for a gap }
let lastPitchTime = 0;


let yinBuffer = null;

function detectPitch(data, sampleRate) {
    const windowSize = FFT_SIZE / 2;
    const tauMin = Math.floor(sampleRate / MAX_FREQ);
    const tauMax = Math.floor(sampleRate / MIN_FREQ);

    if (tauMax + windowSize > data.length) {
        return null;
    }
    if (yinBuffer === null || yinBuffer.length !== tauMax + 1) {
        yinBuffer = new Float32Array(tauMax + 1);
    }

    
    yinBuffer[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
        let sum = 0;
        for (let j = 0; j < windowSize; j++) {
            const diff = data[j] - data[j + tau];
            sum += diff * diff;
        }
        runningSum += sum;
        yinBuffer[tau] = runningSum === 0 ? 1 : (sum * tau) / runningSum;
    }

    
    let tau = tauMin;
    let found = false;
    while (tau < tauMax) {
        if (yinBuffer[tau] < YIN_THRESHOLD) {
            while (tau + 1 < tauMax && yinBuffer[tau + 1] < yinBuffer[tau]) {
                tau++;
            }
            found = true;
            break;
        }
        tau++;
    }
    if (!found) {
        return null;
    }

 
    const s0 = yinBuffer[tau - 1];
    const s1 = yinBuffer[tau];
    const s2 = yinBuffer[tau + 1];
    const denominator = s0 - 2 * s1 + s2;
    const shift = denominator === 0 ? 0 : (s0 - s2) / (2 * denominator);

    return sampleRate / (tau + shift);
}


function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function getMicGainValue() {
    // slider 0..100  ->  0.5x .. 20x
    return 0.5 * Math.pow(40, micSensitivity.value / 100);
}


function semitonesToY(rel) {
    let low;
    if (rel <= 0) {
        low = 0;
    } else if (rel >= 12) {
        low = 6;
    } else {
        low = 0;
        while (rel >= SWARA_SEMITONES[low + 1]) {
            low++;
        }
    }
    const a = SWARA_SEMITONES[low];
    const b = SWARA_SEMITONES[low + 1];
    const position = low + (rel - a) / (b - a);     // 0 = Sa ... 7 = Sa'
    const y = GRAPH_BOTTOM - position * STEP_HEIGHT;
    return Math.min(148, Math.max(2, y));
}


function showWaiting() {
    sargamNote.textContent = "- -";
    westernNote.textContent = "-";
    frequencyText.textContent = "waiting for pitch";
    centsValue.textContent = "_ cents";
    centsIndicator.style.left = "50%";
    centsIndicator.style.background = "";
}

function showPitch(frequency, now) {
    const saFrequency = getSelectedFrequency();
    const saMidi = 12 * (Number(octaveSelect.value) + 1) + notes.indexOf(saSelect.value);

    const rel = 12 * Math.log2(frequency / saFrequency);

    recentReadings.push(rel);
    if (recentReadings.length > SMOOTHING) {
        recentReadings.shift();
    }
    const smooth = median(recentReadings);

    const nearest = Math.round(smooth);
    const cents = (smooth - nearest) * 100;

    const swara = SWARAS[((nearest % 12) + 12) % 12];
    const midi = saMidi + nearest;
    const western = notes[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

    if (currentNotation === "sargam") {
        sargamNote.textContent = swara;
        westernNote.textContent = western;
    } else {
        sargamNote.textContent = western;
        westernNote.textContent = swara;
    }

    frequencyText.textContent = frequency.toFixed(1) + " Hz";

    const rounded = Math.round(cents);
    const sign = rounded < 0 ? "−" : "+";
    centsValue.textContent = sign + Math.abs(rounded) + " cents";

    centsIndicator.style.left = (50 + cents) + "%";
    centsIndicator.style.background = Math.abs(cents) <= 20 ? "" : "#fb8500";

    points.push({ t: now, y: semitonesToY(smooth) });
    lastPitchTime = now;
}

function drawTrail(now) {
    const cutoff = now - TRAIL_MS;
    while (points.length > 0 && points[0].t < cutoff) {
        points.shift();
    }

    let d = "";
    let penDown = false;
    for (const point of points) {
        if (point.y === null) {
            penDown = false;
            continue;
        }
        const x = GRAPH_LEFT + ((point.t - cutoff) / TRAIL_MS) * (GRAPH_RIGHT - GRAPH_LEFT);
        d += (penDown ? " L" : " M") + x.toFixed(1) + " " + point.y.toFixed(1);
        penDown = true;
    }
    pitchLine.setAttribute("d", d);

    const last = points[points.length - 1];
    if (last && last.y !== null && now - last.t < 300) {
        currentPitch.setAttribute("cx", GRAPH_LEFT + ((last.t - cutoff) / TRAIL_MS) * (GRAPH_RIGHT - GRAPH_LEFT));
        currentPitch.setAttribute("cy", last.y);
        currentPitch.setAttribute("r", 5);
    } else {
        currentPitch.setAttribute("r", 0);
    }
}

function clearDisplay() {
    showWaiting();
    points = [];
    recentReadings = [];
    pitchLine.setAttribute("d", "");
    currentPitch.setAttribute("r", 0);
}

function analyseMic(now) {
    analyser.getFloatTimeDomainData(samples);

    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
        sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    const frequency = rms < GATE_RMS ? null : detectPitch(samples, audioCtx.sampleRate);

    if (frequency !== null) {
        showPitch(frequency, now);
    } else if (now - lastPitchTime > HOLD_MS) {
        showWaiting();
        recentReadings = [];
        const last = points[points.length - 1];
        if (last && last.y !== null) {
            points.push({ t: now, y: null });   // break the line
        }
    }
}

function update() {
    frameId = requestAnimationFrame(update);
    frameCount++;
    const now = performance.now();

    if (frameCount % 2 === 0) {      // analyse ~30 times a second, draw every frame
        analyseMic(now);
    }
    drawTrail(now);
}


async function startListening() {
    if (starting || listening) {
        return;
    }
    starting = true;

    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: true
            }
        });
    } catch (error) {
        console.log("Microphone not available:", error);
        listeningStatus.textContent = "Mic blocked - check permissions";
        starting = false;
        return;
    }

    ensureAudio();
    await audioCtx.resume();

    micSource = audioCtx.createMediaStreamSource(micStream);
    micGain = audioCtx.createGain();
    micGain.gain.value = getMicGainValue();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    samples = new Float32Array(FFT_SIZE);

    micSource.connect(micGain);
    micGain.connect(analyser);

    clearDisplay();
    lastPitchTime = 0;
    frameCount = 0;
    listening = true;
    starting = false;

    listeningStatus.textContent = "Listening";
    toggleListening.textContent = "Stop listening";
    frameId = requestAnimationFrame(update);
}

function stopListening() {
    listening = false;
    cancelAnimationFrame(frameId);

    micStream.getTracks().forEach(track => track.stop());
    micSource.disconnect();
    micGain.disconnect();
    micStream = null;
    micSource = null;
    micGain = null;
    analyser = null;

    clearDisplay();
    listeningStatus.textContent = "Start Singing";
    toggleListening.textContent = "Start listening";
}

toggleListening.addEventListener("click", () => {
    if (listening) {
        stopListening();
    } else {
        startListening();
    }
});

micSensitivity.addEventListener("input", () => {
    if (micGain !== null) {
        micGain.gain.setTargetAtTime(getMicGainValue(), audioCtx.currentTime, 0.05);
    }
    saveSettings();
});

clearDisplay();
