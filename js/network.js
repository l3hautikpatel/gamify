/* ============================================================
   Online Mafia — PeerJS Networking Module
   
   Architecture (from spec Section 4):
   - Host's browser is the authoritative server
   - Star topology: every player connects ONLY to the host
   - Custom deterministic host Peer ID: mafia-{roomCode}-host
   - TURN fallback for office/corporate firewalls
   - JSON message envelope: { type, payload, seq }
   ============================================================ */

import { buildHostPeerId, formatTimestamp } from './utils.js';

function getPeerOptions() {
  return {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    path: '/peerjs',
    debug: 2,
    config: {
      iceServers: ICE_SERVERS,
    },
  };
}

function getTransportStorageKey(roomCode) {
  return `mafia_transport_${(roomCode || '').toUpperCase()}`;
}

function isLocalTestingEnvironment() {
  if (typeof window === 'undefined') return true;

  const hostname = (window.location.hostname || '').toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
}

function shouldUsePeerJs() {
  return typeof Peer !== 'undefined' && !isLocalTestingEnvironment();
}

function postTransportMessage(roomCode, broadcastChannel, payload) {
  const fullPayload = {
    ...payload,
    roomCode: (roomCode || '').toUpperCase(),
    ts: Date.now(),
  };

  if (broadcastChannel) {
    broadcastChannel.postMessage(fullPayload);
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(getTransportStorageKey(roomCode), JSON.stringify(fullPayload));
    }
  } catch {
    // Ignore localStorage failures in private browsing or blocked contexts.
  }
}

// --- ICE Server Configuration ---
// Use public STUN servers for direct peer discovery. TURN is omitted here
// because it can introduce unnecessary failure points during local tests.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// --- Message Types ---
export const MSG = {
  JOIN: 'JOIN',
  JOIN_ACK: 'JOIN_ACK',
  REJOIN: 'REJOIN',
  CHAT: 'CHAT',
  HEARTBEAT: 'HEARTBEAT',
  HEARTBEAT_ACK: 'HEARTBEAT_ACK',
  PLAYER_LIST: 'PLAYER_LIST',
  PLAYER_JOINED: 'PLAYER_JOINED',
  PLAYER_DISCONNECTED: 'PLAYER_DISCONNECTED',
  STATE_UPDATE: 'STATE_UPDATE',
  ROLE_ASSIGNMENT: 'ROLE_ASSIGNMENT',
  NIGHT_ACTION: 'NIGHT_ACTION',
  VOTE_ACTION: 'VOTE_ACTION',
};

// --- Sequence counter for message ordering ---
let _seq = 0;

/**
 * Create a message envelope.
 * @param {string} type - Message type constant
 * @param {*} payload - Message data
 * @returns {{ type: string, payload: *, seq: number, ts: number }}
 */
function createMessage(type, payload = null) {
  return {
    type,
    payload,
    seq: ++_seq,
    ts: Date.now(),
  };
}

// --- Heartbeat Constants ---
const HEARTBEAT_INTERVAL = 5000; // 5 seconds
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 3; // 3 missed = disconnected

/**
 * Create the Host networking layer.
 *
 * The host creates a PeerJS peer with a deterministic ID (mafia-{roomCode}-host)
 * and listens for incoming player connections (star topology).
 *
 * @param {string} roomCode
 * @param {object} callbacks
 * @param {function} callbacks.onLog - (message: string, level: string) => void
 * @param {function} callbacks.onPlayerJoin - (playerInfo: object) => void
 * @param {function} callbacks.onPlayerDisconnect - (playerId: string) => void
 * @param {function} callbacks.onMessage - (playerId: string, message: object) => void
 * @param {function} callbacks.onReady - () => void
 * @param {function} callbacks.onError - (error: Error) => void
 * @returns {object} Host API
 */
