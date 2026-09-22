// The lobby server, as a Cloudflare Worker.
//
// Every request goes to one Durable Object, which holds every open lobby in memory. One object is
// plenty: a lobby is a few hundred bytes and a request takes microseconds, and having one means the
// host and the guest always see the same lobby, wherever in the world their requests land.
//
// If the object is ever restarted its memory is gone, and every host finds out on its next update
// ("no-such-lobby") and opens its lobby again with the same code. Nothing is written to storage, so
// there is nothing to clean up and nothing to pay for.

import { DurableObject } from "cloudflare:workers";
import { Lobbies } from "./lobbies.js";

export class LobbyDirectory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.lobbies = new Lobbies({ log: (line) => console.log(line) });
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    if (request.method === "POST") {
      const text = await request.text();
      if (text.length > 4096) return json(413, { error: "too-big" });
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return json(400, { error: "malformed" });
      }
    }
    const clientIp = request.headers.get("CF-Connecting-IP") || "";
    const result = this.lobbies.handle(request.method, url.pathname, url.searchParams, body, clientIp);
    return json(result.status, result.body);
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const stub = env.LOBBIES.get(env.LOBBIES.idFromName("directory"));
    return stub.fetch(request);
  },
};
