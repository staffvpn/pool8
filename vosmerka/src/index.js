import { DurableObject } from 'cloudflare:workers';
import { handleFetch, LobbyCore, MatchCore } from './core.js';

export default {
  fetch(request, env) { return handleFetch(request, env); },
};

export class Lobby extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new LobbyCore(ctx, env); }
  fetch(request) { return this.core.fetch(request); }
  webSocketMessage(ws, msg) { return this.core.webSocketMessage(ws, msg); }
  webSocketClose(ws) { return this.core.webSocketClose(ws); }
  webSocketError(ws) { return this.core.webSocketError(ws); }
}

export class MatchRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new MatchCore(ctx, env); }
  fetch(request) { return this.core.fetch(request); }
  webSocketMessage(ws, msg) { return this.core.webSocketMessage(ws, msg); }
  webSocketClose(ws) { return this.core.webSocketClose(ws); }
  webSocketError(ws) { return this.core.webSocketError(ws); }
  alarm() { return this.core.alarm(); }
}
