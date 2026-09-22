// Everything the lobby server knows and decides, with no Cloudflare and no network in it.
//
// Three things run this file: the Cloudflare Worker (src/index.js), the local server used for
// testing on one PC (local-server.js), and the tests (test/lobbies.test.js). Time and randomness
// are passed in, so a test can run a whole lobby -- open, join, a host going quiet -- in a moment and
// get the same answer every time.
//
// What it does: hands a host a six-character code, tells a guest where the host might be, and tells
// the host where the guest might be. The two games then connect to each other directly. No game
// traffic ever comes here.

export const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 6;

const LIMITS = {
  maxLobbies: 2000,
  maxLobbiesPerIp: 16,
  // A host says it is still there every few seconds; after this long without a word the lobby is
  // gone and its code stops working.
  lobbyTimeoutMs: 20000,
  // A guest is remembered this long, so asking again gets the same introduction.
  guestMemoryMs: 30000,
  maxGuestsRemembered: 16,
  maxCandidates: 6,
  maxNameLength: 24,
  maxListed: 16,
  // Requests one address may make, and how fast that allowance refills.
  burst: 40,
  perSecond: 8,
};

export function defaultRandom(bytes) {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return out;
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  // Printable ASCII only: a lobby name is drawn on the screen of everybody who browses, and anybody
  // at all can open a lobby.
  return value.replace(/[^\x20-\x7E]/g, "?").slice(0, LIMITS.maxNameLength);
}

function cleanCode(value) {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!ALPHABET.includes(c)) return null;
  return code;
}

// "a.b.c.d:port", IPv4 only: the game's sockets are IPv4.
function cleanEndpoint(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1, 5).map(Number);
  const port = Number(match[5]);
  if (parts.some((p) => p > 255) || port < 1 || port > 65535) return null;
  return `${parts.join(".")}:${port}`;
}

