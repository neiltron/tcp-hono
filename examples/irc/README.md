# IRC

An IRC server built with `tcp-hono`. It runs on Cloudflare Workers with a Durable Object, and on Node.js.

```sh
pnpm install
pnpm build          # at the root, to build tcp-hono
cd examples/irc
pnpm dev            # Cloudflare Workers (cf dev), or `pnpm dev:node` for Node.js
```

Connect with any IRC client to `localhost:6667` without TLS.

```sh
$ nc -C localhost 6667
NICK alice
USER alice 0 * :Alice
JOIN #hono
PRIVMSG #hono :Hello!
```

## How it works

- [`src/server.ts`](./src/server.ts) is the server. It is a Hono app and does not depend on a runtime. A command is a route, e.g. `app.on('TCP', '/PRIVMSG/:targets/:text', ...)`. The replies to the sender are the response, `c.render(['332', channel, topic])`, and the messages to the others are pushed with `connection.send()`.
- [`src/index.ts`](./src/index.ts) is for Cloudflare Workers. The `connect()` handler of the Worker pipes the socket to the `connect()` handler of one Durable Object, which holds all the connections. That is why a message from a client can be written to the sockets of the others.
- [`src/node.ts`](./src/node.ts) is for Node.js.

The users and the channels are in memory. An IRC channel disappears when the last member leaves, so nothing needs to be stored as long as the Durable Object stays in memory while it has a connection. A deploy or a restart of the object disconnects everyone, and the clients reconnect.

## What is implemented

- Registration: `CAP`, `NICK`, `USER`, `PASS` (ignored), `PING`, `PONG`, `QUIT`
- Channels: `JOIN`, `PART`, `TOPIC`, `NAMES`, `LIST`, `KICK`, `MODE` (`+o`, `+v`, `+m`, `+n`, `+t`)
- Messages: `PRIVMSG`, `NOTICE`, `AWAY`
- Queries: `WHO`, `WHOIS`, `MOTD`, `LUSERS`
- IRCv3: capability negotiation 3.2, `server-time`, `echo-message`, `multi-prefix`, `userhost-in-names`, `extended-join`, `away-notify`
- A client that does not answer a `PING` is disconnected.

## What is not implemented

- TLS. Spectrum terminates TLS for a Worker only on the Enterprise add-on, and `startTls()` is not supported for an inbound socket.
- Accounts (`SASL`), bans, invites, keys, operators, and server-to-server links.
- The address of the client. The Durable Object does not see it, so every user gets a random host.
- The other IRCv3 extensions, such as `message-tags`, `batch`, `labeled-response`, and `chathistory`.

It has no authentication and no flood protection. Do not expose it as is.
