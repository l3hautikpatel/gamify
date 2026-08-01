/* ============================================================
   Online Mafia — PeerJS Networking Module
   
   Architecture (from spec Section 4):
   - Host's browser is the authoritative server
   - Star topology: every player connects ONLY to the host
   - Custom deterministic host Peer ID: mafia-{roomCode}-host
   - TURN fallback for office/corporate firewalls
   - JSON message envelope: { type, payload, seq }
   ============================================================ */

import { buildHostPeerId } from './utils.js';

// --- ICE Server Configuration ---
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Free TURN servers for mobile / cross-network connectivity
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

// --- PeerJS connection options ---
function getPeerOptions() {
  return {
    debug: 1,
    config: {
      iceServers: ICE_SERVERS,
    },
  };
}

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
const HEARTBEAT_INTERVAL = 5000;
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 3;

/**
 * Create the Host networking layer.
 *
 * The host creates a PeerJS peer with a deterministic ID (mafia-{roomCode}-host)
 * and listens for incoming player connections (star topology).
 *
 * @param {string} roomCode
 * @param {object} callbacks
 * @param {function} callbacks.onLog
 * @param {function} callbacks.onPlayerJoin
 * @param {function} callbacks.onPlayerRejoin
 * @param {function} callbacks.onPlayerDisconnect
 * @param {function} callbacks.onMessage
 * @param {function} callbacks.onReady
 * @param {function} callbacks.onError
 * @returns {object} Host API
 */
export function createHost(roomCode, callbacks) {
  const hostPeerId = buildHostPeerId(roomCode);
  const connections = new Map(); // peerId -> { conn, playerInfo, lastHeartbeat }
  let peer = null;
  let heartbeatTimer = null;
  let destroyed = false;

  const log = (msg, level = 'info') => {
    callbacks.onLog?.(`[HOST] ${msg}`, level);
  };

  log(`Creating peer with ID: ${hostPeerId}`);

  peer = new Peer(hostPeerId, getPeerOptions());

  peer.on('open', (id) => {
    log(`Peer broker connected. ID: ${id}`, 'success');
    callbacks.onReady?.();
    startHeartbeat();
  });

  peer.on('error', (err) => {
    if (destroyed) return;
    log(`Peer error: ${err.type} — ${err.message}`, 'error');
    callbacks.onError?.(err);
  });

  peer.on('disconnected', () => {
    if (destroyed) return;
    log('Disconnected from signaling server. Attempting reconnect...', 'warn');
    peer.reconnect();
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

  // --- Message Handling ---

  function handlePlayerMessage(conn, data) {
    const msg = typeof data === 'string' ? JSON.parse(data) : data;

    switch (msg.type) {
      case MSG.JOIN: {
        // Let app.js validate (e.g., block mid-game joins)
        const canJoin = callbacks.onPlayerJoin?.({
          playerId: msg.payload.playerId,
          displayName: msg.payload.displayName,
          peerId: conn.peer,
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

        // Store the REAL PeerJS connection
        connections.set(conn.peer, {
          conn,
          playerInfo,
          lastHeartbeat: Date.now(),
        });

        log(`Player joined: ${playerInfo.displayName} (${playerInfo.playerId})`, 'success');

        conn.send(createMessage(MSG.JOIN_ACK, {
          success: true,
          players: getPlayerList(),
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

          connections.set(conn.peer, {
            conn,
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

      case MSG.VOTE_ACTION: {
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

  // --- Public Host API ---
  return {
    get peerId() { return hostPeerId; },
    get playerCount() { return connections.size; },
    getPlayerList,
    broadcast,

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
      log('Host destroyed', 'info');
    },
  };
}

/**
 * Create the Player networking layer.
 *
 * The player creates a PeerJS peer and connects
 * to the host's deterministic peer ID.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @param {string} displayName
 * @param {object} callbacks
 * @param {boolean} isReconnect
 * @returns {object} Player API
 */
export function joinAsPlayer(roomCode, playerId, displayName, callbacks, isReconnect = false) {
  const hostPeerId = buildHostPeerId(roomCode);
  let peer = null;
  let conn = null;
  let destroyed = false;

  const log = (msg, level = 'info') => {
    callbacks.onLog?.(`[PLAYER] ${msg}`, level);
  };

  log(`Creating peer and connecting to host: ${hostPeerId}`);

  peer = new Peer(`${playerId}-p`, getPeerOptions());

  peer.on('open', (id) => {
    log(`Peer broker connected. My ID: ${id}`, 'success');
    log(`Connecting to host: ${hostPeerId}...`);

    conn = peer.connect(hostPeerId, {
      reliable: true,
    });

    conn.on('open', () => {
      log('Data channel open with host!', 'success');

      // Send JOIN or REJOIN
      const msgType = isReconnect ? MSG.REJOIN : MSG.JOIN;
      conn.send(createMessage(msgType, {
        playerId,
        displayName,
      }));
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

    callbacks.onError?.(err);
  });

  peer.on('disconnected', () => {
    if (destroyed) return;
    log('Disconnected from signaling server. Attempting reconnect...', 'warn');
    peer.reconnect();
  });

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
      try { peer?.destroy(); } catch {}
      log('Player destroyed', 'info');
    },
  };
}
