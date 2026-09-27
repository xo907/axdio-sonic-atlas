"""Sonic Atlas for Axdio: the server side.

It listens to every song in the library once, in the background (analysis.py says how), keeps what it measured in
config/plugins/data/atlas/atlas.db, and serves the map the player draws (/api/plugins/atlas/map). Songs added or changed
later are measured as the library notices them. The admin page (static/admin.js) shows how far it has got.
"""
import collections
import hashlib
import json
import random
import sqlite3
import threading
import time

from flask import Response, jsonify, request

from . import analysis

_atlas = None


def register(api):
    global _atlas
    _atlas = Atlas(api)
    api.route("map", access="public")(_atlas.route_map)
    api.route("status")(_atlas.route_status)
    api.route("control", methods=("POST",))(_atlas.route_control)
    api.on("library", _atlas.on_library)
    api.hook("stop", _atlas.pause_for_disk)
    api.every(1800, _atlas.refresh, first=45)
    _atlas.start()


def unregister():
    """Axdio is turning the plugin off, updating or removing it: stop listening to songs."""
    if _atlas: _atlas.stop()


class Atlas:
    def __init__(self, api):
        self.api = api
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(api.data_dir / "atlas.db"), check_same_thread=False, timeout=30, isolation_level=None)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("CREATE TABLE IF NOT EXISTS songs (rel TEXT PRIMARY KEY, mtime REAL, v INTEGER, data TEXT, err TEXT, at REAL)")
        self.queue, self.queued = collections.deque(), set()
        self.halt = threading.Event()
        self.state = api.load("state", {}) or {}
        self.disk_pause_until = 0.0
        self.current = {}
        self.session = {"started": time.time(), "done": 0}
        self.version = 0                 # goes up whenever a measurement is added or removed
        self.cache = {"version": -1, "built": 0.0, "body": b"", "etag": ""}
        self.threads = []

    # --- Measuring ---
    def start(self):
        for i in range(2):
            t = threading.Thread(target=self.work, args=(i,), daemon=True, name=f"atlas-{i}")
            t.start()
            self.threads.append(t)

    def stop(self):
        self.halt.set()
        for t in self.threads: t.join(timeout=5)
        with self.lock: self.conn.close()

    def workers_wanted(self):
        if self.state.get("paused") or time.time() < self.disk_pause_until or not self.api.setting("atlas_analyze", True): return 0
        return 2 if str(self.api.setting("atlas_speed", "1")) == "2" else 1

    def local_library(self):
        """{rel: meta} of the songs that are files on this server (not ones shared from another server)."""
        return {rel: m for rel, m in list(self.api.library().items()) if isinstance(m, dict) and not rel.startswith("@")}

    def refresh(self):
        """Queue every song that hasn't been measured (or has changed since), and forget songs that are gone."""
        lib = self.local_library()
        with self.lock:
            known = {rel: (mtime, v) for rel, mtime, v in self.conn.execute("SELECT rel, mtime, v FROM songs")}
            gone = [rel for rel in known if rel not in lib]
            for rel in gone: self.conn.execute("DELETE FROM songs WHERE rel = ?", (rel,))
            if gone: self.version += 1
            todo = [rel for rel, m in lib.items() if known.get(rel) != (m.get("mtime"), analysis.VERSION) and rel not in self.queued]
            random.Random(len(lib)).shuffle(todo)             # the map fills in evenly, not artist by artist
            self.queue.extend(todo)
            self.queued.update(todo)

    def on_library(self, event):
        with self.lock:
            for rel in event.get("removed") or []:
                self.conn.execute("DELETE FROM songs WHERE rel = ?", (rel,))
                self.version += 1
            for rel in (event.get("added") or []) + (event.get("updated") or []):
                if rel.startswith("@") or rel in self.queued: continue
                self.queue.appendleft(rel)                    # new songs go first
                self.queued.add(rel)

    def pause_for_disk(self):
        self.disk_pause_until = time.time() + 3600
        self.api.log("Paused mapping songs for an hour: the disk is almost full.", "warn")

    def work(self, i):
        while not self.halt.is_set():
            if i >= self.workers_wanted():
                self.halt.wait(5)
                continue
            with self.lock:
                rel = self.queue.popleft() if self.queue else None
                if rel:
                    self.queued.discard(rel)
                    self.current[i] = rel
            if not rel:
                self.halt.wait(10)
                continue
            meta = self.local_library().get(rel)
            path = self.api.music_dir() / rel
            data = err = None
            try:
                if not meta or not path.is_file(): continue
                data = analysis.measure(path, meta.get("duration"))
            except Exception as ex:
                err = str(ex)[:200] or ex.__class__.__name__
            finally:
                with self.lock: self.current.pop(i, None)
            with self.lock:
                if self.halt.is_set(): return
                self.conn.execute("INSERT OR REPLACE INTO songs (rel, mtime, v, data, err, at) VALUES (?, ?, ?, ?, ?, ?)",
                                  (rel, meta.get("mtime"), analysis.VERSION, json.dumps(data) if data else None, err, time.time()))
                self.version += 1
                self.session["done"] += 1
            self.halt.wait(0.25)

    # --- The map ---
    def payload(self):
        with self.lock:
            fresh = self.cache["version"] == self.version
            recent = time.time() - self.cache["built"] < 20       # while songs are being measured, rebuild now and then
            if self.cache["body"] and (fresh or recent): return self.cache
            version = self.version
            rows = self.conn.execute("SELECT rel, data FROM songs WHERE data IS NOT NULL").fetchall()
            queued = len(self.queue)
        lib = self.local_library()
        items = [(rel, json.loads(d)) for rel, d in rows if rel in lib]
        where = analysis.layout(items)
        songs = []
        for rel, d in items:
            x, y, energy, mood, vec = where[rel]
            songs.append([rel, round(x * 10000), round(y * 10000), round(d["bpm"]), d["cam"] + (12 if d["major"] else 0), energy, mood, vec])
        body = json.dumps({"v": analysis.VERSION, "count": len(songs), "library": len(lib), "queued": queued,
                           "working": bool(queued and self.workers_wanted()), "paused": not self.workers_wanted(), "songs": songs},
                          separators=(",", ":")).encode()
        cache = {"version": version, "built": time.time(), "body": body, "etag": hashlib.md5(body).hexdigest()[:20]}
        with self.lock: self.cache = cache
        return cache

    def route_map(self):
        c = self.payload()
        r = Response(c["body"], mimetype="application/json")
        r.set_etag(c["etag"])
        r.headers["Cache-Control"] = "no-cache"
        return r.make_conditional(request)

    # --- The admin page ---
    def route_status(self):
        lib = self.local_library()
        with self.lock:
            ok = self.conn.execute("SELECT COUNT(*) FROM songs WHERE data IS NOT NULL").fetchone()[0]
            failed = self.conn.execute("SELECT rel, err FROM songs WHERE err IS NOT NULL ORDER BY at DESC").fetchall()
            current, queued = list(self.current.values()), len(self.queue)
        took = max(1.0, time.time() - self.session["started"])
        rate = self.session["done"] / took * 60                 # songs a minute, since the server started
        return jsonify({"library": len(lib), "mapped": ok, "failed": len(failed), "failures": [{"rel": r, "error": e} for r, e in failed[:20]],
                        "queued": queued, "current": current, "rate": round(rate, 1), "working": bool(queued and self.workers_wanted()),
                        "paused": bool(self.state.get("paused")), "disk_paused": time.time() < self.disk_pause_until,
                        "enabled": bool(self.api.setting("atlas_analyze", True)), "eta_minutes": round(queued / rate) if rate > 0.05 and queued else None})

    def route_control(self):
        action = (request.get_json(silent=True) or {}).get("action")
        if action in ("pause", "resume"):
            self.state["paused"] = action == "pause"
            self.api.save("state", self.state)
            self.api.log("Paused mapping songs" if action == "pause" else "Resumed mapping songs")
        elif action in ("remap", "retry"):
            with self.lock:
                if action == "remap": self.conn.execute("UPDATE songs SET v = 0")       # measured again; the map keeps them meanwhile
                else: self.conn.execute("DELETE FROM songs WHERE err IS NOT NULL")
                self.version += 1
            self.refresh()
            if action == "remap": self.api.log("Started mapping every song again")
        else:
            return jsonify({"error": "Choose pause, resume, retry or remap."}), 400
        return self.route_status()
