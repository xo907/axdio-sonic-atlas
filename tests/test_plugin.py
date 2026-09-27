"""Sonic Atlas inside a real Axdio server: it maps the library in the background, serves the map, follows library
changes, and does what the admin page asks. Needs an Axdio checkout (AXDIO_SRC), ffmpeg and NumPy:

    docker run --rm -v "$PWD":/plugin -v /path/to/axdio:/axdio -w /plugin -e AXDIO_SRC=/axdio --entrypoint sh axdio \
        -c 'pip install -q --target /tmp/np numpy && PYTHONPATH=/tmp/np python -m unittest discover -s tests -v'
"""
import json, os, shutil, subprocess, sys, tempfile, time, unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
AXDIO = Path(os.environ.get("AXDIO_SRC") or PLUGIN.parent / "axdio")
TMP = Path(tempfile.mkdtemp(prefix="atlas-test-"))
MUSIC, CONFIG = TMP / "music", TMP / "config"
# Songs that sound different: a quiet drone, a 120 BPM kick, a noisy fast beat, a bright arpeggio.
SONGS = {
    "Calm/Drift/01 - Drone.flac": "0.08*sin(2*PI*110*t)+0.05*sin(2*PI*165*t)",
    "Beat/Club/01 - Kick.flac": "0.9*sin(2*PI*55*t)*exp(-10*mod(t,0.5))+0.05*sin(2*PI*220*t)",
    "Loud/Storm/01 - Storm.flac": "0.6*sin(2*PI*60*t)*exp(-12*mod(t,0.4))+0.35*(random(0)*2-1)*exp(-20*mod(t,0.2))",
    "Bright/Glass/01 - Glass.flac": "0.25*sin(2*PI*(880+440*floor(mod(t*4,4)))*t)*exp(-6*mod(t,0.25))",
}


def make_song(rel, expr, seconds=90):
    p = MUSIC / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    artist, album, name = rel.split("/")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", f"aevalsrc='{expr}':s=44100:d={seconds}", "-ac", "2",
                    "-metadata", f"title={name[5:-5]}", "-metadata", f"artist={artist}", "-metadata", f"album={album}", str(p)], check=True)


for rel, expr in SONGS.items(): make_song(rel, expr)
os.environ.update(CONFIG_DIR=str(CONFIG), CFG_DIR_MUSIC=str(MUSIC), SECRET_KEY="test-secret-key-for-unit-tests-only")
CONFIG.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(AXDIO))
import server  # noqa: E402  (Axdio, imported after the environment is prepared)

server.scan_library()
# Installed the way Axdio installs a folder plugin: its files in config/plugins/local/atlas, and a record of it.
info = server.inspect_plugin(PLUGIN)
shutil.copytree(PLUGIN, server.PLUGIN_LOCAL / "atlas", ignore=shutil.ignore_patterns(".git", "__pycache__", "tests"))
st = server.plugins_state()
st["plugins"]["atlas"] = {"kind": "folder", "name": info["name"], "version": info["version"], "enabled": True, "manifest": info["manifest"],
                          "source": {"type": "folder", "path": str(PLUGIN)}}
server.plugins_save(st)
server.cfg_save({"atlas_speed": "2"})
server.load_plugins()
atlas = sys.modules["axdio_plugins.atlas"]._atlas


def wait_for(check, seconds=180):
    end = time.time() + seconds
    while time.time() < end:
        if check(): return True
        time.sleep(0.5)
    return False


class TestAtlas(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.app.config["TESTING"] = True
        server.cfg_save({"admin_user": "root", "admin_password": server.hash_pw("admin-password-1")})
        cls.admin = server.app.test_client()
        cls.admin.post("/admin/login", data={"username": "root", "password": "admin-password-1"})
        atlas.refresh()
        assert wait_for(lambda: cls.status()["mapped"] == len(SONGS)), cls.status()

    @classmethod
    def status(cls):
        return cls.admin.get("/api/admin/plugins/atlas/status").get_json()

    def songs(self):
        return {s[0]: s for s in server.app.test_client().get("/api/plugins/atlas/map").get_json()["songs"]}

    def test_the_map(self):
        c = server.app.test_client()
        r = c.get("/api/plugins/atlas/map")
        d = r.get_json()
        self.assertEqual((d["count"], d["library"], d["paused"]), (len(SONGS), len(SONGS), False))
        self.assertEqual(c.get("/api/plugins/atlas/map", headers={"If-None-Match": r.headers["ETag"]}).status_code, 304)
        s = self.songs()
        kick, calm, storm = s["Beat/Club/01 - Kick.flac"], s["Calm/Drift/01 - Drone.flac"], s["Loud/Storm/01 - Storm.flac"]
        self.assertLess(abs(kick[3] - 120), 3)                                  # its tempo
        self.assertGreater(storm[1], calm[1])                                   # further right: more intense
        for song in s.values():
            self.assertTrue(0 <= song[1] <= 10000 and 0 <= song[2] <= 10000 and 1 <= song[4] <= 24 and len(song[7]) == 8)
        self.assertEqual(server.app.test_client().get("/api/admin/plugins/atlas/status").status_code, 401)   # admins only

    def test_it_follows_the_library(self):
        rel = "New/Arrival/01 - Arrival.flac"
        make_song(rel, "0.5*sin(2*PI*55*t)*exp(-9*mod(t,0.4))")
        server.refresh_library_entry(rel)                                      # what a scan or a plugin tells the library
        self.assertTrue(wait_for(lambda: self.status()["mapped"] == len(SONGS) + 1))
        self.assertTrue(wait_for(lambda: rel in self.songs(), 40))            # the map is rebuilt at most every 20 seconds
        (MUSIC / rel).unlink()
        server.forget_library_paths([rel])
        self.assertTrue(wait_for(lambda: rel not in self.songs(), 40))
        self.assertEqual(self.status()["mapped"], len(SONGS))

    def test_the_admin_controls(self):
        paused = self.admin.post("/api/admin/plugins/atlas/control", json={"action": "pause"}).get_json()
        self.assertTrue(paused["paused"])
        self.assertTrue(server.app.test_client().get("/api/plugins/atlas/map").get_json() is not None)
        self.assertEqual(atlas.workers_wanted(), 0)
        resumed = self.admin.post("/api/admin/plugins/atlas/control", json={"action": "resume"}).get_json()
        self.assertFalse(resumed["paused"])
        self.assertEqual(atlas.workers_wanted(), 2)
        self.assertEqual(self.admin.post("/api/admin/plugins/atlas/control", json={"action": "nope"}).status_code, 400)
        # Mapping everything again keeps the map meanwhile.
        before = len(self.songs())
        r = self.admin.post("/api/admin/plugins/atlas/control", json={"action": "remap"}).get_json()
        self.assertEqual(r["queued"], len(SONGS))
        self.assertEqual(len(self.songs()), before)
        self.assertTrue(wait_for(lambda: self.status()["queued"] == 0))

    def test_a_nearly_full_disk_pauses_it(self):
        for fn in server.plugin_hook("stop"): fn()
        self.assertEqual(atlas.workers_wanted(), 0)
        self.assertTrue(self.status()["disk_paused"])
        atlas.disk_pause_until = 0
        self.assertEqual(atlas.workers_wanted(), 2)


def tearDownModule():
    server._plugin_unregister("atlas")                                         # stops its workers
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
