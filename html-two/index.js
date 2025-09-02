// ======== Utility ========
const sleep = ms => new Promise(r => setTimeout(r, ms));
function hann(N) {
    const w = new Float32Array(N);
    for (let n = 0; n < N; n++) {
        w[n] = 0.5 * (1 - Math.cos(2 * Math.PI * n / (N-1)));
    }
    return w;
}

function fft(re, im) {
    const N = re.length;
    // bit-reverse
    let j = 0;
    for (let i = 0; i < N; i++) {
        if (i < j) {
            const tr = re[i];
            re[i] = re[j];
            re[j] = tr;
            const ti = im[i];
            im[i] = im[j];
            im[j] = ti;
        }
        let m = N>>1;
        while (m >= 1 && j >= m) {
            j -= m;
            m >>= 1;
        }
        j += m;
    }
    for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1;
        const tableStep = Math.PI * 2 / size;
        for (let i = 0; i < N; i += size) {
            for (let k = 0; k < half; k++) {
                const angle = tableStep * k;
                const wr = Math.cos(angle);
                const wi = -Math.sin(angle);
                const j = i + k;
                const l = j+half;
                const tr = wr*re[l] - wi*im[l];
                const ti = wr*im[l] + wi*re[l];
                const ur = re[j]
                const ui = im[j];
                re[l] = ur - tr;
                im[l] = ui - ti;
                re[j] = ur + tr;
                im[j] = ui + ti;
            }
        }
    }
}

const FP_CFG = {
    frameSize: 2048,
    hopSize: 1024, // usually frameSize / 2
};

const HANN = hann(FP_CFG.frameSize);

function stft(signal, sampleRate) {
    const { frameSize, hopSize } = FP_CFG;
    const frameSizeHalf = frameSize / 2;

    const nFrames = 1 + Math.floor((signal.length - frameSize) / hopSize);
    const spec = new Array(nFrames);

    for (let t = 0; t < nFrames; t++) {

        const re = new Float32Array(frameSize);
        const im = new Float32Array(frameSize);

        const idx = t * hopSize

        // Hann window is used before FFT to reduce spectral leakage by
        // tapering the edges of the signal chunk smoothly to zero
        for (let n = 0; n < frameSize; n++) {
            re[n] = (signal[idx + n] || 0) * HANN[n];
        }

        fft(re, im);

        const mags = new Float32Array(frameSizeHalf);
        for (let k = 0; k < mags.length; k++) {
            const mag = Math.hypot(re[k], im[k]) / frameSizeHalf;
            // convert mag to decibels bc human hearing is logarithmic
            // dB = 20 * log10(magnitude)
            mags[k] = 20 * Math.log10(mag + 1e-12);
        }

        spec[t] = mags;
    }

    return { spec, nFrames, bins: frameSizeHalf, sampleRate };
}




///////////////////////////////////////////////
// ======== Fingerprinting Pipeline ======== //
///////////////////////////////////////////////

async function decodeFileToMono(file) {
    const arr = await file.arrayBuffer();
    const buf = await new window.AudioContext().decodeAudioData(arr);
    const data = buf.numberOfChannels > 1 ? averageChannels(buf) : buf.getChannelData(0);
    return { data: data, rate: buf.sampleRate };
}

function averageChannels(buf) {
    const len = buf.length;
    const avgChannelData = new Float32Array(len);
    const numChannels = buf.numberOfChannels;

    for (let c = 0; c < numChannels; c++) {
        const channelData = buf.getChannelData(c);
        for (let i = 0; i < len; i++) {
            avgChannelData[i] += channelData[i];
        }
    }

    for (let i = 0; i < len; i++) {
        avgChannelData[i] /= numChannels;
    }

    return avgChannelData;
}



//////////////////////////
// ======== UI ======== //
//////////////////////////

const refFilesEl = document.getElementById('refFiles');
const recordBtn = document.getElementById('recordBtn');
let recState = { collecting: false, data:[] };
const specCanvas = document.getElementById('spec');


