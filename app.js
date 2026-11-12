let audioCtx = null;
let masterGain = null;
let timerId = null;

// Tanpura settings
const STRING_RATIOS = [1.5, 1, 1, 0.5];   // Pa, Sa, Sa, low Sa
const PLUCK_GAP = 0.65;                    // seconds between plucks
const HARMONICS = 12;                      // overtones per string
const PLUCK_LEVEL = 0.15;                 // loudness of one pluck
const DECAY_TIME = 15;                     // seconds a pluck rings

// Extra tanpura "feel" - change one at a time and listen
const STRING_LEVELS = [1.0, 0.8, 0.8, 0.9];  // each string slightly different in loudness (x PLUCK_LEVEL)
const ATTACK_TIME = 0.08;                 // seconds for the pluck to reach full volume (soft finger pad)
const HARMONIC_DELAY = 0.03;              // each higher overtone arrives a little later (0 = all together)
const DETUNE_CENTS = 3;                   // tiny random pitch wobble per overtone, makes it shimmer
const TIMING_JITTER = 0.1;                // plucks are not perfectly evenly spaced (0 = robotic)
const REVERB_SECONDS = 2.5;               // size of the "room"
const REVERB_MIX = 0.3;                   // how much room sound is added (0 = none)

let nextStringIndex = 0;
let nextPluckTime = 0;
let reverbNode = null;   // the room (created once)
let tanpuraBus = null;   // all plucks of the current session go through this

const playDrone = document.getElementById("play-drone");
const saSelect = document.getElementById("sa-select");
const octaveSelect = document.getElementById("octave-select");
const droneVolume = document.getElementById("drone-volume");
const saRefer = document.getElementById("sa-refer");
const micSensitivity = document.getElementById("mic-sensitivity");

const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

let currentSound = "tanpura";
let currentNotation = "sargam";

const toggleButtons = document.querySelectorAll(
    ".segmented-control button"
);

const STORAGE_KEY = "kanthSettings";

function getFrequency(note, octave) {
    const index = notes.indexOf(note);
    
    if(index === -1) {
        return null;
    }

    const midi = 12 * (octave + 1) + index;
    const frequency = 440 * 2 ** ((midi - 69) / 12);

    return frequency;
}

console.log(getFrequency("C", 3));
console.log(getFrequency("C", 4));
console.log(getFrequency("D", 3));


function getSelectedFrequency() {
    return getFrequency(saSelect.value, Number(octaveSelect.value));
}

function updateSaLabel() {
    saRefer.textContent = saSelect.value + octaveSelect.value;
}

function handleNoteChange() {
    updateSaLabel();
    saveSettings();
}

updateSaLabel();
saSelect.addEventListener("change", handleNoteChange);
octaveSelect.addEventListener("change", handleNoteChange);

droneVolume.addEventListener("input", () => {
    if (masterGain !== null && timerId !== null) {
        masterGain.gain.setTargetAtTime(droneVolume.value / 100, audioCtx.currentTime, 0.05);
    }
    saveSettings();
});

function pluck(frequency, startTime, level) {
    for (let k = 1; k <= HARMONICS; k++) {
        const osc = audioCtx.createOscillator();
        const harmonicGain = audioCtx.createGain();

        osc.frequency.value = frequency * k;
        osc.detune.value = (Math.random() - 0.5) * 2 * DETUNE_CENTS;

        // each overtone: silent -> rises to its peak (higher ones peak later) -> long fade
        const peakTime = startTime + ATTACK_TIME + (k - 1) * HARMONIC_DELAY;
        harmonicGain.gain.setValueAtTime(0, startTime);
        harmonicGain.gain.linearRampToValueAtTime(level / k, peakTime);
        harmonicGain.gain.exponentialRampToValueAtTime(0.0001, startTime + DECAY_TIME);

        osc.connect(harmonicGain);
        harmonicGain.connect(tanpuraBus);

        osc.start(startTime);
        osc.stop(startTime + DECAY_TIME + 0.1);
    }
}


