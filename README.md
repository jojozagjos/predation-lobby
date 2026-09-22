# Project Predation lobby server

Hands out lobby codes and introduces players, who then connect directly to each other. No game
traffic comes through here. It runs free on Cloudflare Workers.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jojozagjos/Project-Predation/tree/main/Tools/LobbyWorker)

See `Docs/SERVER.md` in the game's repository for the whole story, step by step.

| File | What it is |
| --- | --- |
| `src/lobbies.js` | Every decision the server makes: codes, introductions, the public list, limits |
| `src/index.js` | The Cloudflare side: a Worker that hands every request to one Durable Object |
| `wrangler.jsonc` | Cloudflare's configuration |
| `local-server.js` | The same server on your own PC, with a STUN responder, for testing (plain Node, nothing to install) |
| `test/` | `node --test "test/*.test.js"` |

## What it answers

All JSON. The game is the only thing meant to call these.

| Request | Body | Answer |
| --- | --- | --- |
| `POST /host` | version, name, listed, players, maxPlayers, started, localPort, candidates[, code] | code, secret |
| `POST /update` | code, secret, and the same as /host | guests: token and candidates of anybody joining |
| `POST /join` | version, code, localPort, candidates | token, name, started, candidates of the host |
| `POST /close` | code, secret | |
| `GET /list?version=N` | | lobbies: public ones on that version |

`candidates` are `"a.b.c.d:port"` strings: where a game might be reached. The server adds one guess of
its own -- the address the request came from with the game's port -- because most home routers keep a
port the same on the way out.