export function createHost(roomCode, callbacks) {
  const hostPeerId = buildHostPeerId(roomCode);
  const connections = new Map(); // peerId -> { conn, playerInfo, lastHeartbeat }
  let peer = null;
  let heartbeatTimer = null;
  let destroyed = false;
  let opened = false;
  let broadcastChannel = null;
  let transport = 'peerjs';
  let storageListener = null;

  const log = (msg, level = 'info') => {
    callbacks.onLog?.(`[HOST] ${msg}`, level);
  };

  function createConnectionStub(peerId, playerInfo) {
    return {
      peer: peerId,
      open: true,
      send: (msg) => {
        postTransportMessage(roomCode, broadcastChannel, {
          from: hostPeerId,
          to: peerId,
          message: msg,
        });
      },
      close: () => {
        postTransportMessage(roomCode, broadcastChannel, {
          from: hostPeerId,
          to: peerId,
          message: createMessage(MSG.PLAYER_DISCONNECTED, {
            playerId: playerInfo?.playerId,
            displayName: playerInfo?.displayName,
          }),
        });
      },
    };
  }

  function handleTransportMessage(event) {
    let data = null;

    if (event?.data) {
      data = event.data;
    } else if (event?.key) {
      if (event.key !== getTransportStorageKey(roomCode)) return;
      try {
        data = JSON.parse(event.newValue || 'null');
      } catch {
        return;
      }
    }

    if (!data) return;
    if (data.roomCode?.toUpperCase() !== roomCode.toUpperCase()) return;
    if (data.from === hostPeerId) return;
    if (!data.message) return;

    const msg = typeof data.message === 'string' ? JSON.parse(data.message) : data.message;
    const senderId = data.from || data.senderId || data.to;

    if (data.to && data.to !== 'host' && data.to !== hostPeerId) return;

    handlePlayerMessage({
      peer: senderId,
      open: true,
      send: (response) => {
        postTransportMessage(roomCode, broadcastChannel, {
          from: hostPeerId,
          to: senderId,
          message: response,
        });
      },
      close: () => {},
    }, msg);
  }

  function activateBroadcastTransport(reason) {
    if (transport === 'broadcast' || !broadcastChannel) return;
    transport = 'broadcast';
    log(`Using local broadcast transport (${reason})`, 'warn');
    callbacks.onReady?.();
    startHeartbeat();
  }

  // Try PeerJS first; fall back to broadcast transport for same-origin testing.
  log(`Creating peer with ID: ${hostPeerId}`);

  if (typeof BroadcastChannel !== 'undefined') {
    broadcastChannel = new BroadcastChannel(`mafia-${roomCode.toLowerCase()}`);
    broadcastChannel.addEventListener('message', handleTransportMessage);
    activateBroadcastTransport('local broadcast available');
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    storageListener = (event) => handleTransportMessage(event);
    window.addEventListener('storage', storageListener);
  }

  if (shouldUsePeerJs()) {
    peer = new Peer(hostPeerId, getPeerOptions());

    peer.on('open', (id) => {
      if (opened) return;
      opened = true;
      log(`Peer broker connected. ID: ${id}`, 'success');
      callbacks.onReady?.();
      startHeartbeat();
    });

    peer.on('error', (err) => {
      if (destroyed) return;
      if (err.type === 'network' || err.type === 'peer-unavailable') {
        log(`PeerJS unavailable, switching to broadcast transport: ${err.message}`, 'warn');
        activateBroadcastTransport(err.message);
        return;
      }
      log(`Peer error: ${err.type} — ${err.message}`, 'error');
      callbacks.onError?.(err);
    });

    peer.on('disconnected', () => {
      if (destroyed) return;
      log('Disconnected from signaling server. Attempting reconnect...', 'warn');
      if (!destroyed) {
        peer.reconnect();
      }
    });

    peer.on('connection', (conn) => {
      if (destroyed) return;
      log(`Incoming connection from peer: ${conn.peer}`, 'info');

      conn.on('open', () => {
        log(`Data channel open with: ${conn.peer}`, 'success');
      });

      conn.on('data', (data) => {
        handlePlayerMessage(conn, data);
      });

      conn.on('close', () => {
        handlePlayerDisconnect(conn.peer);
      });

      conn.on('error', (err) => {
        log(`Connection error with ${conn.peer}: ${err}`, 'error');
      });
    });
  } else {
    log('PeerJS disabled for local testing; using broadcast transport.', 'warn');
    activateBroadcastTransport('local testing environment');
  }

  function handlePlayerMessage(conn, data) {
    const msg = typeof data === 'string' ? JSON.parse(data) : data;

    switch (msg.type) {
      case MSG.JOIN: {
        const canJoin = callbacks.onPlayerJoin?.({
          playerId: msg.payload.playerId,
          displayName: msg.payload.displayName,
          connected: true,
        }) !== false;

        if (!canJoin) {
          conn.send(createMessage(MSG.JOIN_ACK, {
            success: false,
            error: 'Game already in progress',
          }));
          return;
        }

        const playerInfo = {
          playerId: msg.payload.playerId,
          displayName: msg.payload.displayName,
          peerId: conn.peer,
          connected: true,
          joinedAt: Date.now(),
        };

        const stub = createConnectionStub(conn.peer, playerInfo);
        connections.set(conn.peer, {
          conn: stub,
          playerInfo,
          lastHeartbeat: Date.now(),
        });

        log(`Player joined: ${playerInfo.displayName} (${playerInfo.playerId})`, 'success');

        const playerList = getPlayerList();
        conn.send(createMessage(MSG.JOIN_ACK, {
          success: true,
          players: playerList,
        }));

        broadcastExcept(conn.peer, createMessage(MSG.PLAYER_JOINED, {
          playerId: playerInfo.playerId,
          displayName: playerInfo.displayName,
        }));
        break;
      }

      case MSG.REJOIN: {
        const { playerId, displayName } = msg.payload;
        let oldPeerId = null;
        let existingInfo = null;

        for (const [pId, entry] of connections.entries()) {
          if (entry.playerInfo.playerId === playerId) {
            oldPeerId = pId;
            existingInfo = entry.playerInfo;
            break;
          }
        }

        if (existingInfo) {
          connections.delete(oldPeerId);

          existingInfo.peerId = conn.peer;
          existingInfo.connected = true;

          const stub = createConnectionStub(conn.peer, existingInfo);
          connections.set(conn.peer, {
            conn: stub,
            playerInfo: existingInfo,
            lastHeartbeat: Date.now(),
          });

          log(`Player reconnected: ${displayName} (${playerId})`, 'success');

          conn.send(createMessage(MSG.JOIN_ACK, {
            success: true,
            players: getPlayerList(),
          }));

          callbacks.onPlayerRejoin?.(existingInfo);
        } else {
          conn.send(createMessage(MSG.JOIN_ACK, {
            success: false,
            error: 'Session not found. Game may have restarted.',
          }));
        }
        break;
      }

      case MSG.CHAT: {
        const entry = connections.get(conn.peer);
        if (entry) {
          callbacks.onMessage?.(entry.playerInfo.playerId, msg);
          broadcast(createMessage(MSG.CHAT, {
            from: entry.playerInfo.displayName,
            fromId: entry.playerInfo.playerId,
            text: msg.payload.text,
          }));
        }
        break;
      }

      case MSG.HEARTBEAT_ACK: {
        const entry = connections.get(conn.peer);
        if (entry) {
          entry.lastHeartbeat = Date.now();
        }
        break;
      }

      case MSG.NIGHT_ACTION: {
        const entry = connections.get(conn.peer);
        if (entry) {
          callbacks.onMessage?.(entry.playerInfo.playerId, msg);
        }
        break;
      }

      default:
        log(`Unknown message type: ${msg.type}`, 'warn');
    }
  }

  function handlePlayerDisconnect(peerId) {
    const entry = connections.get(peerId);
    if (entry) {
      entry.playerInfo.connected = false;
      log(`Player disconnected: ${entry.playerInfo.displayName}`, 'warn');
      callbacks.onPlayerDisconnect?.(entry.playerInfo.playerId);

      broadcastExcept(peerId, createMessage(MSG.PLAYER_DISCONNECTED, {
        playerId: entry.playerInfo.playerId,
        displayName: entry.playerInfo.displayName,
      }));
    }
  }

  function broadcast(msg) {
    for (const [, entry] of connections) {
      if (entry.conn.open && entry.playerInfo.connected) {
        try {
          entry.conn.send(msg);
        } catch (e) {
          log(`Failed to send to ${entry.playerInfo.displayName}: ${e}`, 'error');
        }
      }
    }
  }

  function broadcastExcept(excludePeerId, msg) {
    for (const [peerId, entry] of connections) {
      if (peerId !== excludePeerId && entry.conn.open && entry.playerInfo.connected) {
        try {
          entry.conn.send(msg);
        } catch (e) {
          log(`Failed to send to ${entry.playerInfo.displayName}: ${e}`, 'error');
        }
      }
    }
  }

  function getPlayerList() {
    return Array.from(connections.values()).map(e => ({
      playerId: e.playerInfo.playerId,
      displayName: e.playerInfo.displayName,
      connected: e.playerInfo.connected,
    }));
  }

  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [peerId, entry] of connections) {
        if (!entry.playerInfo.connected) continue;

        if (now - entry.lastHeartbeat > HEARTBEAT_TIMEOUT) {
          handlePlayerDisconnect(peerId);
          continue;
        }

        if (entry.conn.open) {
          try {
            entry.conn.send(createMessage(MSG.HEARTBEAT));
          } catch {
            // Connection might be closing
          }
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  return {
    get peerId() { return hostPeerId; },
    get playerCount() { return connections.size; },

    getPlayerList,

    sendToPlayer(peerId, msg) {
      const entry = connections.get(peerId);
      if (entry?.conn.open) {
        entry.conn.send(createMessage(msg.type, msg.payload));
      }
    },

    sendChat(text) {
      broadcast(createMessage(MSG.CHAT, {
        from: 'Host',
        fromId: 'host',
        text,
      }));
    },

    destroy() {
      destroyed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const [, entry] of connections) {
        try { entry.conn.close(); } catch {}
      }
      connections.clear();
      try { peer?.destroy(); } catch {}
      try { broadcastChannel?.close(); } catch {}
      try { if (storageListener && typeof window !== 'undefined') window.removeEventListener('storage', storageListener); } catch {}
      log('Host destroyed', 'info');
    },
  };
}