refFilesEl.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    for (const file of files) {
        const { data, rate } = await decodeFileToMono(file);
        console.log("data.length: " + data.length);
        console.log("data rate: " + rate);
        const spectrogram = stft(data, rate);
        drawSpectrogram(spectrogram);
    }
});

recordBtn.addEventListener('click', async () => {
    if (recState.collecting) return;
    try {
        const DURATION_SEC = 6;

        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const stream = new MediaStream([
            ...micStream.getAudioTracks()
        ]);

        const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        const src = ac.createMediaStreamSource(stream);
        const proc = ac.createScriptProcessor(4096, 1, 1);
        recState = { collecting: true, data: [] };
        src.connect(proc);
        proc.connect(ac.destination);
        const started = performance.now();
        proc.onaudioprocess = (e) => {
            if (!recState.collecting) return;
            const input = e.inputBuffer.getChannelData(0);
            recState.data.push(new Float32Array(input));
            if ((performance.now() - started) > (DURATION_SEC * 1000)) {
                recordBtn.innerHTML = '🎤 Listen (6s)';
                recState.collecting = false;
                proc.disconnect();
                src.disconnect();
                stream.getTracks().forEach(t => t.stop());
                const merged = flattenFloat32(recState.data);

                const spectrogram = stft(merged, ac.sampleRate);
                drawSpectrogram(spectrogram);
            }
        };
    } catch(err) {
        alert(err);
    }
});

function flattenFloat32(chunks) {
    let len = 0;
    for (const c of chunks) {
        len += c.length;
    }
    const out = new Float32Array(len);
    let off = 0;
    for (const c of chunks) {
        out.set(c,off);
        off += c.length;
    }
    return out;
}

function zeroEverythingButHighest(S) {
    const numKeep = 2;
    const peaksByFrame = [];
    const spec = S.spec;
    for (let t = 0; t < spec.length; t++) {
        const row = spec[t];
        const peaks = [];
        for (let k = 1; k < row.length - 1; k++) {
            if (row[k] > row[k-1] && row[k] > row[k+1]) {
                peaks.push({k, db: row[k]});
            }
        }
        peaks.sort((a, b) => b.db - a.db);
        peaksByFrame.push(peaks.slice(0, numKeep).map(p => p.k));
    }
    return peaksByFrame;
}

function drawSpectrogram(S) {
    const peaksByFrame = zeroEverythingButHighest(S);

    const ctx = specCanvas.getContext('2d');

    const W = specCanvas.width
    const H = specCanvas.height;

    ctx.clearRect(0, 0, W, H);

    const nT = S.spec.length;
    const nF = S.spec[0]?.length || 1;
    console.log("nT: " + nT);
    console.log("nF: " + nF);

    const ys = [];

    for (let t = 0; t < nT; t++) {
        const peaks = peaksByFrame[t];
        for (let i = 0; i < peaks.length; i++) {
            const v = 1;
            ctx.fillStyle = `hsl(${220 - (220 * v)}, 90%, ${20 + (60 * v)}%)`;

            const y = Math.floor((Math.log(peaks[i])/Math.log(nF)) * (H - 1));
            ys.push(y);
            const x = Math.floor(t * (W - 1) / Math.max(1, nT - 1));
            ctx.fillRect(x, y, 1, 1);
        }
//        for (let k = 0; k < nF; k++) {
//
//            const db = S.spec[t][k];
//            const v = (db - (-90)) / (0 - (-90)); // map -90..0 dB to 0..1
//            ctx.fillStyle = `hsl(${220 - (220 * v)}, 90%, ${20 + (60 * v)}%)`;
//
//            const y = Math.floor((Math.log(k)/Math.log(nF)) * (H - 1));
//            const x = Math.floor(t * (W - 1) / Math.max(1, nT - 1));
//            ctx.fillRect(x, y, 1, 1);
//
//        }
    }

    let counts = {};
    for (let item of ys) {
      counts[item] = (counts[item] || 0) + 1;
    }

    // Keep only items that occur > 10 times
    let filtered = ys.filter(item => counts[item] > 10);
    let mySet = new Set(filtered);
    let sortedArray = [...mySet].sort((a, b) => a - b);
    console.log(sortedArray);

    console.log("DONE");
}
