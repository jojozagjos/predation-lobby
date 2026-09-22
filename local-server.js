// The lobby server on this PC, for testing without Cloudflare. Nothing to install: plain Node.
//
//   node Tools/LobbyWorker/local-server.js [httpPort] [stunPort]
//
// Then, in each copy of the game's console:
//
//   lobby_use http://127.0.0.1:8787 127.0.0.1:3478
//
// It runs the same lobby code the Worker does, and a STUN responder in place of the public ones, so
// the games learn their "outside" address from it exactly as they would from Cloudflare's.

import http from "node:http";
import dgram from "node:dgram";
import { webcrypto } from "node:crypto";
import { Lobbies } from "./src/lobbies.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const httpPort = Number(process.argv[2] || 8787);
const stunPort = Number(process.argv[3] || 3478);
const lobbies = new Lobbies({ log: (line) => console.log(`[lobby] ${line}`) });

http
  .createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
      if (text.length > 4096) request.destroy();
    });
    request.on("end", () => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = null;
      }
      // Local requests come from 127.0.0.1, which is also what the STUN responder sees.
      const ip = (request.socket.remoteAddress || "").replace(/^::ffff:/, "");
      const result =
        body === null
          ? { status: 400, body: { error: "malformed" } }
          : lobbies.handle(request.method, url.pathname, url.searchParams, body, ip);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  })
  .listen(httpPort, "0.0.0.0", () => console.log(`[lobby] http://127.0.0.1:${httpPort}`));

// STUN: answer a binding request with the address it came from (RFC 5389, XOR-MAPPED-ADDRESS).
const MAGIC = 0x2112a442;
const stun = dgram.createSocket("udp4");
stun.on("message", (message, from) => {
  if (message.length < 20 || message.readUInt16BE(0) !== 0x0001 || message.readUInt32BE(4) !== MAGIC) return;
  const reply = Buffer.alloc(32);
  reply.writeUInt16BE(0x0101, 0); // binding success
  reply.writeUInt16BE(12, 2); // one 12-byte attribute
  reply.writeUInt32BE(MAGIC, 4);
  message.copy(reply, 8, 8, 20); // transaction
  reply.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
  reply.writeUInt16BE(8, 22);
  reply.writeUInt8(0, 24);
  reply.writeUInt8(1, 25); // IPv4
  reply.writeUInt16BE(from.port ^ (MAGIC >>> 16), 26);
  const octets = from.address.split(".").map(Number);
  const address = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  reply.writeUInt32BE((address ^ MAGIC) >>> 0, 28);
  stun.send(reply, from.port, from.address);
});
stun.bind(stunPort, "0.0.0.0", () => console.log(`[lobby] stun on udp ${stunPort}`));