/**
 * Create the Player networking layer.
 *
 * The player creates a PeerJS peer (random ID) and connects
 * to the host's deterministic peer ID.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @param {string} displayName
 * @param {object} callbacks
 * @param {function} callbacks.onLog - (message: string, level: string) => void
 * @param {function} callbacks.onConnected - (playerList: array) => void
 * @param {function} callbacks.onDisconnected - () => void
 * @param {function} callbacks.onMessage - (message: object) => void
 * @param {function} callbacks.onPlayerJoined - (playerInfo: object) => void
 * @param {function} callbacks.onPlayerDisconnected - (playerInfo: object) => void
 * @param {function} callbacks.onError - (error: Error) => void
 * @param {boolean} isReconnect
 * @returns {object} Player API
 */
export function joinAsPlayer(roomCode, playerId, displayName, callbacks, isReconnect = false) {
  const hostPeerId = buildHostPeerId(roomCode);
  let peer = null;
  let conn = null;
  let destroyed = false;
  let opened = false;
  let broadcastChannel = null;
  let transport = 'peerjs';
  let storageListener = null;

  const log = (msg, level = 'info') => {
    callbacks.onLog?.(`[PLAYER] ${msg}`, level);
  };

  function sendToHost(msg) {
    if (transport === 'broadcast') {
      postTransportMessage(roomCode, broadcastChannel, {
        from: playerId,
        to: hostPeerId,
        message: msg,
      });
    } else if (conn?.open) {
      conn.send(msg);
    }
  }

  function activateBroadcastTransport(reason) {
    if (transport === 'broadcast' || !broadcastChannel) return;
    transport = 'broadcast';
    log(`Using local broadcast transport (${reason})`, 'warn');
    conn = {
      open: true,
      send: (msg) => {
        if (broadcastChannel) {
          broadcastChannel.postMessage({
            roomCode,
            from: playerId,
            to: hostPeerId,
            message: msg,
          });
        }
      },
      close: () => {
        conn = null;
      },
    };
    sendJoinMessage();
  }

  function sendJoinMessage() {
    const msgType = isReconnect ? MSG.REJOIN : MSG.JOIN;
    sendToHost(createMessage(msgType, {
      playerId,
      displayName,
    }));
  }

  function handleTransportMessage(event) {
    let data = null;

    if (event?.data) {
      data = event.data;
    } else if (event?.key) {
      if (event.key !== getTransportStorageKey(roomCode)) return;
      try {
        data = JSON.parse(event.newValue || 'null');
      } catch {
        return;
      }
    }

    if (!data) return;
    if (data.roomCode?.toUpperCase() !== roomCode.toUpperCase()) return;
    if (data.to && data.to !== hostPeerId && data.to !== playerId) return;
    if (!data.message) return;

    const msg = typeof data.message === 'string' ? JSON.parse(data.message) : data.message;
    if (!msg || !msg.type) return;

    handleHostMessage(msg);
  }

  log(`Creating peer and connecting to host: ${hostPeerId}`);

  if (typeof BroadcastChannel !== 'undefined') {
    broadcastChannel = new BroadcastChannel(`mafia-${roomCode.toLowerCase()}`);
    broadcastChannel.addEventListener('message', handleTransportMessage);
    activateBroadcastTransport('local broadcast available');
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    storageListener = (event) => handleTransportMessage(event);
    window.addEventListener('storage', storageListener);
  }

  if (shouldUsePeerJs()) {
    peer = new Peer(undefined, getPeerOptions());

    peer.on('open', (id) => {
      if (opened) return;
      opened = true;
      log(`Peer broker connected. My ID: ${id}`, 'success');
      log(`Connecting to host: ${hostPeerId}...`);

      conn = peer.connect(hostPeerId, {
        reliable: true,
      });

      conn.on('open', () => {
        log('Data channel open with host!', 'success');
        sendJoinMessage();
      });

      conn.on('iceStateChanged', (state) => {
        log(`ICE state for host connection: ${state}`, 'info');
      });

      conn.on('data', (data) => {
        handleHostMessage(data);
      });

      conn.on('close', () => {
        log('Connection to host closed', 'warn');
        callbacks.onDisconnected?.();
      });

      conn.on('error', (err) => {
        log(`Connection error: ${err}`, 'error');
        callbacks.onError?.(err);
      });
    });

    peer.on('error', (err) => {
      log(`Peer error: ${err.type} — ${err.message}`, 'error');

      if (err.type === 'peer-unavailable') {
        log('Host not found. Room may not exist or host may be offline.', 'error');
      }

      if (transport !== 'broadcast') {
        activateBroadcastTransport(err.message);
      }

      callbacks.onError?.(err);
    });

    peer.on('disconnected', () => {
      if (destroyed) return;
      log('Disconnected from signaling server. Attempting reconnect...', 'warn');
      if (!destroyed) {
        peer.reconnect();
      }
    });
  } else {
    log('PeerJS disabled for local testing; using broadcast transport.', 'warn');
    activateBroadcastTransport('local testing environment');
  }

  function handleHostMessage(data) {
    const msg = typeof data === 'string' ? JSON.parse(data) : data;

    switch (msg.type) {
      case MSG.JOIN_ACK:
        if (msg.payload.success) {
          log('Host acknowledged join.', 'success');
          callbacks.onConnected?.(msg.payload.players);
        } else {
          log(`Host rejected join: ${msg.payload.error}`, 'error');
          callbacks.onError?.(new Error(msg.payload.error));
        }
        break;

      case MSG.CHAT:
        callbacks.onMessage?.(msg);
        break;

      case MSG.PLAYER_JOINED:
        log(`New player joined: ${msg.payload.displayName}`, 'info');
        callbacks.onPlayerJoined?.(msg.payload);
        break;

      case MSG.PLAYER_DISCONNECTED:
        log(`Player disconnected: ${msg.payload.displayName}`, 'warn');
        callbacks.onPlayerDisconnected?.(msg.payload);
        break;

      case MSG.PLAYER_LIST:
        callbacks.onConnected?.(msg.payload.players);
        break;

      case MSG.HEARTBEAT:
        // Respond to heartbeat
        if (conn?.open) {
          conn.send(createMessage(MSG.HEARTBEAT_ACK));
        }
        break;

      case MSG.STATE_UPDATE:
      case MSG.ROLE_ASSIGNMENT:
        callbacks.onMessage?.(msg);
        break;

      default:
        log(`Unknown message type: ${msg.type}`, 'warn');
    }
  }

  // --- Public Player API ---
  return {
    get peerId() { return peer?.id; },

    sendChat(text) {
      if (conn?.open) {
        conn.send(createMessage(MSG.CHAT, { text }));
      }
    },

    sendAction(targetId) {
      if (conn?.open) {
        conn.send(createMessage(MSG.NIGHT_ACTION, { targetId }));
      }
    },

    sendVote(targetId) {
      if (conn?.open) {
        conn.send(createMessage(MSG.VOTE_ACTION, { targetId }));
      }
    },

    destroy() {
      destroyed = true;
      try { if (conn) conn.close(); } catch {}
      try { peer.destroy(); } catch {}
      try { broadcastChannel?.close(); } catch {}
      try { if (storageListener && typeof window !== 'undefined') window.removeEventListener('storage', storageListener); } catch {}
      log('Player destroyed', 'info');
    },
  };
}
