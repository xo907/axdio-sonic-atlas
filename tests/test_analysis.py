"""Sonic Atlas's measurements, on sounds made up for the purpose: a click track has a tempo, a chord progression a key.

Run where ffmpeg and numpy are installed (Axdio's image has ffmpeg; `pip install numpy`):
    python -m unittest discover -s tests -v
"""
import math, subprocess, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import numpy as np  # noqa: E402
import analysis  # noqa: E402

SR = analysis.SR
NOTE = {n: i for i, n in enumerate(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"])}


def tone(freq, seconds, amp=0.2):
    t = np.arange(int(SR * seconds)) / SR
    return amp * np.sin(2 * np.pi * freq * t) * np.minimum(1, np.minimum(t, seconds - t) * 20)


def chord(names, seconds, octave=4):
    return sum(tone(440 * 2 ** ((NOTE[n] - 9) / 12 + (octave - 4)), seconds, 0.12) for n in names)


def clicks(bpm, seconds, seed=1):
    rng = np.random.default_rng(seed)
    x = np.zeros(int(SR * seconds))
    step = 60 / bpm
    for i in range(int(seconds / step)):
        at = int(i * step * SR)
        burst = rng.normal(0, 0.6, 600) * np.exp(-np.arange(600) / 120)
        x[at:at + 600] += burst[:len(x) - at]
    return x


def progression(chords, bars=12, beat_bpm=100):
    parts = [chord(c, 60 / beat_bpm * 4) for _ in range(bars // len(chords)) for c in chords]
    return np.concatenate(parts)


class TestAnalysis(unittest.TestCase):
    def test_tempo(self):
        for bpm in (90, 120, 128, 140):
            got = analysis.features(clicks(bpm, 40) + 0.02 * chord(["C", "E", "G"], 40))["bpm"]
            self.assertLess(abs(got - bpm), 2.5, (bpm, got))

    def test_key(self):
        c_major = progression([["C", "E", "G"], ["F", "A", "C"], ["G", "B", "D"], ["C", "E", "G"]])
        d = analysis.features(c_major)
        self.assertEqual((d["key"], d["major"], d["cam"]), (0, True, 8))
        a_minor = progression([["A", "C", "E"], ["D", "F", "A"], ["E", "G#", "B"], ["A", "C", "E"]])
        d = analysis.features(a_minor)
        self.assertEqual((d["key"], d["major"], d["cam"]), (9, False, 8))

    def test_camelot_wheel(self):
        self.assertEqual([analysis.camelot(k, True) for k in (0, 7, 2, 11, 5)], [8, 9, 10, 1, 7])      # C G D B F major
        self.assertEqual([analysis.camelot(k, False) for k in (9, 4, 2, 0)], [8, 9, 7, 5])              # A E D C minor

    def test_brightness_and_energy(self):
        soft = analysis.features(0.05 * chord(["C", "E", "G"], 30, octave=3))
        loud = analysis.features(clicks(140, 30) + 0.4 * chord(["C", "E", "G"], 30, octave=5))
        self.assertGreater(loud["rms"], soft["rms"])
        self.assertGreater(loud["cent"], soft["cent"])
        self.assertGreater(loud["onset"], soft["onset"])
        where = analysis.layout([("soft", soft), ("loud", loud)])
        self.assertGreater(where["loud"][0], where["soft"][0])              # further right: more energy
        self.assertEqual(len(where["loud"][4]), 8)

    def test_silence_and_short_files(self):
        with self.assertRaises(ValueError): analysis.features(np.zeros(SR * 20))
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "short.flac"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", str(p)], check=True)
            with self.assertRaises(ValueError): analysis.measure(p, 3)

    def test_a_breakdown_doesnt_make_a_song_calm(self):
        # A minute from a third of the way in hears the quiet breakdown and the loud part around it.
        loud = clicks(128, 40) + 0.4 * chord(["A", "C", "E"], 40, octave=5)
        calm = 0.03 * chord(["A", "C", "E"], 40, octave=4)
        song = np.concatenate([loud, loud, calm, loud, loud])            # 200 seconds, a breakdown at 80-120
        with tempfile.TemporaryDirectory() as d:
            import wave
            wav, flac = Path(d) / "s.wav", Path(d) / "s.flac"
            with wave.open(str(wav), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(song, -1, 1) * 32767).astype("<i2").tobytes())
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), str(flac)], check=True)
            whole = analysis.measure(flac, 200)
        middle = analysis.features(calm)
        self.assertGreater(whole["rms"], middle["rms"] + 10)
        self.assertLess(abs(whole["bpm"] - 128), 2.5)

    def test_a_real_file(self):
        with tempfile.TemporaryDirectory() as d:
            wav, flac = Path(d) / "song.wav", Path(d) / "song.flac"
            x = progression([["A", "C", "E"], ["D", "F", "A"], ["E", "G#", "B"], ["A", "C", "E"]], bars=48) + 0.6 * clicks(100, 115.2)
            pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
            import wave
            with wave.open(str(wav), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), str(flac)], check=True)
            m = analysis.measure(flac, 115.2)
            self.assertLess(abs(m["bpm"] - 100), 2.5)
            self.assertEqual(m["cam"], 8)
            self.assertEqual(m["v"], analysis.VERSION)


if __name__ == "__main__":
    unittest.main()
