// The lobby server's decisions, checked without Cloudflare or a network: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Lobbies, ALPHABET } from "../src/lobbies.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const HOST_IP = "81.2.3.4";
const GUEST_IP = "93.10.11.12";

function server() {
  let clock = 1000;
  let counter = 0;
  const lobbies = new Lobbies({
    now: () => clock,
    // Deterministic, so a failure fails the same way again.
    random: (bytes) => Uint8Array.from({ length: bytes }, () => (counter = (counter * 1103515245 + 12345) & 0xff)),
  });
  const call = (method, path, body = {}, ip = HOST_IP) =>
    lobbies.handle(method, path, new URLSearchParams(path.split("?")[1] || ""), body, ip);
  return {
    lobbies,
    advance: (ms) => (clock += ms),
    post: (path, body, ip) => call("POST", path, body, ip),
    get: (path, ip) => lobbies.handle("GET", path.split("?")[0], new URLSearchParams(path.split("?")[1] || ""), {}, ip || HOST_IP),
  };
}

const hostBody = (extra = {}) => ({
  version: 7,
  name: "kitchen",
  maxPlayers: 4,
  players: 1,
  localPort: 27015,
  candidates: ["81.2.3.4:27015", "192.168.1.20:27015"],
  ...extra,
});

test("a host gets a six-character code nobody can misread", () => {
  const s = server();
  const hosted = s.post("/host", hostBody());
  assert.equal(hosted.status, 200);
  assert.equal(hosted.body.code.length, 6);
  for (const c of hosted.body.code) assert.ok(ALPHABET.includes(c));
  assert.ok(hosted.body.secret.length >= 8);
});

test("joining tells the guest where the host is, and the host where the guest is", () => {
  const s = server();
  const { code, secret } = s.post("/host", hostBody()).body;

  const joined = s.post("/join", { version: 7, code: code.toLowerCase(), localPort: 51000, candidates: ["10.0.0.5:51000"] }, GUEST_IP);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.name, "kitchen");
  assert.deepEqual(joined.body.candidates, ["81.2.3.4:27015", "192.168.1.20:27015"]);

  const update = s.post("/update", { ...hostBody(), code, secret });
  assert.equal(update.status, 200);
  assert.equal(update.body.guests.length, 1);
  assert.equal(update.body.guests[0].token, joined.body.token);
  // What the guest said, and our guess from where its request came from.
  assert.deepEqual(update.body.guests[0].candidates, ["10.0.0.5:51000", "93.10.11.12:51000"]);

  // Handed over once; asking again hands it over again, with the same token.
  assert.equal(s.post("/update", { ...hostBody(), code, secret }).body.guests.length, 0);
  const again = s.post("/join", { version: 7, code, localPort: 51000, candidates: [] }, GUEST_IP);
  assert.equal(again.body.token, joined.body.token);
  assert.equal(s.post("/update", { ...hostBody(), code, secret }).body.guests.length, 1);
});

test("a join that cannot work is refused, with the reason", () => {
  const s = server();
  const { code, secret } = s.post("/host", hostBody()).body;
  const other = code[0] === "Z" ? "Y" + code.slice(1) : "Z" + code.slice(1);
  assert.equal(s.post("/join", { version: 7, code: other }, GUEST_IP).body.error, "no-such-lobby");
  assert.equal(s.post("/join", { version: 6, code }, GUEST_IP).body.error, "wrong-version");
  s.post("/update", { ...hostBody({ players: 4 }), code, secret });
  assert.equal(s.post("/join", { version: 7, code, localPort: 1 }, GUEST_IP).body.error, "full");
  assert.equal(s.post("/join", { version: 7, code: "1.2.3.4" }, GUEST_IP).body.error, "no-such-lobby");
});

test("only the host closes its lobby, and a quiet one is forgotten", () => {
  const s = server();
  const { code, secret } = s.post("/host", hostBody()).body;
  s.post("/close", { code, secret: "nope" }, GUEST_IP);
  assert.equal(s.lobbies.lobbies.size, 1);
  assert.equal(s.post("/update", { ...hostBody(), code, secret: "nope" }).status, 403);
  s.post("/close", { code, secret });
  assert.equal(s.lobbies.lobbies.size, 0);

  const reopened = s.post("/host", hostBody()).body;
  s.advance(15000);
  assert.equal(s.post("/update", { ...hostBody(), code: reopened.code, secret: reopened.secret }).status, 200);
  s.advance(21000);
  // Gone, and the host is told so -- and gets the same code back when it asks for it.
  assert.equal(s.post("/update", { ...hostBody(), code: reopened.code, secret: reopened.secret }).body.error, "no-such-lobby");
  assert.equal(s.post("/host", hostBody({ code: reopened.code })).body.code, reopened.code);
});

test("the public list shows public lobbies on the same version, and nothing else", () => {
  const s = server();
  s.post("/host", hostBody({ listed: true }), "1.1.1.1");
  s.post("/host", hostBody({ listed: false }), "1.1.1.2");
  s.post("/host", hostBody({ listed: true, version: 6 }), "1.1.1.3");
  const listing = s.get("/list?version=7", GUEST_IP);
  assert.equal(listing.body.lobbies.length, 1);
  assert.equal(listing.body.lobbies[0].name, "kitchen");
});

test("names are cleaned, addresses are checked, and nonsense is refused", () => {
  const s = server();
  const { code, secret } = s.post("/host", hostBody({ name: "x".repeat(80) + "", candidates: ["999.1.1.1:5", "1.2.3.4:0", "hello", "5.6.7.8:9"] })).body;
  const joined = s.post("/join", { version: 7, code, localPort: 3 }, GUEST_IP);
  assert.equal(joined.body.name.length, 24);
  assert.deepEqual(joined.body.candidates, ["5.6.7.8:9", "81.2.3.4:27015"]);
  assert.equal(s.post("/nowhere", {}).status, 404);
  assert.equal(secret.length > 0, true);
});

test("one address cannot flood it", () => {
  const s = server();
  let answered = 0;
  for (let i = 0; i < 300; ++i) {
    if (s.get("/list?version=7", "6.6.6.6").status === 200) ++answered;
  }
  assert.ok(answered < 60, `answered ${answered}`);
});
