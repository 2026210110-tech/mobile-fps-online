import { DurableObject } from 'cloudflare:workers';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const id = env.ROOMS.idFromName('mobile-fps-global');
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class RoomHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket endpoint', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets() {
    return this.ctx.getWebSockets();
  }

  attachment(ws) {
    return ws.deserializeAttachment() || null;
  }

  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }

  broadcastRoom(room, data, exceptId = null) {
    for (const ws of this.sockets()) {
      const p = this.attachment(ws);
      if (!p || p.room !== room || p.id === exceptId) continue;
      this.send(ws, data);
    }
  }

  players(room) {
    const out = [];
    for (const ws of this.sockets()) {
      const p = this.attachment(ws);
      if (p && p.room === room) out.push(p);
    }
    return out;
  }

  webSocketMessage(ws, message) {
    let d;
    try { d = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); } catch (_) { return; }

    if (d.t === 'join') {
      const room = String(d.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      if (!room) return;
      const old = this.attachment(ws);
      const p = {
        id: String(d.id || crypto.randomUUID()).slice(0, 32),
        room,
        name: String(d.name || 'PLAYER').slice(0, 14),
        skin: Number(d.skin) || 0,
        px: Number(d.px) || 0,
        pz: Number(d.pz) || 0,
        yaw: Number(d.yaw) || 0,
        view: d.view || 'first'
      };
      ws.serializeAttachment(p);
      this.send(ws, { t: 'welcome', room, id: p.id });
      if (old?.room && old.room !== room) this.broadcastRoom(old.room, { t: 'players', players: this.players(old.room) });
      this.broadcastRoom(room, { t: 'players', players: this.players(room) });
      return;
    }

    if (d.t === 'state') {
      const p = this.attachment(ws);
      if (!p?.room) return;
      p.name = String(d.name ?? p.name).slice(0, 14);
      p.skin = Number(d.skin) || 0;
      p.px = Number(d.px) || 0;
      p.pz = Number(d.pz) || 0;
      p.yaw = Number(d.yaw) || 0;
      p.view = d.view || 'first';
      ws.serializeAttachment(p);
      this.broadcastRoom(p.room, { t: 'players', players: this.players(p.room) });
    }
  }

  webSocketClose(ws) {
    const p = this.attachment(ws);
    if (p?.room) {
      this.broadcastRoom(p.room, { t: 'left', id: p.id });
      this.broadcastRoom(p.room, { t: 'players', players: this.players(p.room) });
    }
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}
