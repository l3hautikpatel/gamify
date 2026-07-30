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

// --- ICE Server Configuration ---
// STUN for direct P2P discovery + TURN relay fallback
const ICE_SERVERS = [
  // Google's free public STUN servers
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Open Relay TURN fallback (metered.ca free tier)
  // Port 80: works through most HTTP-only firewalls
  {
    urls: 'turn:a.relay.metered.ca:80',
    username: 'e7d691583df2dfab1cd52e43',
    credential: '5kAlM/VhJwMPwVBw',
  },
  // Port 443 over TLS: works through HTTPS-strict firewalls
  {
    urls: 'turn:a.relay.metered.ca:443?transport=tcp',
    username: 'e7d691583df2dfab1cd52e43',
    credential: '5kAlM/VhJwMPwVBw',
  },
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

  const log = (msg, level = 'info') => {
    callbacks.onLog?.(`[HOST] ${msg}`, level);
  };

  // Create the PeerJS peer with deterministic ID
  log(`Creating peer with ID: ${hostPeerId}`);

  peer = new Peer(hostPeerId, {
    config: {
      iceServers: ICE_SERVERS,
    },
    debug: 1, // Minimal PeerJS debug logging
  });

  peer.on('open', (id) => {
    log(`Peer broker connected. ID: ${id}`, 'success');
    callbacks.onReady?.();
    startHeartbeat();
  });

  peer.on('error', (err) => {
    log(`Peer error: ${err.type} — ${err.message}`, 'error');
    callbacks.onError?.(err);
  });

  peer.on('disconnected', () => {
    log('Disconnected from signaling server. Attempting reconnect...', 'warn');
    if (!destroyed) {
      peer.reconnect();
    }
  });

  // Listen for incoming player connections
  peer.on('connection', (conn) => {
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

  function handlePlayerMessage(conn, data) {
    const msg = typeof data === 'string' ? JSON.parse(data) : data;

    switch (msg.type) {
      case MSG.JOIN: {
        // If there's an onPlayerJoin callback, let it validate the join (e.g., block mid-game joins)
        const canJoin = callbacks.onPlayerJoin?.({
          playerId: msg.payload.playerId,
          displayName: msg.payload.displayName,
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

        connections.set(conn.peer, {
          conn,
          playerInfo,
          lastHeartbeat: Date.now(),
        });

        log(`Player joined: ${playerInfo.displayName} (${playerInfo.playerId})`, 'success');

        // Send acknowledgment with current player list
        const playerList = getPlayerList();
        conn.send(createMessage(MSG.JOIN_ACK, {
          success: true,
          players: playerList,
        }));

        // Notify all other players about the new joiner
        broadcastExcept(conn.peer, createMessage(MSG.PLAYER_JOINED, {
          playerId: playerInfo.playerId,
          displayName: playerInfo.displayName,
        }));
        break;
      }

      case MSG.REJOIN: {
        const { playerId, displayName } = msg.payload;
        // Find existing connection entry by playerId (since peerId changes on reconnect)
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
          // Remove old connection entry
          connections.delete(oldPeerId);

          // Update info with new peerId
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
          // If we couldn't find them, reject
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
          // Broadcast chat to all connected players
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

      // Notify remaining players
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

        // Check for missed heartbeats
        if (now - entry.lastHeartbeat > HEARTBEAT_TIMEOUT) {
          handlePlayerDisconnect(peerId);
          continue;
        }

        // Send heartbeat ping
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
        entry.conn.close();
      }
      connections.clear();
      peer.destroy();
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

  const log = (msg, level = 'info') => {
    callbacks.onLog?.(`[PLAYER] ${msg}`, level);
  };

  log(`Creating peer and connecting to host: ${hostPeerId}`);

  peer = new Peer(undefined, {
    config: {
      iceServers: ICE_SERVERS,
    },
    debug: 1,
  });

  peer.on('open', (id) => {
    log(`Peer broker connected. My ID: ${id}`, 'success');
    log(`Connecting to host: ${hostPeerId}...`);

    conn = peer.connect(hostPeerId, {
      reliable: true,
    });

    conn.on('open', () => {
      log('Data channel open with host!', 'success');

      // Send JOIN or REJOIN message
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
    log('Disconnected from signaling server. Attempting reconnect...', 'warn');
    if (!destroyed) {
      peer.reconnect();
    }
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
      if (conn) conn.close();
      peer.destroy();
      log('Player destroyed', 'info');
    },
  };
}