function isIpv4(value) {
  return typeof value === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

// Where a game might be reached: what it says (the address a public STUN server saw, and its
// addresses inside its own network), plus one guess of ours -- the address its web request came
// from, with the port its game socket uses. Most home routers keep the port the same on the way
// out, so that guess is right more often than not when the game could not find out for itself.
function candidatesFrom(body, clientIp) {
  const out = [];
  const list = Array.isArray(body.candidates) ? body.candidates : [];
  for (const item of list) {
    const endpoint = cleanEndpoint(item);
    if (endpoint && !out.includes(endpoint)) out.push(endpoint);
    if (out.length >= LIMITS.maxCandidates - 1) break;
  }
  const localPort = Number(body.localPort);
  if (isIpv4(clientIp) && Number.isInteger(localPort) && localPort > 0 && localPort < 65536) {
    const guess = `${clientIp}:${localPort}`;
    if (!out.includes(guess)) out.push(guess);
  }
  return out.slice(0, LIMITS.maxCandidates);
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Lobbies {
  constructor({ now = () => Date.now(), random = defaultRandom, log = () => {} } = {}) {
    this.now = now;
    this.random = random;
    this.log = log;
    this.lobbies = new Map(); // code -> lobby
    this.senders = new Map(); // ip -> { tokens, last }
  }

  // One request. Returns { status, body } with body a plain object to send as JSON.
  handle(method, path, query, body, clientIp) {
    const now = this.now();
    this.expire(now);
    if (!this.allow(clientIp || "?", now)) {
      return { status: 429, body: { error: "too-fast" } };
    }
    body = body && typeof body === "object" ? body : {};
    try {
      if (method === "GET" && path === "/") return { status: 200, body: { ok: true, lobbies: this.lobbies.size } };
      if (method === "GET" && path === "/list") return this.list(query);
      if (method === "POST" && path === "/host") return this.host(body, clientIp, now);
      if (method === "POST" && path === "/update") return this.update(body, clientIp, now);
      if (method === "POST" && path === "/join") return this.join(body, clientIp, now);
      if (method === "POST" && path === "/close") return this.close(body);
    } catch (error) {
      return { status: 400, body: { error: "malformed" } };
    }
    return { status: 404, body: { error: "unknown-request" } };
  }

  allow(ip, now) {
    let sender = this.senders.get(ip);
    if (!sender) {
      if (this.senders.size > 50000) this.senders.clear();
      sender = { tokens: LIMITS.burst, last: now };
      this.senders.set(ip, sender);
    }
    sender.tokens = Math.min(sender.tokens + ((now - sender.last) / 1000) * LIMITS.perSecond, LIMITS.burst);
    sender.last = now;
    if (sender.tokens < 1) return false;
    sender.tokens -= 1;
    return true;
  }

  expire(now) {
    for (const [code, lobby] of this.lobbies) {
      if (now - lobby.lastHeard > LIMITS.lobbyTimeoutMs) {
        this.lobbies.delete(code);
        this.log(`forgot ${code}: its host went quiet`);
      }
    }
    for (const [ip, sender] of this.senders) {
      if (now - sender.last > 120000) this.senders.delete(ip);
    }
  }

  newCode() {
    for (let attempt = 0; attempt < 64; ++attempt) {
      const bytes = this.random(CODE_LENGTH);
      let code = "";
      for (const b of bytes) code += ALPHABET[b & 31];
      if (!this.lobbies.has(code)) return code;
    }
    return null;
  }

  describe(lobby, body) {
    lobby.version = Number(body.version) | 0;
    lobby.name = cleanName(body.name);
    lobby.listed = body.listed === true;
    lobby.started = body.started === true;
    lobby.players = Math.max(0, Math.min(Number(body.players) | 0, 15));
    lobby.maxPlayers = Math.max(1, Math.min(Number(body.maxPlayers) | 0 || 4, 15));
  }

  host(body, clientIp, now) {
    // The code it had before, if it asks for it and nobody else has it: a host that dropped off for
    // a moment, or found this server restarted, comes back as the same code, so anybody already
    // holding it can still use it.
    const asked = cleanCode(body.code);
    let code = asked && !this.lobbies.has(asked) ? asked : null;
    if (!code) {
      if (this.lobbies.size >= LIMITS.maxLobbies) return { status: 503, body: { error: "server-full" } };
      let fromHere = 0;
      for (const lobby of this.lobbies.values()) if (lobby.ip === clientIp) ++fromHere;
      if (fromHere >= LIMITS.maxLobbiesPerIp) return { status: 503, body: { error: "server-full" } };
      code = this.newCode();
      if (!code) return { status: 503, body: { error: "server-full" } };
    }
    const lobby = {
      code,
      secret: hex(this.random(8)),
      ip: clientIp,
      candidates: candidatesFrom(body, clientIp),
      guests: [],
      lastHeard: now,
    };
    this.describe(lobby, body);
    this.lobbies.set(code, lobby);
    this.log(`opened ${code} "${lobby.name}"${lobby.listed ? " (public)" : ""} for ${clientIp}`);
    return { status: 200, body: { code, secret: lobby.secret, seenIp: clientIp || "" } };
  }

  update(body, clientIp, now) {
    const code = cleanCode(body.code);
    const lobby = code ? this.lobbies.get(code) : null;
    // Forgotten -- the server restarted, or the host went quiet too long. Said, so the host opens it
    // again rather than going on updating a lobby nobody can find.
    if (!lobby) return { status: 404, body: { error: "no-such-lobby" } };
    if (lobby.secret !== body.secret) return { status: 403, body: { error: "not-yours" } };
    this.describe(lobby, body);
    lobby.ip = clientIp;
    lobby.candidates = candidatesFrom(body, clientIp);
    lobby.lastHeard = now;
    // Everybody who has asked to join since the host last heard, so it can start sending to them.
    // Each is handed over once, and again if the guest asks again: a guest keeps asking while it is
    // trying to get through, so a lost answer costs a second or two rather than the join.
    const guests = [];
    lobby.guests = lobby.guests.filter((guest) => now - guest.at <= LIMITS.guestMemoryMs);
    for (const guest of lobby.guests) {
      if (!guest.delivered) {
        guests.push({ token: guest.token, candidates: guest.candidates });
        guest.delivered = true;
      }
    }
    return { status: 200, body: { guests } };
  }

  join(body, clientIp, now) {
    const code = cleanCode(body.code);
    const lobby = code ? this.lobbies.get(code) : null;
    if (!lobby) return { status: 404, body: { error: "no-such-lobby" } };
    if ((Number(body.version) | 0) !== lobby.version) return { status: 409, body: { error: "wrong-version" } };

    const candidates = candidatesFrom(body, clientIp);
    let guest = lobby.guests.find((known) => known.ip === clientIp && known.localPort === Number(body.localPort));
    if (!guest) {
      if (lobby.players >= lobby.maxPlayers) return { status: 403, body: { error: "full" } };
      if (lobby.guests.length >= LIMITS.maxGuestsRemembered) lobby.guests.shift();
      guest = { token: hex(this.random(4)), ip: clientIp, localPort: Number(body.localPort), at: now };
      lobby.guests.push(guest);
      this.log(`introduced ${clientIp} to ${code}`);
    }
    guest.candidates = candidates;
    guest.at = now;
    guest.delivered = false; // tell the host again
    return {
      status: 200,
      body: { token: guest.token, name: lobby.name, started: lobby.started, candidates: lobby.candidates },
    };
  }

  close(body) {
    const code = cleanCode(body.code);
    const lobby = code ? this.lobbies.get(code) : null;
    if (lobby && lobby.secret === body.secret) {
      this.lobbies.delete(code);
      this.log(`closed ${code}`);
    }
    return { status: 200, body: {} };
  }

  list(query) {
    const version = Number(query.get ? query.get("version") : query.version) | 0;
    const open = [...this.lobbies.values()].filter((lobby) => lobby.listed && lobby.version === version);
    // Ones with room first, then by code, so the order holds still from one ask to the next.
    open.sort((a, b) => {
      const aRoom = a.players < a.maxPlayers;
      const bRoom = b.players < b.maxPlayers;
      return aRoom !== bRoom ? (aRoom ? -1 : 1) : a.code < b.code ? -1 : 1;
    });
    const lobbies = open.slice(0, LIMITS.maxListed).map((lobby) => ({
      code: lobby.code,
      name: lobby.name,
      players: lobby.players,
      maxPlayers: lobby.maxPlayers,
      started: lobby.started,
    }));
    return { status: 200, body: { lobbies } };
  }
}
