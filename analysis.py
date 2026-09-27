"""How a song sounds, in a few numbers, and where that puts it on the map.

measure() listens to a minute of a song, from about a third of the way in (decoded by ffmpeg, mono, 22 kHz): long
enough that a quiet breakdown doesn't speak for the whole song, and one read from where the file is kept (every jump
within a file costs more than reading on, on network and cloud drives). It works out:
- its tempo, from how regularly new sounds start (an onset envelope, and its autocorrelation);
- its key and whether it's major or minor, by comparing its pitch classes with the Krumhansl-Kessler key profiles;
- how loud, busy, bright and noisy it is.

layout() turns everyone's numbers into two scores, energy (calm to intense) and mood (dark to bright), and spreads
them over the map so every part of it has songs.
"""
import math
import subprocess

import numpy as np

VERSION = 1                 # of the measurements: a newer one measures every song again
SR, N_FFT, HOP, CLIP = 22050, 2048, 512, 60.0
FPS = SR / HOP              # onset-envelope frames per second
# Krumhansl-Kessler key profiles, from C.
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
FEATURES = ("rms", "onset", "flux", "tempo", "cent", "flat", "pulse", "mode")


def decode(path, start, seconds):
    cmd = ["nice", "-n", "15", "ffmpeg", "-v", "error", "-nostdin", "-ss", f"{start:.2f}", "-t", f"{seconds:.2f}",
           "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, timeout=300).stdout
    return np.frombuffer(out, dtype=np.float32)


def measure(path, duration=None):
    """The numbers for one song file. Raises ValueError when it can't be read or is too short."""
    d = float(duration or 0)
    start = min(d * 0.3, d - CLIP - 5) if d > CLIP + 15 else 0.0
    x = decode(path, max(0.0, start), CLIP)
    if len(x) < SR * 8 and start > 0: x = decode(path, 0.0, CLIP)
    if len(x) < SR * 8: raise ValueError("it's too short, or ffmpeg couldn't read it")
    return features(x)


def camelot(key, major):
    """The key on the Camelot wheel DJs use: 1-12, with B for major and A for minor (8B is C major, 8A is A minor).
    Neighbours on the wheel mix well."""
    k = key if major else (key + 3) % 12             # a minor key sits with its relative major
    return ((k * 7) % 12 + 7) % 12 + 1


def features(x, parts=1):
    """The numbers for mono audio at SR. `parts`: how many separate windows were joined to make it (tempo is found in
    each and put together, so the joins don't count as beats)."""
    x = np.asarray(x, dtype=np.float64)
    if not np.any(np.abs(x) > 1e-4): raise ValueError("it's silent")
    n = 1 + (len(x) - N_FFT) // HOP
    frames = np.lib.stride_tricks.sliding_window_view(x, N_FFT)[::HOP][:n] * np.hanning(N_FFT)
    mag = np.abs(np.fft.rfft(frames, axis=1))
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)

    rms = np.sqrt(np.mean(frames ** 2, axis=1)) + 1e-9
    loud = rms > rms.max() * 0.05                     # frames with sound in them
    if loud.sum() < 20: raise ValueError("it's nearly silent")
    rms_db = 20 * math.log10(float(np.mean(rms[loud])))

    # Brightness (where the sound's weight sits) and noisiness (flat spectrum = noise, peaky = tones).
    cent = (mag * freqs).sum(1) / (mag.sum(1) + 1e-9)
    band = (freqs > 100) & (freqs < 8000)
    p = mag[:, band] ** 2 + 1e-12
    flat = np.exp(np.mean(np.log(p), axis=1)) / np.mean(p, axis=1)

    # Onsets: rises in the (compressed) spectrum, frame to frame.
    lm = np.log1p(1000 * mag / (mag.max() + 1e-9))
    flux = np.maximum(0.0, np.diff(lm, axis=0)).sum(1) / lm.shape[1]
    kernel = np.ones(16) / 16
    onset = np.maximum(0.0, flux - np.convolve(flux, kernel, mode="same"))
    thresh = max(onset.mean() + onset.std(), 0.05)       # steady sound ripples around 0.01; real onsets are 1 and up
    peaks = (onset[1:-1] > thresh) & (onset[1:-1] >= onset[:-2]) & (onset[1:-1] > onset[2:])
    onset_rate = float(peaks.sum()) / (len(onset) / FPS)

    # Tempo: the lag at which the onset envelope best repeats (55-215 BPM), favouring the usual 80-160.
    ac = np.zeros(len(onset) // max(1, parts))
    for chunk in np.array_split(onset, max(1, parts)):
        o = chunk - chunk.mean()
        spec = np.fft.rfft(o, 2 * len(o))
        a = np.fft.irfft(spec * np.conj(spec))[:len(o)]
        ac[:min(len(ac), len(a))] += a[:len(ac)] / (a[0] + 1e-9)
    lags = np.arange(int(FPS * 60 / 215), min(len(ac) - 2, int(FPS * 60 / 55) + 1))
    bpms = 60 * FPS / lags
    score = ac[lags] / (ac[0] + 1e-9) * np.exp(-0.5 * (np.log2(bpms / 120) / 0.9) ** 2)
    i = int(np.argmax(score))
    lag = float(lags[i])
    if 0 < i < len(lags) - 1:                          # between two lags, where the peak really is
        a, b, c = score[i - 1], score[i], score[i + 1]
        den = a - 2 * b + c
        if den: lag += 0.5 * (a - c) / den
    bpm = 60 * FPS / lag
    pulse = float(max(0.0, ac[int(round(lag))] / (ac[0] + 1e-9)))

    # Key: how much of each pitch class there is (65 Hz to 2.1 kHz), against the major and minor profiles.
    sel = (freqs >= 65) & (freqs <= 2100)
    pcs = (np.round(12 * np.log2(freqs[sel] / 440.0)).astype(int) + 9) % 12
    chroma = np.bincount(pcs, weights=np.sqrt(mag[:, sel][loud]).sum(0), minlength=12)
    best = (-2.0, 0, True)
    for k in range(12):
        for major, prof in ((True, MAJOR), (False, MINOR)):
            r = float(np.corrcoef(chroma, np.roll(prof, k))[0, 1])
            if r > best[0]: best = (r, k, major)
    kconf, key, major = best

    db = 20 * np.log10(rms[loud])
    return {"v": VERSION, "bpm": round(bpm, 1), "key": key, "major": major, "kconf": round(kconf, 3),
            "cam": camelot(key, major), "rms": round(rms_db, 2), "cent": round(math.log2(float(np.median(cent[loud])) + 1), 3),
            "flat": round(float(np.median(flat[loud])), 4), "flux": round(float(flux.mean()), 4), "onset": round(onset_rate, 3),
            "pulse": round(pulse, 3), "dyn": round(float(np.percentile(db, 95) - np.percentile(db, 10)), 2)}


def _robust_z(col):
    med = np.median(col)
    spread = (np.percentile(col, 75) - np.percentile(col, 25)) / 1.349
    return np.clip((col - med) / (spread if spread > 1e-9 else 1.0), -3, 3)


def _rank(score):
    n = len(score)
    rank = np.empty(n)
    rank[np.argsort(score, kind="stable")] = (np.arange(n) + 0.5) / n
    return rank


def _spread(score):
    """0-1 positions that use the whole map (by rank) but keep some of the real distances."""
    return 0.7 * _rank(score) + 0.3 / (1 + np.exp(-score / 1.2))


def layout(items):
    """items: [(key, measurements)]. Returns {key: (x, y, energy 0-100, mood 0-100, vector)}: x is energy (calm to
    intense), y is mood (dark to bright), and the vector is the song's sound in 8 numbers, for finding look-alikes."""
    if not items: return {}
    m = np.array([[d["rms"], d["onset"], d["flux"], math.log2(max(40.0, d["bpm"])), d["cent"], d["flat"], d["pulse"],
                   (1.0 if d["major"] else -1.0) * min(1.0, max(0.0, d["kconf"]) * 2)] for _, d in items], dtype=float)
    z = np.column_stack([_robust_z(m[:, i]) for i in range(m.shape[1])]) if len(items) > 1 else np.zeros_like(m)
    rms, onset, flux, tempo, cent, flat, pulse, mode = (z[:, i] for i in range(8))
    energy = 0.32 * rms + 0.3 * onset + 0.23 * flux + 0.15 * tempo
    mood = 0.45 * cent + 0.35 * mode + 0.12 * pulse - 0.08 * flat
    x, y = _spread(energy), _spread(mood)
    e_rank, m_rank = _rank(energy), _rank(mood)                      # as percentages: louder than 72% of the library
    vec = np.clip(np.round(z * 30), -90, 90).astype(int)
    return {k: (float(x[i]), float(y[i]), int(round(e_rank[i] * 100)), int(round(m_rank[i] * 100)), vec[i].tolist())
            for i, (k, _) in enumerate(items)}
