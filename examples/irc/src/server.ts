import type { ContextRenderer } from 'hono'
import { Hono, getConnection } from 'tcp-hono'
import type { Connection, TCPOptions } from 'tcp-hono'
import { format, irc, parse } from 'tcp-hono/irc'
import type { IRCMessage } from 'tcp-hono/irc'

/** A line from the server. The nickname of the client is inserted into a numeric reply. */
type Line = [command: string, ...params: (string | number)[]]

declare module 'hono' {
  interface ContextRenderer {
    (...lines: Line[]): Response
  }
}

export type ServerOptions = {
  /** The server name, which is the source of the replies. */
  name?: string
  network?: string
  motd?: string[]
  /** A client that is silent for this long gets a PING, and is disconnected after twice as long. */
  pingInterval?: number
}

const VERSION = 'tcp-hono-irc-0.1'
const NICK_PATTERN = /^[A-Za-z_[\]\\`^{}|][A-Za-z0-9_\-[\]\\`^{}|]{0,29}$/
const CHANNEL_PATTERN = /^#[^\s,:\x07]{1,49}$/
const TOPIC_LENGTH = 390
const MAX_CHANNELS = 50
const CAPABILITIES = [
  'away-notify',
  'cap-notify',
  'echo-message',
  'extended-join',
  'multi-prefix',
  'server-time',
  'userhost-in-names',
]
const BEFORE_REGISTRATION = new Set(['CAP', 'NICK', 'USER', 'PASS', 'PING', 'PONG', 'QUIT'])
const PREFIXES = { o: '@', v: '+' } as const
type Rank = keyof typeof PREFIXES

// CASEMAPPING=ascii
const fold = (name: string) => name.toLowerCase()

class Client {
  nick = '*'
  user = ''
  realname = ''
  /** The real address is not exposed to the other users. */
  host = `${crypto.randomUUID().slice(0, 8)}.user`
  registered = false
  /** Registration is suspended between `CAP LS`/`CAP REQ` and `CAP END`. */
  negotiating = false
  capabilities = new Set<string>()
  channels = new Set<Channel>()
  invisible = false
  away?: string
  quit?: string
  signon = Date.now()
  active = Date.now()
  pinged = false

  connection: Connection

  constructor(connection: Connection) {
    this.connection = connection
  }

  get mask() {
    return `${this.nick}!${this.user}@${this.host}`
  }

  format(message: IRCMessage): string {
    const tags: Record<string, string> = {}
    if (this.capabilities.has('server-time')) {
      tags.time = new Date().toISOString()
    }
    return format({ ...message, tags })
  }

  send(source: string, command: string, ...params: string[]) {
    this.connection.send(this.format({ source, command, params }) + '\r\n')
  }
}

class Channel {
  topic?: { text: string; by: string; at: number }
  members = new Map<Client, Set<Rank>>()
  modes = new Set(['n', 't'])
  created = Math.floor(Date.now() / 1000)

  name: string

  constructor(name: string) {
    this.name = name
  }

  send(source: string, command: string, ...params: string[]) {
    for (const member of this.members.keys()) {
      member.send(source, command, ...params)
    }
  }

  prefix(client: Client, all = false) {
    const ranks = this.members.get(client)
    const prefixes = (Object.keys(PREFIXES) as Rank[])
      .filter((rank) => ranks?.has(rank))
      .map((rank) => PREFIXES[rank])
    return all ? prefixes.join('') : (prefixes[0] ?? '')
  }
}

type Env = {
  Variables: {
    client: Client
    message: IRCMessage
  }
}

/**
 * An IRC server. The state is in memory and it does not depend on a runtime.
 * It handles one connection at a time, like a Durable Object does.
 */