function scheduler() {
    while (nextPluckTime < audioCtx.currentTime + 0.5) {
        const saFrequency = getSelectedFrequency();
        pluck(
            saFrequency * STRING_RATIOS[nextStringIndex],
            nextPluckTime,
            PLUCK_LEVEL * STRING_LEVELS[nextStringIndex]
        );
        nextStringIndex = (nextStringIndex + 1) % STRING_RATIOS.length;
        nextPluckTime += PLUCK_GAP * (1 + (Math.random() - 0.5) * TIMING_JITTER);
    }
}


// A "room": random noise that fades away exponentially, used by a ConvolverNode
function makeRoomSound(seconds) {
    const length = Math.floor(audioCtx.sampleRate * seconds);
    const buffer = audioCtx.createBuffer(2, length, audioCtx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
        }
    }
    return buffer;
}

function ensureAudio() {
    if (audioCtx === null) {
        audioCtx = new AudioContext();
        masterGain = audioCtx.createGain();
        masterGain.connect(audioCtx.destination);

        // plucks -> bus -> (dry) master
        //                -> reverb -> wet -> master
        reverbNode = audioCtx.createConvolver();
        reverbNode.buffer = makeRoomSound(REVERB_SECONDS);
        const wetGain = audioCtx.createGain();
        wetGain.gain.value = REVERB_MIX;
        reverbNode.connect(wetGain);
        wetGain.connect(masterGain);
    }
}

playDrone.addEventListener("click", () => {
    if (timerId === null) {
        // START
        ensureAudio();
        audioCtx.resume();

        masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
        masterGain.gain.setValueAtTime(0, audioCtx.currentTime);
        masterGain.gain.linearRampToValueAtTime(droneVolume.value / 100, audioCtx.currentTime + 0.1);

        // a fresh bus for every Play, so old plucks from a previous session can't come back
        tanpuraBus = audioCtx.createGain();
        tanpuraBus.connect(masterGain);
        tanpuraBus.connect(reverbNode);

        nextStringIndex = 0;
        nextPluckTime = audioCtx.currentTime + 0.1;
        scheduler();
        timerId = setInterval(scheduler, 100);

        playDrone.textContent = "Stop drone";
    } else {
        // STOP
        clearInterval(timerId);
        timerId = null;

        masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
        masterGain.gain.setValueAtTime(masterGain.gain.value, audioCtx.currentTime);
        masterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.4);

        // after the fade, cut the old plucks off completely
        const oldBus = tanpuraBus;
        tanpuraBus = null;
        setTimeout(() => oldBus.disconnect(), 600);

        playDrone.textContent = "Play drone";
    }
});

toggleButtons.forEach(button => {
    button.addEventListener("click", ()=> {
        const parent = button.parentElement;
        parent.querySelectorAll("button").forEach(btn => {
            btn.classList.remove("active");
        });
        button.classList.add("active");

        if(button.dataset.sound) {
            currentSound = button.dataset.sound;
        }

        if(button.dataset.notation) {
            currentNotation = button.dataset.notation;
        }

        saveSettings();
    });
});

function saveSettings() {

    const settings = {

        sa: saSelect.value,

        octave: octaveSelect.value,

        volume: droneVolume.value,

        sensitivity: micSensitivity.value,

        sound: currentSound,

        notation: currentNotation

    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));

}

function loadSettings() {

    try {

        const saved = localStorage.getItem(STORAGE_KEY);

        if (saved) {

            const settings = JSON.parse(saved);

            if (settings.sa) saSelect.value = settings.sa;
            if (settings.octave) octaveSelect.value = settings.octave;
            if (settings.volume) droneVolume.value = settings.volume;
            if (settings.sensitivity) micSensitivity.value = settings.sensitivity;

            if (settings.sound) currentSound = settings.sound;
            if (settings.notation) currentNotation = settings.notation;

            toggleButtons.forEach(button => {

                if (button.dataset.sound) {

                    button.classList.toggle("active", button.dataset.sound === currentSound);

                }
                if (button.dataset.notation) {

                    button.classList.toggle("active", button.dataset.notation === currentNotation);

                }

            });

        }

    } catch (error) {

        console.log("Could not load saved settings:", error);

    }

    updateSaLabel();
}

loadSettings();