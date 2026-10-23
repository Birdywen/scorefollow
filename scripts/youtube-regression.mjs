// YouTube media source: link parsing and the media-element adapter (fake IFrame API).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = mkdtempSync(join(tmpdir(), "sf-yt-"));
const out = ts.transpileModule(readFileSync(new URL("../lib/youtube.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
writeFileSync(join(dir, "youtube.mjs"), out);
const { parseYouTube, youTubeUrl, YouTubeMedia, youTubeExcerpt, recordPlayback, captureTabAudio } = await import(pathToFileURL(join(dir, "youtube.mjs")));

const ID = "qx-ymShyfIk"; // synpdf.html's default id
const cases = [
  [ID, { id: ID, start: 0 }],
  [`https://www.youtube.com/watch?v=${ID}`, { id: ID, start: 0 }],
  [`https://www.youtube.com/watch?list=PL1&v=${ID}&t=90`, { id: ID, start: 90 }],
  [`youtube.com/watch?v=${ID}&t=1m30s`, { id: ID, start: 90 }],
  [`https://m.youtube.com/watch?v=${ID}`, { id: ID, start: 0 }],
  [`https://music.youtube.com/watch?v=${ID}`, { id: ID, start: 0 }],
  [`https://youtu.be/${ID}?t=1h2m3s`, { id: ID, start: 3723 }],
  [`https://youtu.be/${ID}?si=abc`, { id: ID, start: 0 }],
  [`https://www.youtube.com/shorts/${ID}`, { id: ID, start: 0 }],
  [`https://www.youtube.com/embed/${ID}?start=12`, { id: ID, start: 12 }],
  [`https://www.youtube-nocookie.com/embed/${ID}`, { id: ID, start: 0 }],
  [`https://www.youtube.com/live/${ID}`, { id: ID, start: 0 }],
  ["  " + ID + " ", { id: ID, start: 0 }],
];
for (const [input, want] of cases) assert.deepEqual(parseYouTube(input), want, input);
for (const bad of ["", "abc", "qx-ymShyfI", `https://vimeo.com/${ID}`, `https://evil.com/watch?v=${ID}`,
  "https://www.youtube.com/watch?v=short", "https://www.youtube.com/channel/UC123", "javascript:alert(1)"]) {
  assert.equal(parseYouTube(bad), null, bad);
}
assert.equal(youTubeUrl(ID), `https://youtu.be/${ID}`);
assert.equal(youTubeUrl(ID, 90.4), `https://youtu.be/${ID}?t=90`);
assert.deepEqual(parseYouTube(youTubeUrl(ID, 90)), { id: ID, start: 90 });

// Adapter against a fake YT.Player.
let player;
class FakePlayer {
  constructor(_el, o) { player = this; this.o = o; this.state = -1; this.t = 0; this.calls = []; }
  getCurrentTime() { return this.t; }
  getPlayerState() { return this.state; }
  seekTo(t) { this.calls.push(["seek", t]); this.t = t; }
  playVideo() { this.calls.push(["play"]); this.fire(1); }
  pauseVideo() { this.calls.push(["pause"]); this.fire(2); }
  stopVideo() {}
  setPlaybackRate(r) { this.rate = r; }
  cueVideoById(o) { this.calls.push(["cue", o.startSeconds]); this.state = 5; this.t = 0; }
  destroy() { this.destroyed = true; }
  fire(s) { this.state = s; this.o.events.onStateChange({ data: s }); }
}
globalThis.window = { YT: { Player: FakePlayer } };
const seen = [];
const media = new YouTubeMedia({}, ID, 30, () => ({
  onReady: () => seen.push("ready"), onPlay: () => seen.push("play"),
  onPause: () => seen.push("pause"), onEnded: () => seen.push("ended"),
}));
await new Promise((r) => setTimeout(r, 0));
assert.equal(player.o.videoId, ID);
assert.equal(player.o.playerVars.start, 30);
// Before ready: cue point is the time, play is deferred, seeks are remembered.
assert.equal(media.currentTime, 30);
assert.equal(media.paused, true);
media.currentTime = 42;
assert.equal(media.currentTime, 42);
await media.play(); // must not reject
media.playbackRate = 5;
assert.equal(media.playbackRate, 2, "rate clamps to YouTube's max");
player.o.events.onReady();
assert.deepEqual(player.calls, [["cue", 42], ["play"]], "on ready: re-cue to the pending seek, then the deferred play");
assert.equal(player.rate, 2);
assert.deepEqual(seen, ["ready", "play"]);
assert.equal(media.paused, false);
player.t = 50.5;
assert.equal(media.currentTime, 50.5);
media.currentTime = 10; // playing → seekTo
assert.deepEqual(player.calls.at(-1), ["seek", 10]);
player.fire(3); // buffering still counts as playing
assert.equal(media.paused, false);
media.pause();
assert.equal(media.paused, true);
media.pause(); // already paused: no second pauseVideo
assert.equal(player.calls.filter((c) => c[0] === "pause").length, 1);
player.fire(0);
assert.deepEqual(seen, ["ready", "play", "pause", "ended"]);
player.state = 5; // cued: a seek re-cues instead of starting playback
media.currentTime = 7;
assert.deepEqual(player.calls.at(-1), ["cue", 7]);
assert.equal(media.currentTime, 7);
media.destroy();
assert.equal(player.destroyed, true);
assert.equal(media.paused, true);
// After a player error, every play attempt reports it again (asynchronously).
const errs = [];
const m2 = new YouTubeMedia({}, ID, 0, () => ({ onError: (c) => errs.push(c) }));
await new Promise((r) => setTimeout(r, 0));
player.o.events.onReady();
player.o.events.onError({ data: 150 });
await m2.play();
assert.deepEqual(errs, [150], "repeat is async");
await new Promise((r) => setTimeout(r, 5));
assert.deepEqual(errs, [150, 150]);
assert.equal(player.calls.filter((c) => c[0] === "play").length, 0, "no playVideo after an error");
// B-sync markers (video time) -> excerpt within the take limit, markers shifted.
const ex = youTubeExcerpt([{ measure: 3, audioSec: 42.5 }, { measure: 4, audioSec: 44.5 }, { measure: 5, audioSec: 46.6 }]);
assert.deepEqual(ex, { startSec: 41, lengthSec: 9, markers: [{ measure: 3, audioSec: 1.5 }, { measure: 4, audioSec: 3.5 }, { measure: 5, audioSec: 5.6 }] });
const long = youTubeExcerpt(Array.from({ length: 200 }, (_, i) => ({ measure: i + 1, audioSec: 0.5 + 2 * i })));
assert.equal(long.startSec, 0);
assert.equal(long.lengthSec, 300);
assert.ok(long.markers.every((m) => m.audioSec < 300) && long.markers.length === 150);

// Recording the tab while the video plays: the take's time 0 maps to the right video time.
globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } getAudioTracks() { return this.tracks; } };
let clock = 0;
const stops = [];
const track = (kind) => ({ kind, stop: () => stops.push(kind) });
const stream = { getAudioTracks: () => [track("audio")], getTracks: () => [track("audio"), track("video")] };
const fakeMedia = {
  playbackRate: 1.5, base: 0, playAt: null,
  get paused() { return this.playAt === null; },
  get currentTime() { return this.paused ? this.base : this.base + Math.max(0, clock - this.playAt) / 1000; },
  set currentTime(t) { this.base = t; },
  async play() { this.playAt = clock + 1200; }, // reports playing at once; the clock moves 1.2 s later
  pause() { if (this.playAt !== null) { this.base = this.currentTime; this.playAt = null; } },
};
const rateDuring = [];
const recorder = { state: "inactive", mimeType: "audio/webm",
  start() { this.state = "recording"; rateDuring.push(fakeMedia.playbackRate); },
  stop() { this.state = "inactive"; this.ondataavailable({ data: new Blob(["x"]) }); this.onstop(); } };
const progress = [];
const rec = await recordPlayback(stream, fakeMedia, 41, 9, {
  now: () => clock, sleep: async (ms) => { clock += ms; }, makeRecorder: () => recorder, onProgress: (t) => progress.push(t),
});
// play() at record start; "playing" at once, but the clock only moves from 41 s after 1.2 s.
assert.ok(Math.abs(rec.videoAtZero - (41 - 1.2)) < 1e-9, `videoAtZero ${rec.videoAtZero}`);
assert.ok(fakeMedia.currentTime >= 50 && fakeMedia.paused, "plays to the end of the section, then pauses");
assert.equal(rec.blob.size, 1);
assert.deepEqual(rateDuring, [1], "records at normal speed");
assert.equal(fakeMedia.playbackRate, 1.5, "speed restored");
assert.deepEqual(stops.sort(), ["audio", "video"], "capture stopped");
assert.ok(progress.length > 50 && progress.at(-1) <= 9);

// Tab capture: unsupported browser and "no audio shared" give clear messages.
await assert.rejects(captureTabAudio({}), /Chrome or Edge/);
const noAudio = { getDisplayMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [track("video")] }) };
await assert.rejects(captureTabAudio(noAudio), /Share tab audio/);
let asked;
const ok = { getDisplayMedia: async (o) => { asked = o; return stream; } };
assert.equal(await captureTabAudio(ok), stream);
assert.equal(asked.preferCurrentTab, true);
assert.equal(asked.audio.suppressLocalAudioPlayback, false, "the user still hears the video");
console.log("YOUTUBE_OK");