export const createServer = (config: ServerOptions = {}) => {
  const name = config.name ?? 'irc.tcp-hono.local'
  const network = config.network ?? 'TCPHono'
  const motd = config.motd ?? ['Hono beyond HTTP.']
  const pingInterval = config.pingInterval ?? 90_000
  const created = new Date()

  const clients = new Map<Connection, Client>()
  const nicks = new Map<string, Client>()
  const channels = new Map<string, Channel>()

  /** The clients that share a channel with the client, without the client. */
  const peers = (client: Client) => {
    const result = new Set<Client>()
    for (const channel of client.channels) {
      for (const member of channel.members.keys()) {
        result.add(member)
      }
    }
    result.delete(client)
    return result
  }

  const leave = (client: Client, channel: Channel) => {
    channel.members.delete(client)
    client.channels.delete(channel)
    if (!channel.members.size) {
      channels.delete(fold(channel.name))
    }
  }

  const topic = (channel: Channel): Line[] =>
    channel.topic
      ? [
          ['332', channel.name, channel.topic.text],
          ['333', channel.name, channel.topic.by, channel.topic.at],
        ]
      : [['331', channel.name, 'No topic is set']]

  const names = (client: Client, channel: Channel): Line[] => {
    const lines: Line[] = []
    const all = client.capabilities.has('multi-prefix')
    const userhost = client.capabilities.has('userhost-in-names')
    let chunk: string[] = []
    for (const member of channel.members.keys()) {
      chunk.push(channel.prefix(member, all) + (userhost ? member.mask : member.nick))
      if (chunk.join(' ').length > 350) {
        lines.push(['353', '=', channel.name, chunk.join(' ')])
        chunk = []
      }
    }
    if (chunk.length) {
      lines.push(['353', '=', channel.name, chunk.join(' ')])
    }
    return [...lines, ['366', channel.name, 'End of /NAMES list']]
  }

  const motdLines = (): Line[] =>
    motd.length
      ? [
          ['375', `- ${name} Message of the day -`],
          ...motd.map((text): Line => ['372', `- ${text}`]),
          ['376', 'End of /MOTD command'],
        ]
      : [['422', 'MOTD File is missing']]

  const lusers = (): Line[] => [
    ['251', `There are ${nicks.size} users and 0 invisible on 1 servers`],
    ['254', channels.size, 'channels formed'],
    ['255', `I have ${nicks.size} clients and 0 servers`],
  ]

  /** Complete the registration if the client has sent everything. Returns the welcome messages. */
  const register = (client: Client): Line[] => {
    if (client.registered || client.negotiating || client.nick === '*' || !client.user) {
      return []
    }
    client.registered = true
    return [
      ['001', `Welcome to the ${network} Network, ${client.mask}`],
      ['002', `Your host is ${name}, running version ${VERSION}`],
      ['003', `This server was created ${created.toUTCString()}`],
      ['004', name, VERSION, 'i', 'mntov'],
      [
        '005',
        'CASEMAPPING=ascii',
        'CHANTYPES=#',
        'CHANMODES=,,,mnt',
        'PREFIX=(ov)@+',
        'NICKLEN=30',
        'CHANNELLEN=50',
        `TOPICLEN=${TOPIC_LENGTH}`,
        `CHANLIMIT=#:${MAX_CHANNELS}`,
        `NETWORK=${network}`,
        'are supported by this server',
      ],
      ...lusers(),
      ...motdLines(),
    ]
  }

  const app = new Hono<Env>()

  app.use('*', async (c, next) => {
    const client = clients.get(getConnection(c))!
    const message = parse(await c.req.text())!
    client.active = Date.now()
    client.pinged = false
    c.set('client', client)
    c.set('message', message)
    c.setRenderer(((...lines: Line[]) =>
      lines.length
        ? c.text(
            lines
              .map(([command, ...params]) =>
                client.format({
                  source: name,
                  command,
                  params: [
                    ...(/^\d{3}$/.test(command) ? [client.nick] : []),
                    ...params.map(String),
                  ],
                })
              )
              .join('\r\n')
          )
        : c.body(null)) as ContextRenderer)

    if (!client.registered && !BEFORE_REGISTRATION.has(message.command)) {
      return c.render(['451', 'You have not registered'])
    }
    await next()
  })

  // Connection registration

  app.on('TCP', '/CAP/:subcommand/*', (c) => {
    const { client, message } = c.var
    const subcommand = c.req.param('subcommand').toUpperCase()
    const target = client.nick

    if (subcommand === 'LS') {
      client.negotiating ||= !client.registered
      return c.render(['CAP', target, 'LS', CAPABILITIES.join(' ')])
    }
    if (subcommand === 'LIST') {
      return c.render(['CAP', target, 'LIST', [...client.capabilities].join(' ')])
    }
    if (subcommand === 'REQ') {
      client.negotiating ||= !client.registered
      const requested = message.params.at(-1) ?? ''
      const changes = requested.split(' ').filter(Boolean)
      if (!changes.every((cap) => CAPABILITIES.includes(cap.replace(/^-/, '')))) {
        return c.render(['CAP', target, 'NAK', requested])
      }
      for (const cap of changes) {
        if (cap[0] === '-') {
          client.capabilities.delete(cap.slice(1))
        } else {
          client.capabilities.add(cap)
        }
      }
      return c.render(['CAP', target, 'ACK', requested])
    }
    if (subcommand === 'END') {
      client.negotiating = false
      return c.render(...register(client))
    }
    return c.render(['410', subcommand, 'Invalid CAP command'])
  })

  app.on('TCP', '/PASS/*', (c) => c.render())

  app.on('TCP', '/NICK/:nick', (c) => {
    const { client } = c.var
    const nick = c.req.param('nick')
    if (!NICK_PATTERN.test(nick)) {
      return c.render(['432', nick, 'Erroneous nickname'])
    }
    const owner = nicks.get(fold(nick))
    if (owner && owner !== client) {
      return c.render(['433', nick, 'Nickname is already in use'])
    }
    if (nick === client.nick) {
      return c.render()
    }
    if (client.registered) {
      for (const target of [client, ...peers(client)]) {
        target.send(client.mask, 'NICK', nick)
      }
    }
    nicks.delete(fold(client.nick))
    nicks.set(fold(nick), client)
    client.nick = nick
    return c.render(...register(client))
  })

  app.on('TCP', '/USER/:user/:mode/:unused/:realname', (c) => {
    const { client } = c.var
    if (client.registered) {
      return c.render(['462', 'You may not reregister'])
    }
    // The username is not verified with Ident.
    client.user =
      '~' +
      (c.req
        .param('user')
        .replace(/[^\w.-]/g, '')
        .slice(0, 10) || 'user')
    client.realname = c.req.param('realname')
    return c.render(...register(client))
  })

  app.on('TCP', '/PING/:token', (c) => c.render(['PONG', name, c.req.param('token')]))

  app.on('TCP', '/PONG/*', (c) => c.render())

  app.on('TCP', '/QUIT/*', (c) => {
    const { client, message } = c.var
    client.quit = `Quit: ${message.params[0] ?? ''}`.trim()
    // The connection is closed after the response, and the others are notified in `onClose()`.
    c.header('Connection', 'close')
    return c.text(`ERROR :Closing Link: ${client.host} (${client.quit})`)
  })

  // Channels

  app.on('TCP', '/JOIN/:channels/*', (c) => {
    const { client } = c.var
    const lines: Line[] = []

    if (c.req.param('channels') === '0') {
      for (const channel of client.channels) {
        channel.send(client.mask, 'PART', channel.name)
        leave(client, channel)
      }
      return c.render()
    }

    for (const channelName of c.req.param('channels').split(',')) {
      if (!CHANNEL_PATTERN.test(channelName)) {
        lines.push(['403', channelName, 'No such channel'])
        continue
      }
      let channel = channels.get(fold(channelName))
      if (channel?.members.has(client)) {
        continue
      }
      if (client.channels.size >= MAX_CHANNELS) {
        lines.push(['405', channelName, 'You have joined too many channels'])
        continue
      }
      if (!channel) {
        channel = new Channel(channelName)
        channels.set(fold(channelName), channel)
      }
      // The first member is the operator.
      channel.members.set(client, new Set(channel.members.size ? [] : ['o']))
      client.channels.add(channel)

      for (const member of channel.members.keys()) {
        if (member.capabilities.has('extended-join')) {
          // `*` means that the client is not logged in to an account.
          member.send(client.mask, 'JOIN', channel.name, '*', client.realname)
        } else {
          member.send(client.mask, 'JOIN', channel.name)
        }
        if (member !== client && client.away && member.capabilities.has('away-notify')) {
          member.send(client.mask, 'AWAY', client.away)
        }
      }
      if (channel.topic) {
        lines.push(...topic(channel))
      }
      lines.push(...names(client, channel))
    }
    return c.render(...lines)
  })

  app.on('TCP', '/PART/:channels/*', (c) => {
    const { client, message } = c.var
    const lines: Line[] = []
    for (const channelName of c.req.param('channels').split(',')) {
      const channel = channels.get(fold(channelName))
      if (!channel) {
        lines.push(['403', channelName, 'No such channel'])
      } else if (!channel.members.has(client)) {
        lines.push(['442', channel.name, "You're not on that channel"])
      } else {
        channel.send(client.mask, 'PART', channel.name, ...message.params.slice(1, 2))
        leave(client, channel)
      }
    }
    return c.render(...lines)
  })

  app.on('TCP', '/TOPIC/:channel/*', (c) => {
    const { client, message } = c.var
    const channel = channels.get(fold(c.req.param('channel')))
    if (!channel) {
      return c.render(['403', c.req.param('channel'), 'No such channel'])
    }
    // `TOPIC #channel` asks for the topic and `TOPIC #channel :` clears it,
    // so the parameter is taken from the message. A path can not have an empty segment.
    const text = message.params[1]
    if (text === undefined) {
      return c.render(...topic(channel))
    }
    const ranks = channel.members.get(client)
    if (!ranks) {
      return c.render(['442', channel.name, "You're not on that channel"])
    }
    if (channel.modes.has('t') && !ranks.has('o')) {
      return c.render(['482', channel.name, "You're not channel operator"])
    }
    channel.topic = text
      ? { text: text.slice(0, TOPIC_LENGTH), by: client.mask, at: Math.floor(Date.now() / 1000) }
      : undefined
    channel.send(client.mask, 'TOPIC', channel.name, channel.topic?.text ?? '')
    return c.render()
  })

  app.on('TCP', '/NAMES/:channels/*', (c) => {
    const lines = c.req
      .param('channels')
      .split(',')
      .flatMap((channelName): Line[] => {
        const channel = channels.get(fold(channelName))
        return channel ? names(c.var.client, channel) : [['366', channelName, 'End of /NAMES list']]
      })
    return c.render(...lines)
  })

  app.on('TCP', '/LIST/*', (c) => {
    return c.render(
      ['321', 'Channel', 'Users  Name'],
      ...[...channels.values()].map((channel): Line => [
        '322',
        channel.name,
        channel.members.size,
        channel.topic?.text ?? '',
      ]),
      ['323', 'End of /LIST']
    )
  })

  app.on('TCP', '/KICK/:channel/:nick/*', (c) => {
    const { client, message } = c.var
    const channel = channels.get(fold(c.req.param('channel')))
    if (!channel) {
      return c.render(['403', c.req.param('channel'), 'No such channel'])
    }
    if (!channel.members.get(client)?.has('o')) {
      return c.render(['482', channel.name, "You're not channel operator"])
    }
    const target = nicks.get(fold(c.req.param('nick')))
    if (!target || !channel.members.has(target)) {
      return c.render(['441', c.req.param('nick'), channel.name, "They aren't on that channel"])
    }
    channel.send(client.mask, 'KICK', channel.name, target.nick, message.params[2] ?? client.nick)
    leave(target, channel)
    return c.render()
  })

  // Messages

  app.on('TCP', '/:command{PRIVMSG|NOTICE}/:targets/:text', (c) => {
    const { client } = c.var
    const { command, text } = c.req.param()
    // An automatic reply must not be sent in response to a NOTICE.
    const lines: Line[] = []

    for (const targetName of c.req.param('targets').split(',')) {
      const channel = channels.get(fold(targetName))
      if (channel) {
        const ranks = channel.members.get(client)
        if (
          (channel.modes.has('n') && !ranks) ||
          (channel.modes.has('m') && !ranks?.has('o') && !ranks?.has('v'))
        ) {
          lines.push(['404', channel.name, 'Cannot send to channel'])
          continue
        }
        for (const member of channel.members.keys()) {
          if (member !== client || client.capabilities.has('echo-message')) {
            member.send(client.mask, command, channel.name, text)
          }
        }
        continue
      }
      const target = nicks.get(fold(targetName))
      if (!target?.registered) {
        lines.push(['401', targetName, 'No such nick/channel'])
        continue
      }
      target.send(client.mask, command, target.nick, text)
      if (client.capabilities.has('echo-message') && target !== client) {
        client.send(client.mask, command, target.nick, text)
      }
      if (target.away !== undefined) {
        lines.push(['301', target.nick, target.away])
      }
    }
    return command === 'NOTICE' ? c.render() : c.render(...lines)
  })

  app.on('TCP', '/AWAY/*', (c) => {
    const { client, message } = c.var
    client.away = message.params[0] || undefined
    for (const peer of peers(client)) {
      if (peer.capabilities.has('away-notify')) {
        peer.send(client.mask, 'AWAY', ...(client.away ? [client.away] : []))
      }
    }
    return client.away
      ? c.render(['306', 'You have been marked as being away'])
      : c.render(['305', 'You are no longer marked as being away'])
  })

  // Modes

  app.on('TCP', '/MODE/:target/*', (c) => {
    const { client, message } = c.var
    const targetName = c.req.param('target')
    const [, modes, ...args] = message.params

    const channel = channels.get(fold(targetName))
    if (!channel) {
      if (CHANNEL_PATTERN.test(targetName)) {
        return c.render(['403', targetName, 'No such channel'])
      }
      if (fold(targetName) !== fold(client.nick)) {
        return c.render(['502', "Can't change mode for other users"])
      }
      if (modes) {
        const adding = modes[0] !== '-'
        if (modes.replace(/[+-]/g, '') !== 'i') {
          return c.render(['501', 'Unknown MODE flag'])
        }
        client.invisible = adding
        client.send(client.nick, 'MODE', client.nick, (adding ? '+' : '-') + 'i')
        return c.render()
      }
      return c.render(['221', client.invisible ? '+i' : '+'])
    }

    if (!modes) {
      return c.render(
        ['324', channel.name, '+' + [...channel.modes].sort().join('')],
        ['329', channel.name, channel.created]
      )
    }

    const lines: Line[] = []
    const changes: { adding: boolean; mode: string; arg?: string }[] = []
    const operator = channel.members.get(client)?.has('o')
    let adding = true
    for (const mode of modes) {
      if (mode === '+' || mode === '-') {
        adding = mode === '+'
      } else if (mode === 'b' && !args.length) {
        // Clients ask for the ban list on joining. Bans are not implemented, so it is empty.
        lines.push(['368', channel.name, 'End of channel ban list'])
      } else if (!operator) {
        lines.push(['482', channel.name, "You're not channel operator"])
        break
      } else if (mode === 'o' || mode === 'v') {
        const nick = args.shift()
        const target = nick ? nicks.get(fold(nick)) : undefined
        const ranks = target && channel.members.get(target)
        if (!nick) {
          continue
        }
        if (!target || !ranks) {
          lines.push(['441', nick, channel.name, "They aren't on that channel"])
        } else if (ranks.has(mode) !== adding) {
          ranks[adding ? 'add' : 'delete'](mode)
          changes.push({ adding, mode, arg: target.nick })
        }
      } else if ('mnt'.includes(mode)) {
        if (channel.modes.has(mode) !== adding) {
          channel.modes[adding ? 'add' : 'delete'](mode)
          changes.push({ adding, mode })
        }
      } else {
        lines.push(['472', mode, 'is unknown mode char to me'])
      }
    }

    if (changes.length) {
      let sign: boolean | undefined
      let modestring = ''
      for (const change of changes) {
        if (change.adding !== sign) {
          sign = change.adding
          modestring += sign ? '+' : '-'
        }
        modestring += change.mode
      }
      const modeArgs = changes.flatMap((change) => change.arg ?? [])
      channel.send(client.mask, 'MODE', channel.name, modestring, ...modeArgs)
    }
    return c.render(...lines)
  })

  // Queries

  app.on('TCP', '/WHO/:mask/*', (c) => {
    const mask = c.req.param('mask')
    const channel = channels.get(fold(mask))
    const user = nicks.get(fold(mask))
    const row = (target: Client, channel?: Channel): Line => [
      '352',
      channel?.name ?? '*',
      target.user,
      target.host,
      name,
      target.nick,
      (target.away === undefined ? 'H' : 'G') + (channel?.prefix(target) ?? ''),
      `0 ${target.realname}`,
    ]
    return c.render(
      ...(channel
        ? [...channel.members.keys()].map((member) => row(member, channel))
        : user
          ? [row(user)]
          : []),
      ['315', mask, 'End of /WHO list']
    )
  })

  app.on('TCP', '/WHOIS/*', (c) => {
    const nick = c.var.message.params.at(-1)
    if (!nick) {
      return c.render(['431', 'No nickname given'])
    }
    const target = nicks.get(fold(nick))
    if (!target?.registered) {
      return c.render(['401', nick, 'No such nick/channel'], ['318', nick, 'End of /WHOIS list'])
    }
    const joined = [...target.channels].map((channel) => channel.prefix(target) + channel.name)
    return c.render(
      ['311', target.nick, target.user, target.host, '*', target.realname],
      ...(joined.length ? [['319', target.nick, joined.join(' ')] satisfies Line] : []),
      ['312', target.nick, name, network],
      ...(target.away !== undefined ? [['301', target.nick, target.away] satisfies Line] : []),
      [
        '317',
        target.nick,
        Math.floor((Date.now() - target.active) / 1000),
        Math.floor(target.signon / 1000),
        'seconds idle, signon time',
      ],
      ['318', target.nick, 'End of /WHOIS list']
    )
  })

  app.on('TCP', '/MOTD/*', (c) => c.render(...motdLines()))

  app.on('TCP', '/LUSERS/*', (c) => c.render(...lusers()))

  // A command that is not routed: unknown, or without the required parameters.
  const commands = new Set(app.routes.flatMap((route) => route.path.match(/[A-Z]{2,}/g) ?? []))
  app.notFound((c) => {
    const { command } = c.var.message
    return commands.has(command)
      ? c.render(['461', command, 'Not enough parameters'])
      : c.render(['421', command, 'Unknown command'])
  })

  app.onError((error, c) => {
    console.error(error)
    return c.render(['NOTICE', c.var.client.nick, 'Internal server error'])
  })

  const options: TCPOptions = {
    protocol: irc(),
    onOpen: (connection) => {
      clients.set(connection, new Client(connection))
    },
    onClose: (connection) => {
      const client = clients.get(connection)!
      clients.delete(connection)
      if (nicks.get(fold(client.nick)) === client) {
        nicks.delete(fold(client.nick))
      }
      for (const peer of peers(client)) {
        peer.send(client.mask, 'QUIT', client.quit ?? 'Connection closed')
      }
      for (const channel of client.channels) {
        leave(client, channel)
      }
    },
  }

  /** Find the clients that have gone without closing the connection. Call it periodically. */
  const tick = () => {
    const now = Date.now()
    for (const client of clients.values()) {
      const silent = now - client.active
      if (silent > pingInterval * 2 || (!client.registered && silent > pingInterval)) {
        client.quit = client.registered ? 'Ping timeout' : 'Registration timeout'
        client.connection.send(`ERROR :Closing Link: ${client.host} (${client.quit})\r\n`)
        client.connection.close()
      } else if (silent > pingInterval && !client.pinged) {
        client.pinged = true
        client.connection.send(`PING :${name}\r\n`)
      }
    }
  }

  return { app, options, tick, clients, channels }
}
