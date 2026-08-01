/* ============================================================
   Online Mafia — Main App Controller
   
   Handles screen routing, UI logic, and wires up the
   networking layer to the DOM.
   ============================================================ */

import {
  generateRoomCode,
  generatePlayerId,
  buildShareableLink,
  getRoomCodeFromURL,
  getInitial,
  formatTimestamp,
  copyToClipboard,
  showToast,
  saveSession,
  saveHostState,
  loadSession,
  clearSession,
  loadHostState,
  shuffleArray,
  normalizeLocalOrigin,
  isLocalHost,
} from './utils.js?v=2';

import { createHost, joinAsPlayer, MSG } from './network.js?v=4';
import { ROLES } from './roles.js?v=2';

// ---- State ----
let currentScreen = 'home';
let isHost = false;
let roomCode = '';
let playerId = '';
let displayName = '';
let hostAPI = null;
let playerAPI = null;
let players = []; // { playerId, displayName, connected, role (host only), alive (host only) }
let persistedSession = null;

// ---- Game State (Host Only) ----
let gameState = {
  phase: 'LOBBY', // LOBBY, ROLE_REVEAL, NIGHT, DAY, VOTING, GAME_OVER
  phaseEndsAt: 0,
  nightActions: {}, // playerId -> targetId
  voteActions: {},  // playerId -> targetId
};

// ---- Game Settings ----
const gameSettings = {
  mafiaCount: 1,
  doctorEnabled: true,
  investigatorEnabled: true,
  nightDuration: 60,
  dayDuration: 180,
  voteDuration: 30,
};

// ---- DOM References ----
const screens = {
  home: document.getElementById('screen-home'),
  host: document.getElementById('screen-host'),
  player: document.getElementById('screen-player'),
  roleReveal: document.getElementById('screen-role-reveal'),
  night: document.getElementById('screen-night'),
  voting: document.getElementById('screen-voting'),
  gameOver: document.getElementById('screen-game-over'),
  guide: document.getElementById('screen-guide'),
};

// Phase UIs
const nightTimerEl = document.getElementById('night-timer');
const nightActionContainer = document.getElementById('night-action-container');
const voteTimerEl = document.getElementById('vote-timer');
const voteActionContainer = document.getElementById('vote-action-container');
const playerDayTimerContainer = document.getElementById('player-day-timer-container');

// Home screen elements
const joinRoomInput = document.getElementById('join-room-code');
const joinNameInput = document.getElementById('join-name');
const joinBtn = document.getElementById('btn-join');
const createBtn = document.getElementById('btn-create');
const btnShowGuide = document.getElementById('btn-show-guide');
const btnGuideBack = document.getElementById('btn-guide-back');

// Game Over elements
const gameOverTitle = document.getElementById('game-over-title');
const gameOverSubtitle = document.getElementById('game-over-subtitle');
const gameOverPlayers = document.getElementById('game-over-players');
const btnGameOverBack = document.getElementById('btn-game-over-back');

// Host screen elements
const hostRoomCode = document.getElementById('host-room-code');
const hostCopyCode = document.getElementById('host-copy-code');
const hostShareLink = document.getElementById('host-share-link');
const hostCopyLink = document.getElementById('host-copy-link');
const hostPlayerList = document.getElementById('host-player-list');
const hostPlayerCount = document.getElementById('host-player-count');
const hostStatus = document.getElementById('host-status');
const hostMessages = document.getElementById('host-messages');
const hostMsgInput = document.getElementById('host-msg-input');
const hostMsgSend = document.getElementById('host-msg-send');
const hostLogToggle = document.getElementById('host-log-toggle');
const hostLogEntries = document.getElementById('host-log-entries');
const hostLeaveBtn = document.getElementById('host-leave');
const hostSettingsCard = document.getElementById('host-settings-card');
const startGameContainer = document.getElementById('start-game-container');
const startGameBtn = document.getElementById('btn-start-game');
const startGameHint = document.getElementById('start-game-hint');
const hostGameControls = document.getElementById('host-game-controls');
const hostPhaseTitle = document.getElementById('host-phase-title');
const hostPhaseTimer = document.getElementById('host-phase-timer');
const btnNextPhase = document.getElementById('btn-next-phase');

// Settings elements
const mafiaCountDisplay = document.getElementById('mafia-count-display');
const mafiaDecBtn = document.getElementById('mafia-dec');
const mafiaIncBtn = document.getElementById('mafia-inc');
const doctorToggle = document.getElementById('toggle-doctor');
const investigatorToggle = document.getElementById('toggle-investigator');
const timerNightInput = document.getElementById('timer-night');
const timerDayInput = document.getElementById('timer-day');
const timerVoteInput = document.getElementById('timer-vote');
const settingsValidation = document.getElementById('settings-validation');

// Player screen elements
const playerRoomCodeDisplay = document.getElementById('player-room-code');
const playerNameDisplay = document.getElementById('player-name');
const playerStatus = document.getElementById('player-status');
const playerMessages = document.getElementById('player-messages');
const playerMsgInput = document.getElementById('player-msg-input');
const playerMsgSend = document.getElementById('player-msg-send');
const playerLogToggle = document.getElementById('player-log-toggle');
const playerLogEntries = document.getElementById('player-log-entries');
const playerLeaveBtn = document.getElementById('player-leave');
const playerPlayerList = document.getElementById('player-player-list');

// Role Reveal elements
const roleCard = document.getElementById('role-card');
const roleCardInner = document.getElementById('role-card-inner');
const revealIcon = document.getElementById('reveal-icon');
const revealName = document.getElementById('reveal-name');
const revealTeam = document.getElementById('reveal-team');
const revealDesc = document.getElementById('reveal-desc');
const btnReady = document.getElementById('btn-ready');

// ---- Screen Routing ----
function showScreen(name) {
  currentScreen = name;
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('active', key === name);
  }
}

function restoreHostState(hostState) {
  if (!hostState) return;

  if (hostState.settings) {
    Object.assign(gameSettings, hostState.settings);
  }

  if (Array.isArray(hostState.players)) {
    players = hostState.players.map((p) => ({ ...p }));
  }

  gameState.phase = hostState.phase || gameState.phase;
  gameState.phaseEndsAt = hostState.phaseEndsAt || 0;
  if (hostState.nightActions) gameState.nightActions = { ...hostState.nightActions };
  if (hostState.voteActions) gameState.voteActions = { ...hostState.voteActions };
  if (hostState.lastNightResult) gameState.lastNightResult = hostState.lastNightResult;
  if (hostState.lastVoteResult) gameState.lastVoteResult = hostState.lastVoteResult;
  if (hostState.winner) gameState.winner = hostState.winner;

  syncSettingsUI();
}

function syncSettingsUI() {
  mafiaCountDisplay.textContent = gameSettings.mafiaCount;
  doctorToggle.checked = gameSettings.doctorEnabled;
  investigatorToggle.checked = gameSettings.investigatorEnabled;
  timerNightInput.value = gameSettings.nightDuration;
  timerDayInput.value = gameSettings.dayDuration;
  timerVoteInput.value = gameSettings.voteDuration;
}

function restoreHostView() {
  if (!isHost) return;

  renderHostPlayerList();
  if (gameState.phase !== 'LOBBY') {
    hostSettingsCard.style.display = 'none';
    startGameContainer.style.display = 'none';
    hostGameControls.style.display = 'block';
    hostPhaseTitle.textContent = `Phase: ${gameState.phase}`;
    btnNextPhase.textContent = gameState.phase === 'ROLE_REVEAL' ? 'Start Night Phase' : 'Advance Phase';
  } else {
    hostSettingsCard.style.display = 'block';
    startGameContainer.style.display = 'block';
    hostGameControls.style.display = 'none';
  }
}

function persistHostState() {
  if (!isHost || !roomCode) return;

  saveHostState({
    roomCode,
    hostPeerId: hostAPI?.peerId || null,
    settings: { ...gameSettings },
    players: players.map((p) => ({ ...p })),
    phase: gameState.phase,
    phaseEndsAt: gameState.phaseEndsAt,
    nightActions: { ...gameState.nightActions },
    voteActions: { ...gameState.voteActions },
    lastNightResult: gameState.lastNightResult,
    lastVoteResult: gameState.lastVoteResult,
    winner: gameState.winner,
  });
}

// ---- Initialize ----
function init() {
  if (isLocalHost(window.location.hostname)) {
    const canonicalUrl = normalizeLocalOrigin(window.location.href);
    if (canonicalUrl && window.location.href !== canonicalUrl) {
      window.location.replace(canonicalUrl);
      return;
    }
  }

  const hostState = loadHostState();
  persistedSession = loadSession();

  if (hostState) {
    roomCode = hostState.roomCode || '';
    playerId = persistedSession?.playerId || generatePlayerId();
    displayName = persistedSession?.displayName || 'Host';
    isHost = true;
    restoreHostState(hostState);
    handleCreateGame(true);
    restoreHostView();
    return;
  } else if (persistedSession) {
    roomCode = persistedSession.roomCode || '';
    playerId = persistedSession.playerId || generatePlayerId();
    displayName = persistedSession.displayName || '';
    isHost = persistedSession.isHost || false;
    handleJoinGame(true);
    return;
  }

  // Check for room code in URL
  const urlRoom = getRoomCodeFromURL();
  if (urlRoom) {
    joinRoomInput.value = urlRoom.toUpperCase();
    joinNameInput.focus();
  }

  // Event listeners
  createBtn.addEventListener('click', () => handleCreateGame());
  joinBtn.addEventListener('click', () => handleJoinGame());
  
  // Enter key support for join
  joinRoomInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinNameInput.focus();
  });
  joinNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleJoinGame();
  });

  // Guide screen listeners
  btnShowGuide.addEventListener('click', () => {
    showScreen('guide');
  });
  btnGuideBack.addEventListener('click', () => {
    showScreen('home');
  });
  btnGameOverBack.addEventListener('click', () => {
    if (isHost) {
      // Host: go back to host screen (the "Play Again" button already handles the state reset)
      showScreen('host');
    } else {
      // Player: go back to the player lobby; keep the connection alive
      // The host will broadcast LOBBY when they click "Play Again"
      showScreen('player');
      showToast('Waiting for host to start a new game...', 'info');
      // Re-enable chat in case it was disabled from death
      playerMsgInput.disabled = false;
      playerMsgSend.disabled = false;
      playerMsgInput.placeholder = 'Type a test message…';
    }
  });

  // Host events room code uppercase
  joinRoomInput.addEventListener('input', () => {
    joinRoomInput.value = joinRoomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // Host screen events
  hostCopyCode.addEventListener('click', () => handleCopyRoomCode());
  hostCopyLink.addEventListener('click', () => handleCopyShareLink());
  hostMsgSend.addEventListener('click', () => handleHostSendMessage());
  hostMsgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleHostSendMessage();
  });
  hostLogToggle.addEventListener('click', () => toggleLog(hostLogToggle, hostLogEntries));
  hostLeaveBtn.addEventListener('click', handleLeave);
  startGameBtn.addEventListener('click', handleStartGame);
  btnNextPhase.addEventListener('click', handleNextPhase);

  // Settings events
  mafiaDecBtn.addEventListener('click', () => { adjustMafiaCount(-1); });
  mafiaIncBtn.addEventListener('click', () => { adjustMafiaCount(1); });
  doctorToggle.addEventListener('change', () => {
    gameSettings.doctorEnabled = doctorToggle.checked;
    validateSettings();
  });
  investigatorToggle.addEventListener('change', () => {
    gameSettings.investigatorEnabled = investigatorToggle.checked;
    validateSettings();
  });
  timerNightInput.addEventListener('change', () => {
    gameSettings.nightDuration = clampTimer(timerNightInput, 15, 300);
  });
  timerDayInput.addEventListener('change', () => {
    gameSettings.dayDuration = clampTimer(timerDayInput, 30, 600);
  });
  timerVoteInput.addEventListener('change', () => {
    gameSettings.voteDuration = clampTimer(timerVoteInput, 15, 120);
  });

  // Player screen events
  playerMsgSend.addEventListener('click', () => handlePlayerSendMessage());
  playerMsgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handlePlayerSendMessage();
  });
  playerLogToggle.addEventListener('click', () => toggleLog(playerLogToggle, playerLogEntries));
  playerLeaveBtn.addEventListener('click', handleLeave);

  // Role Reveal events
  roleCard.addEventListener('click', () => {
    if (!roleCard.classList.contains('is-flipped')) {
      roleCard.classList.add('is-flipped');
      setTimeout(() => {
        btnReady.style.opacity = '1';
        btnReady.style.pointerEvents = 'auto';
      }, 600); // Wait for flip animation
    }
  });

  btnReady.addEventListener('click', () => {
    showToast('Waiting for the host to start the game...', 'info');
    // Eventually this will transition to the appropriate phase screen when the host says so,
    // or maybe the user just sits on this screen until a STATE_UPDATE pushes them elsewhere.
  });

  showScreen('home');
}

// ---- Create Game (Host) ----
function handleCreateGame(isReconnect = false) {
  isHost = true;
  if (!isReconnect) {
    roomCode = generateRoomCode();
    playerId = generatePlayerId();
    displayName = 'Host';
  } else {
    roomCode = roomCode || generateRoomCode();
    playerId = playerId || generatePlayerId();
    displayName = displayName || 'Host';
  }

  showScreen('host');
  restoreHostView();

  // Render room info
  hostRoomCode.textContent = roomCode;
  const shareLink = buildShareableLink(roomCode);
  hostShareLink.textContent = shareLink;
  updateHostStatus('connecting');

  // Create host networking
  hostAPI = createHost(roomCode, {
    onLog: (msg, level) => addLogEntry(hostLogEntries, msg, level),
    onPlayerJoin: (playerInfo) => {
      const existing = players.find((p) => p.playerId === playerInfo.playerId);
      if (existing) {
        Object.assign(existing, playerInfo, { connected: true });
      } else {
        players.push({ ...playerInfo, connected: true });
      }
      renderHostPlayerList();
      addChatMessage(hostMessages, 'System', `${playerInfo.displayName} joined the room`, true);
      showToast(`${playerInfo.displayName} joined!`, 'success');
      persistHostState();
    },
    onPlayerDisconnect: (pId) => {
      const p = players.find(x => x.playerId === pId);
      if (p) {
        p.connected = false;
        renderHostPlayerList();
        addChatMessage(hostMessages, 'System', `${p.displayName} disconnected`, true);
        showToast(`${p.displayName} disconnected`, 'error');
        persistHostState();
      }
    },
    onPlayerRejoin: (info) => {
      const rejoined = players.find((p) => p.playerId === info.playerId);
      if (rejoined) {
        rejoined.connected = true;
        rejoined.peerId = info.peerId;
        renderHostPlayerList();
        addChatMessage(hostMessages, 'System', `${rejoined.displayName} reconnected`, true);
        showToast(`${rejoined.displayName} reconnected`, 'success');
      }

      if (hostAPI && rejoined?.role) {
        hostAPI.sendToPlayer(info.peerId, {
          type: MSG.ROLE_ASSIGNMENT,
          payload: {
            roleId: rejoined.role,
            roleDef: ROLES[rejoined.role.toUpperCase()],
          },
        });
      }

      broadcastStateUpdate();
      persistHostState();
    },
    onMessage: (pId, msg) => {
      if (msg.type === MSG.CHAT) {
        const p = players.find(x => x.playerId === pId);
        addChatMessage(hostMessages, p?.displayName || 'Unknown', msg.payload.text);
      } else if (msg.type === MSG.NIGHT_ACTION) {
        gameState.nightActions[pId] = msg.payload.targetId;
        const p = players.find(x => x.playerId === pId);
        addLogEntry(hostLogEntries, `${p?.displayName || pId} submitted night action`, 'info');
      } else if (msg.type === MSG.VOTE_ACTION) {
        gameState.voteActions[pId] = msg.payload.targetId;
        const p = players.find(x => x.playerId === pId);
        addLogEntry(hostLogEntries, `${p?.displayName || pId} submitted a vote`, 'info');
      }
    },
    onReady: () => {
      updateHostStatus('connected');
      showToast('Room created! Share the code with players.', 'success');

      // Save session for reconnection prep
      saveSession({
        roomCode,
        playerId,
        displayName,
        isHost: true,
        lastKnownPhase: 'LOBBY',
      });
      persistHostState();
    },
    onError: (err) => {
      if (err.type === 'unavailable-id') {
        updateHostStatus('disconnected');
        showToast('Room code already in use. Try again.', 'error');
      }
    },
  });
}

// ---- Join Game (Player) ----
function handleJoinGame(isReconnect = false) {
  const code = isReconnect ? (roomCode || '').trim().toUpperCase() : joinRoomInput.value.trim().toUpperCase();
  const name = isReconnect ? (displayName || '').trim() : joinNameInput.value.trim();

  if (!code || code.length < 4) {
    showToast('Please enter a valid room code.', 'error');
    joinRoomInput.focus();
    return;
  }

  if (!name) {
    showToast('Please enter your name.', 'error');
    joinNameInput.focus();
    return;
  }

  isHost = false;
  roomCode = code;
  displayName = name;
  if (!playerId || !isReconnect) {
    playerId = generatePlayerId();
  }

  showScreen('player');
  if (isReconnect) {
    playerRoomCodeDisplay.textContent = roomCode;
    playerNameDisplay.textContent = displayName;
    if (persistedSession?.lastKnownPhase === 'ROLE_REVEAL') {
      showScreen('roleReveal');
    }
  }

  // Render player info
  playerRoomCodeDisplay.textContent = roomCode;
  playerNameDisplay.textContent = displayName;
  updatePlayerStatus('connecting');

  // Create player networking
  playerAPI = joinAsPlayer(roomCode, playerId, displayName, {
    onLog: (msg, level) => addLogEntry(playerLogEntries, msg, level),
    onConnected: (playerList) => {
      players = playerList;
      updatePlayerStatus('connected');
      renderPlayerPlayerList();
      showToast('Connected to the game!', 'success');

      if (isReconnect && persistedSession?.lastKnownPhase) {
        handleStateUpdate({
          phase: persistedSession.lastKnownPhase,
          phaseEndsAt: 0,
          alivePlayers: players.filter((p) => p.connected).map((p) => ({ playerId: p.playerId, displayName: p.displayName })),
        });
      }

      // Save session for reconnection prep
      saveSession({
        roomCode,
        playerId,
        displayName,
        isHost: false,
        lastKnownPhase: 'LOBBY',
      });
    },
    onDisconnected: () => {
      updatePlayerStatus('disconnected');
      showToast('Disconnected from host.', 'error');
    },
    onMessage: (msg) => {
      if (msg.type === MSG.CHAT) {
        addChatMessage(playerMessages, msg.payload.from, msg.payload.text, msg.payload.fromId === 'host');
      } else if (msg.type === MSG.ROLE_ASSIGNMENT) {
        handleRoleAssignment(msg.payload);
      } else if (msg.type === MSG.STATE_UPDATE) {
        handleStateUpdate(msg.payload);
      }
    },
    onPlayerJoined: (info) => {
      players.push({ ...info, connected: true });
      renderPlayerPlayerList();
      addChatMessage(playerMessages, 'System', `${info.displayName} joined`, true);
    },
    onPlayerDisconnected: (info) => {
      const p = players.find(x => x.playerId === info.playerId);
      if (p) p.connected = false;
      renderPlayerPlayerList();
      addChatMessage(playerMessages, 'System', `${info.displayName} disconnected`, true);
    },
    onError: (err) => {
      if (err.type === 'peer-unavailable') {
        updatePlayerStatus('disconnected');
        showToast('Room not found. Check the code and try again.', 'error');
      }
    },
  });
}

// ---- Leave Game ----
function handleLeave() {
  if (isHost) {
    if (confirm('Are you sure you want to close the room? Everyone will be disconnected.')) {
      hostAPI?.destroy();
      clearSession();
      window.location.search = '';
      window.location.reload();
    }
  } else {
    if (confirm('Are you sure you want to leave the game?')) {
      playerAPI?.destroy();
      clearSession();
      window.location.search = '';
      window.location.reload();
    }
  }
}

// ---- Host Status ----
function updateHostStatus(state) {
  hostStatus.className = `status-badge status-badge--${state}`;
  const labels = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' };
  hostStatus.innerHTML = `
    <span class="status-badge__dot"></span>
    ${labels[state] || state}
  `;
}

// ---- Player Status ----
function updatePlayerStatus(state) {
  playerStatus.className = `status-badge status-badge--${state}`;
  const labels = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' };
  playerStatus.innerHTML = `
    <span class="status-badge__dot"></span>
    ${labels[state] || state}
  `;
}

// ---- Render Host Player List ----
function renderHostPlayerList() {
  if (players.length === 0) {
    hostPlayerList.innerHTML = `
      <li class="player-list__empty">
        Waiting for players to join…
      </li>
    `;
    hostPlayerCount.textContent = '0';
    updateStartGameButton();
    return;
  }

  hostPlayerCount.textContent = players.length;
  hostPlayerList.innerHTML = players.map((p) => `
    <li class="player-item">
      <div class="player-item__avatar">${getInitial(p.displayName)}</div>
      <span class="player-item__name">${escapeHtml(p.displayName)}</span>
      <span class="player-item__status">
        <span class="status-badge status-badge--${p.connected ? 'connected' : 'disconnected'}">
          <span class="status-badge__dot"></span>
          ${p.connected ? 'Online' : 'Offline'}
        </span>
      </span>
    </li>
  `).join('');
  updateStartGameButton();
}

// ---- Settings Logic ----
function adjustMafiaCount(delta) {
  const newVal = gameSettings.mafiaCount + delta;
  if (newVal < 1) return;
  gameSettings.mafiaCount = newVal;
  mafiaCountDisplay.textContent = newVal;
  validateSettings();
}

function clampTimer(input, min, max) {
  let val = parseInt(input.value, 10);
  if (isNaN(val) || val < min) val = min;
  if (val > max) val = max;
  input.value = val;
  return val;
}

/**
 * Validate settings per Section 8.3 of the spec.
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */
function validateSettings() {
  const connectedCount = players.filter(p => p.connected).length;
  const totalPlayers = connectedCount;
  const { mafiaCount, doctorEnabled, investigatorEnabled } = gameSettings;

  const errors = [];
  const warnings = [];

  // No players yet
  if (totalPlayers === 0) {
    errors.push('Need at least 1 player to start');
  }

  // Mafia count must be < roughly 1/3 of total players (Section 8.3)
  if (totalPlayers > 0) {
    const maxMafia = Math.max(1, Math.floor(totalPlayers / 3));
    if (mafiaCount > maxMafia) {
      errors.push(`Too many mafia (${mafiaCount}) for ${totalPlayers} player${totalPlayers > 1 ? 's' : ''}. Max recommended: ${maxMafia}`);
    }

    // Check special role slots vs available non-mafia players
    const specialRoles = (doctorEnabled ? 1 : 0) + (investigatorEnabled ? 1 : 0);
    const nonMafiaSlots = totalPlayers - mafiaCount;
    if (nonMafiaSlots < specialRoles) {
      errors.push(`Not enough players for ${mafiaCount} mafia + ${specialRoles} special role${specialRoles > 1 ? 's' : ''}. Need at least ${mafiaCount + specialRoles} players.`);
    } else if (nonMafiaSlots - specialRoles < 1) {
      errors.push(`No villagers left after assigning ${mafiaCount} mafia and ${specialRoles} special role${specialRoles > 1 ? 's' : ''}. Need more players.`);
    }
  }

  // Warn if under 5 players (don't block)
  if (totalPlayers > 0 && totalPlayers < 5) {
    warnings.push(`Only ${totalPlayers} player${totalPlayers > 1 ? 's' : ''} — works, but 5+ is recommended for the best game`);
  }

  // Update stepper bounds
  const maxAllowed = totalPlayers > 0 ? Math.max(1, Math.floor(totalPlayers / 3)) : 10;
  mafiaDecBtn.disabled = gameSettings.mafiaCount <= 1;
  mafiaIncBtn.disabled = gameSettings.mafiaCount >= maxAllowed;

  // Render validation messages
  renderValidation(errors, warnings, totalPlayers);

  // Update start button
  const canStart = totalPlayers >= 1 && errors.length === 0;
  startGameBtn.disabled = !canStart;

  if (totalPlayers === 0) {
    startGameHint.textContent = 'Need at least 1 player to start';
    startGameHint.style.color = '';
  } else if (errors.length > 0) {
    startGameHint.textContent = 'Fix the issues above to start';
    startGameHint.style.color = 'var(--color-danger)';
  } else if (warnings.length > 0) {
    startGameHint.textContent = 'Ready to start (see warnings above)';
    startGameHint.style.color = 'var(--color-warning)';
  } else {
    startGameHint.textContent = `${totalPlayers} players ready — great group size!`;
    startGameHint.style.color = 'var(--color-success)';
  }

  return { valid: canStart, errors, warnings };
}

function renderValidation(errors, warnings, playerCount) {
  let html = '';

  for (const err of errors) {
    html += `<div class="validation-msg validation-msg--error">
      <span class="validation-msg__icon">❌</span>
      ${escapeHtml(err)}
    </div>`;
  }
  for (const warn of warnings) {
    html += `<div class="validation-msg validation-msg--warn">
      <span class="validation-msg__icon">⚠️</span>
      ${escapeHtml(warn)}
    </div>`;
  }

  if (errors.length === 0 && playerCount > 0) {
    const { mafiaCount, doctorEnabled, investigatorEnabled } = gameSettings;
    const specialCount = (doctorEnabled ? 1 : 0) + (investigatorEnabled ? 1 : 0);
    const villagerCount = playerCount - mafiaCount - specialCount;
    const parts = [`${mafiaCount} mafia`];
    if (doctorEnabled) parts.push('1 doctor');
    if (investigatorEnabled) parts.push('1 investigator');
    parts.push(`${villagerCount} villager${villagerCount !== 1 ? 's' : ''}`);

    html += `<div class="validation-msg validation-msg--ok">
      <span class="validation-msg__icon">✅</span>
      Roles: ${parts.join(', ')}
    </div>`;
  }

  settingsValidation.innerHTML = html;
}

// Alias for backward compatibility — called from renderHostPlayerList
function updateStartGameButton() {
  validateSettings();
}

// ---- Start Game (Phase 4: Role Assignment) ----
function handleStartGame() {
  const { valid } = validateSettings();
  if (!valid) {
    showToast('Fix settings issues before starting.', 'error');
    return;
  }

  // 1. Build the deck
  const { mafiaCount, doctorEnabled, investigatorEnabled } = gameSettings;
  const connectedPlayers = players.filter(p => p.connected);
  
  const deck = [];
  for (let i = 0; i < mafiaCount; i++) deck.push(ROLES.MAFIA.id);
  if (doctorEnabled) deck.push(ROLES.DOCTOR.id);
  if (investigatorEnabled) deck.push(ROLES.INVESTIGATOR.id);
  
  const villagerCount = connectedPlayers.length - deck.length;
  for (let i = 0; i < villagerCount; i++) deck.push(ROLES.VILLAGER.id);

  // 2. Shuffle and assign
  shuffleArray(deck);
  
  connectedPlayers.forEach((p, i) => {
    p.role = deck[i];
    p.alive = true;
  });

  // 3. Update game state
  gameState.phase = 'ROLE_REVEAL';
  gameState.phaseEndsAt = 0; // Role reveal has no strict timer in this version, or host triggers next phase manually

  // 4. Broadcast personalized role assignments
  connectedPlayers.forEach(p => {
    hostAPI.sendToPlayer(p.peerId, {
      type: MSG.ROLE_ASSIGNMENT,
      payload: {
        roleId: p.role,
        roleDef: ROLES[p.role.toUpperCase()],
      }
    });
  });

  showToast('Roles distributed!', 'success');
  
  // Transition host UI
  hostSettingsCard.style.display = 'none';
  startGameContainer.style.display = 'none';
  hostGameControls.style.display = 'block';

  // Automatically advance to Night phase after a short delay, or let host click next
  hostPhaseTitle.textContent = 'Phase: ROLE REVEAL';
  btnNextPhase.textContent = 'Start Night Phase';
  
  broadcastStateUpdate(); // Explicitly push new phase to players
  persistHostState();
}

function handleNextPhase() {
  if (gameState.phase === 'ROLE_REVEAL' || gameState.phase === 'VOTING') {
    advanceToNight();
  } else if (gameState.phase === 'NIGHT') {
    // Usually night ends when timer expires, but host can force it
    resolveNightActions();
  } else if (gameState.phase === 'DAY') {
    advanceToVoting();
  }
}

function advanceToNight() {
  gameState.phase = 'NIGHT';
  gameState.nightActions = {}; // Clear previous actions
  
  // Setup timer
  gameState.phaseEndsAt = Date.now() + (gameSettings.nightDuration * 1000);
  
  // Update host UI
  hostPhaseTitle.textContent = 'Phase: NIGHT';
  btnNextPhase.textContent = 'End Night Early';
  startHostPhaseTimer(gameState.phaseEndsAt, () => resolveNightActions());

  // Broadcast state to all players
  broadcastStateUpdate();
  persistHostState();
}

function resolveNightActions() {
  let mafiaTargets = {};
  let savedId = null;
  let investigateTarget = null;
  let investigateResult = null;

  // Process all actions
  for (const [pId, targetId] of Object.entries(gameState.nightActions)) {
    const player = players.find(p => p.playerId === pId);
    if (!player || !player.alive) continue;

    if (player.role === 'mafia') {
      mafiaTargets[targetId] = (mafiaTargets[targetId] || 0) + 1;
    } else if (player.role === 'doctor') {
      savedId = targetId;
    } else if (player.role === 'investigator') {
      investigateTarget = targetId;
      const targetPlayer = players.find(p => p.playerId === targetId);
      if (targetPlayer) {
        investigateResult = targetPlayer.role === 'mafia' ? 'mafia' : 'village';
      }
    }
  }

  // Determine Mafia kill (most votes, tiebreaker = random or first)
  let killedId = null;
  let maxVotes = 0;
  for (const [tId, votes] of Object.entries(mafiaTargets)) {
    if (votes > maxVotes) {
      maxVotes = votes;
      killedId = tId;
    }
  }

  // Resolve death
  let finalVictim = null;
  if (killedId && killedId !== savedId) {
    finalVictim = killedId;
    const p = players.find(x => x.playerId === finalVictim);
    if (p) p.alive = false;
  }

  // Track if doctor's save was successful
  const doctorSaveSuccessful = (killedId && killedId === savedId);

  gameState.lastNightResult = {
    victimId: finalVictim,
    doctorSavedId: doctorSaveSuccessful ? savedId : null,
    investigateResult: investigateResult ? { targetId: investigateTarget, result: investigateResult } : null,
  };

  if (checkWinCondition()) return;

  gameState.phase = 'DAY';
  
  gameState.phaseEndsAt = Date.now() + (gameSettings.dayDuration * 1000);
  hostPhaseTitle.textContent = 'Phase: DAY';
  btnNextPhase.textContent = 'End Day Early (Vote)';
  startHostPhaseTimer(gameState.phaseEndsAt, () => advanceToVoting());
  
  broadcastStateUpdate();
  persistHostState();
}

function advanceToVoting() {
  gameState.phase = 'VOTING';
  gameState.voteActions = {}; // Clear previous votes
  
  gameState.phaseEndsAt = Date.now() + (gameSettings.voteDuration * 1000);
  hostPhaseTitle.textContent = 'Phase: VOTING';
  btnNextPhase.textContent = 'End Voting Early';
  startHostPhaseTimer(gameState.phaseEndsAt, () => resolveVoting());
  
  broadcastStateUpdate();
  persistHostState();
}

function resolveVoting() {
  let voteTallies = {};
  
  // Tally votes
  for (const targetId of Object.values(gameState.voteActions)) {
    if (targetId) { // Could be 'skip' or empty if abstained
      voteTallies[targetId] = (voteTallies[targetId] || 0) + 1;
    }
  }

  // Find max votes
  let maxVotes = 0;
  let eliminatedId = null;
  let isTie = false;

  for (const [tId, votes] of Object.entries(voteTallies)) {
    if (votes > maxVotes) {
      maxVotes = votes;
      eliminatedId = tId;
      isTie = false;
    } else if (votes === maxVotes) {
      isTie = true;
    }
  }

  // Standard Tie-Break: No one is eliminated
  if (isTie) {
    eliminatedId = null;
  }

  // Apply elimination
  if (eliminatedId && eliminatedId !== 'skip') {
    const p = players.find(x => x.playerId === eliminatedId);
    if (p) p.alive = false;
  }

  gameState.lastVoteResult = {
    eliminatedId: eliminatedId === 'skip' ? null : eliminatedId,
    isTie
  };

  if (checkWinCondition()) return;

  // If no one won, proceed back to NIGHT
  advanceToNight();
}

function checkWinCondition() {
  const alivePlayers = players.filter(p => p.alive && p.connected);
  const mafiaCount = alivePlayers.filter(p => p.role === 'mafia').length;
  const villageCount = alivePlayers.length - mafiaCount;

  if (mafiaCount === 0) {
    handleGameOver('VILLAGE');
    return true;
  } else if (mafiaCount >= villageCount) {
    handleGameOver('MAFIA');
    return true;
  }

  return false;
}

function handleGameOver(winner) {
  gameState.phase = 'GAME_OVER';
  gameState.winner = winner;
  gameState.nightActions = {};
  gameState.voteActions = {};
  gameState.lastNightResult = null;
  gameState.lastVoteResult = null;
  
  if (hostTimerInterval) clearInterval(hostTimerInterval);
  
  // Show host the game over with clear winner banner
  hostPhaseTitle.textContent = winner === 'VILLAGE'
    ? '🏆 Village Wins!'
    : '🏆 Mafia Wins!';
  hostPhaseTimer.textContent = '';
  btnNextPhase.textContent = '🔄 Play Again (Same Players)';
  
  btnNextPhase.onclick = () => {
    // Reset for a new round without disconnecting anyone
    gameState.phase = 'LOBBY';
    gameState.winner = null;
    gameState.nightActions = {};
    gameState.voteActions = {};
    gameState.lastNightResult = null;
    gameState.lastVoteResult = null;
    gameState.phaseEndsAt = 0;

    btnNextPhase.onclick = handleNextPhase;
    hostSettingsCard.style.display = 'block';
    startGameContainer.style.display = 'block';
    hostGameControls.style.display = 'none';
    startGameBtn.textContent = '🎲 Start Game';
    startGameBtn.disabled = false;
    hostPhaseTitle.textContent = 'Phase: LOBBY';
    hostPhaseTimer.textContent = '00:00';
    
    // Reset player roles/alive status for next game
    players.forEach(p => {
      p.role = null;
      p.alive = true;
    });
    
    showScreen('host');
    broadcastStateUpdate();
    persistHostState();
    showToast('Lobby reset! Start a new game when ready.', 'success');
  };

  broadcastStateUpdate();
  persistHostState();
  
  // Also show game over screen on host device
  renderGameOverUI(winner, players);
  showScreen('gameOver');
}


let hostTimerInterval = null;
function startHostPhaseTimer(endTimeMs, onExpire) {
  if (hostTimerInterval) clearInterval(hostTimerInterval);
  
  hostTimerInterval = setInterval(() => {
    const remaining = Math.max(0, endTimeMs - Date.now());
    const secs = Math.ceil(remaining / 1000);
    
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    hostPhaseTimer.textContent = `${m}:${s}`;
    
    if (secs <= 10) {
      hostPhaseTimer.parentElement.classList.add('is-urgent');
    } else {
      hostPhaseTimer.parentElement.classList.remove('is-urgent');
    }

    if (remaining <= 0) {
      clearInterval(hostTimerInterval);
      if (onExpire) onExpire();
    }
  }, 200);
}

function broadcastStateUpdate() {
  // Build a sanitized state object
  const statePayload = {
    phase: gameState.phase,
    phaseEndsAt: gameState.phaseEndsAt,
    lastNightResult: gameState.lastNightResult,
    winner: gameState.winner || null,
    // Provide a list of alive players so clients can build action grids
    alivePlayers: players.filter(p => p.connected && p.alive).map(p => ({
      playerId: p.playerId,
      displayName: p.displayName
    })),
    // For GAME_OVER screen, we need all players and their roles
    allPlayers: gameState.phase === 'GAME_OVER' ? players.map(p => ({
      playerId: p.playerId,
      displayName: p.displayName,
      role: p.role,
      alive: p.alive
    })) : null
  };

  const msg = {
    type: MSG.STATE_UPDATE,
    payload: statePayload
  };

  // Broadcast to all connected players directly via network layer
  if (hostAPI.broadcast) {
    hostAPI.broadcast(msg);
  } else {
    // Fallback if not updated
    players.filter(p => p.connected).forEach(p => {
      hostAPI.sendToPlayer(p.peerId, msg);
    });
  }
}

// ---- Render Player's view of Player List ----
function renderPlayerPlayerList() {
  if (!playerPlayerList) return;
  if (players.length === 0) {
    playerPlayerList.innerHTML = `
      <li class="player-list__empty">No other players yet</li>
    `;
    return;
  }

  playerPlayerList.innerHTML = players.map((p) => {
    const isDead = p.alive === false;
    return `
    <li class="player-item ${isDead ? 'is-dead' : ''}">
      <div class="player-item__avatar">${isDead ? '💀' : getInitial(p.displayName)}</div>
      <span class="player-item__name" style="${isDead ? 'text-decoration: line-through;' : ''}">${escapeHtml(p.displayName)}</span>
      <span class="player-item__status">
        <span class="status-badge status-badge--${p.connected ? 'connected' : 'disconnected'}">
          <span class="status-badge__dot"></span>
          ${p.connected ? 'Online' : 'Offline'}
        </span>
      </span>
    </li>
  `;
  }).join('');
}

// ---- Role Reveal (Player Side) ----
function handleRoleAssignment(payload) {
  const { roleId, roleDef } = payload;
  
  // Update session storage
  const session = loadSession() || {};
  session.lastKnownRole = roleId;
  session.lastKnownPhase = 'ROLE_REVEAL';
  saveSession(session);

  // Populate Role Card
  revealIcon.textContent = roleDef.icon;
  revealName.textContent = roleDef.name;
  
  revealTeam.className = 'role-card__team';
  if (roleDef.team === 'village') {
    revealTeam.classList.add('team-badge--village');
    revealTeam.textContent = 'Village';
  } else {
    revealTeam.classList.add('team-badge--mafia');
    revealTeam.textContent = 'Mafia';
  }
  
  revealDesc.textContent = roleDef.description;

  // Reset card state
  roleCard.classList.remove('is-flipped');
  btnReady.style.opacity = '0';
  btnReady.style.pointerEvents = 'none';

  showScreen('roleReveal');
}

// ---- Chat Messages ----
function addChatMessage(container, sender, text, isSystem = false) {
  const bubble = document.createElement('div');
  const isSelf = (isHost && sender === 'Host') || (!isHost && sender === displayName);
  bubble.className = `message-bubble ${isSelf ? 'message-bubble--sent' : 'message-bubble--received'}`;

  if (isSystem) {
    bubble.style.alignSelf = 'center';
    bubble.style.background = 'rgba(255,255,255,0.03)';
    bubble.style.border = 'none';
    bubble.style.fontStyle = 'italic';
    bubble.style.color = 'var(--color-text-muted)';
    bubble.style.fontSize = 'var(--font-size-xs)';
    bubble.textContent = text;
  } else {
    bubble.innerHTML = `
      <div class="message-bubble__sender">${escapeHtml(sender)}</div>
      ${escapeHtml(text)}
    `;
  }

  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

// ---- Send Messages ----
function handleHostSendMessage() {
  const text = hostMsgInput.value.trim();
  if (!text) return;

  hostAPI?.sendChat(text);
  addChatMessage(hostMessages, 'Host', text);
  hostMsgInput.value = '';
  hostMsgInput.focus();
}

function handlePlayerSendMessage() {
  const text = playerMsgInput.value.trim();
  if (!text) return;

  playerAPI?.sendChat(text);
  addChatMessage(playerMessages, displayName, text);
  playerMsgInput.value = '';
  playerMsgInput.focus();
}

// ---- Copy Actions ----
async function handleCopyRoomCode() {
  const ok = await copyToClipboard(roomCode);
  showToast(ok ? 'Room code copied!' : 'Failed to copy', ok ? 'success' : 'error');
}

async function handleCopyShareLink() {
  const link = buildShareableLink(roomCode);
  const ok = await copyToClipboard(link);
  showToast(ok ? 'Link copied!' : 'Failed to copy', ok ? 'success' : 'error');
}

// ---- Connection Log ----
function addLogEntry(container, message, level = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-entry--${level}`;
  entry.innerHTML = `
    <span class="log-entry__time">${formatTimestamp()}</span>
    <span class="log-entry__msg">${escapeHtml(message)}</span>
  `;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

function toggleLog(toggle, entries) {
  toggle.classList.toggle('open');
  entries.classList.toggle('open');
}

// ---- Helpers ----
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- State Update (Player Side) ----
let playerTimerInterval = null;

function handleStateUpdate(payload) {
  const { phase, phaseEndsAt, alivePlayers, lastNightResult, lastVoteResult, winner, allPlayers } = payload;
  const session = loadSession() || {};
  session.lastKnownPhase = phase;
  saveSession(session);

  // Sync alive status
  if (alivePlayers && phase !== 'GAME_OVER') {
    players.forEach(p => {
      p.alive = alivePlayers.some(ap => ap.playerId === p.playerId);
    });
    renderPlayerPlayerList();
  }

  // Sync Timer
  if (playerTimerInterval) clearInterval(playerTimerInterval);
  let timerEl = null;
  if (phase === 'NIGHT') timerEl = nightTimerEl;
  else if (phase === 'DAY') timerEl = document.getElementById('day-timer');
  else if (phase === 'VOTING') timerEl = voteTimerEl;

  if (timerEl && phaseEndsAt > 0) {
    if (phase === 'DAY' && playerDayTimerContainer) {
      playerDayTimerContainer.style.display = 'flex';
    } else if (playerDayTimerContainer) {
      playerDayTimerContainer.style.display = 'none';
    }

    playerTimerInterval = setInterval(() => {
      const remaining = Math.max(0, phaseEndsAt - Date.now());
      const secs = Math.ceil(remaining / 1000);
      
      const m = Math.floor(secs / 60).toString().padStart(2, '0');
      const s = (secs % 60).toString().padStart(2, '0');
      timerEl.textContent = `${m}:${s}`;
      
      if (secs <= 10) {
        timerEl.parentElement.classList.add('is-urgent');
      } else {
        timerEl.parentElement.classList.remove('is-urgent');
      }

      if (remaining <= 0) {
        clearInterval(playerTimerInterval);
      }
    }, 200);
  } else if (playerDayTimerContainer) {
    playerDayTimerContainer.style.display = 'none';
  }

  // Handle phase transitions
  if (phase === 'LOBBY') {
    // Host restarted the game — return to lobby
    showScreen('player');
    showToast('Host started a new lobby! Waiting for game to begin...', 'info');
    // Re-enable chat in case it was disabled from death
    playerMsgInput.disabled = false;
    playerMsgSend.disabled = false;
    playerMsgInput.placeholder = 'Type a test message…';
    // Clear any stale role info
    session.lastKnownRole = null;
    saveSession(session);
  } else if (phase === 'ROLE_REVEAL') {
    showScreen('roleReveal');
  } else if (phase === 'NIGHT') {
    renderNightActionUI(alivePlayers, session.lastKnownRole);
    showScreen('night');
  } else if (phase === 'DAY') {
    showScreen('player'); 
    
    // Process night result
    if (lastNightResult) {
      const { victimId, doctorSavedId, investigateResult } = lastNightResult;
      
      // Build result messages for the persistent modal (for investigator/doctor)
      let nightResultLines = [];

      if (victimId === playerId) {
        showToast('You were eliminated in the night...', 'error');
        playerMsgInput.disabled = true;
        playerMsgSend.disabled = true;
        playerMsgInput.placeholder = 'You are dead...';
      } else if (victimId) {
        showToast('Someone was eliminated in the night!', 'warn');
      } else {
        showToast('The sun rises... nobody was eliminated.', 'success');
      }

      // Investigator result — show in persistent modal
      if (session.lastKnownRole === 'investigator' && investigateResult && investigateResult.targetId) {
        const targetName = alivePlayers.find(p => p.playerId === investigateResult.targetId)?.displayName || 'Unknown';
        const isMafia = investigateResult.result === 'mafia';
        nightResultLines.push({
          icon: '🕵️',
          title: 'Investigation Result',
          text: `<strong>${escapeHtml(targetName)}</strong> is aligned with the <strong style="color:${isMafia ? 'var(--color-mafia)' : 'var(--color-village)'}">${isMafia ? 'MAFIA' : 'VILLAGE'}</strong>`,
        });
      }

      // Doctor result — show in persistent modal
      if (session.lastKnownRole === 'doctor' && doctorSavedId) {
        const savedName = alivePlayers.find(p => p.playerId === doctorSavedId)?.displayName || 'Someone';
        nightResultLines.push({
          icon: '🩺',
          title: 'Protection Successful!',
          text: `You saved <strong>${escapeHtml(savedName)}</strong> from the Mafia's attack!`,
        });
      } else if (session.lastKnownRole === 'doctor' && !doctorSavedId) {
        nightResultLines.push({
          icon: '🩺',
          title: 'Protection Report',
          text: 'Your patient was not targeted by the Mafia tonight.',
        });
      }

      // Show persistent modal if there are results for this player
      if (nightResultLines.length > 0) {
        showNightResultModal(nightResultLines);
      }
    }
  } else if (phase === 'VOTING') {
    renderVotingUI(alivePlayers, session.lastKnownRole);
    showScreen('voting');
  } else if (phase === 'GAME_OVER') {
    renderGameOverUI(winner, allPlayers);
    showScreen('gameOver');
    const winnerLabel = winner === 'VILLAGE' ? '🏆 Village Wins!' : '🏆 Mafia Wins!';
    showToast(winnerLabel, 'success');
  }
}

function renderGameOverUI(winner, allPlayersList) {
  if (!allPlayersList) return;
  
  const isVillageWin = winner === 'VILLAGE';
  
  // Big dramatic winner title
  gameOverTitle.innerHTML = isVillageWin
    ? '🏆 Village Wins! 🎉'
    : '🏆 Mafia Wins! 🔪';
  gameOverTitle.style.fontSize = 'var(--font-size-2xl)';
  gameOverTitle.style.color = isVillageWin ? 'var(--color-village)' : 'var(--color-mafia)';
  
  gameOverSubtitle.textContent = isVillageWin
    ? 'The Village has uncovered and eliminated all the Mafia!'
    : 'The Mafia outnumbered the Village and seized control!';
  gameOverSubtitle.style.color = isVillageWin ? 'var(--color-village)' : 'var(--color-mafia)';
  gameOverSubtitle.style.fontWeight = '600';
  gameOverSubtitle.style.fontSize = 'var(--font-size-base)';

  // Sort: alive first, then dead
  const sorted = [...allPlayersList].sort((a, b) => {
    if (a.alive === b.alive) return 0;
    return a.alive ? -1 : 1;
  });

  gameOverPlayers.innerHTML = sorted.map(p => {
    const isDead = !p.alive;
    let roleName = 'Unknown';
    let roleIcon = '❓';
    let roleColor = 'var(--color-text-muted)';
    
    if (p.role) {
      const def = ROLES[p.role.toUpperCase()];
      if (def) {
        roleName = def.name;
        roleIcon = def.icon;
        roleColor = def.team === 'mafia' ? 'var(--color-mafia)' : 'var(--color-village)';
      }
    }
    
    return `
      <li class="player-item ${isDead ? 'is-dead' : ''}" style="padding: var(--space-md); border-bottom: 1px solid rgba(255,255,255,0.05);">
        <div class="player-item__avatar" style="font-size: var(--font-size-xl);">${isDead ? '💀' : roleIcon}</div>
        <div style="flex: 1;">
          <span class="player-item__name" style="${isDead ? 'text-decoration: line-through; opacity: 0.6;' : 'font-weight: 700;'}">${escapeHtml(p.displayName)}</span>
          <div style="font-size: var(--font-size-sm); color: ${roleColor}; margin-top: 2px; font-weight: 600;">
            ${roleIcon} ${roleName}
          </div>
        </div>
        <span class="player-item__status">
          ${isDead 
            ? '<span style="color:var(--color-text-muted); font-size:var(--font-size-xs); background: rgba(248,113,113,0.15); padding: 2px 8px; border-radius: 9999px;">💀 Eliminated</span>' 
            : '<span style="color:var(--color-success); font-size:var(--font-size-xs); background: rgba(74,222,128,0.15); padding: 2px 8px; border-radius: 9999px;">✅ Survived</span>'}
        </span>
      </li>
    `;
  }).join('');
}

function renderNightActionUI(alivePlayers, myRole) {
  let promptText = '';
  let canAct = false;
  const isAlive = alivePlayers.some(p => p.playerId === playerId);
  
  if (!isAlive) {
    promptText = 'You are dead. Wait for morning.';
    canAct = false;
  } else if (myRole === 'mafia') {
    promptText = 'Select a player to eliminate:';
    canAct = true;
  } else if (myRole === 'doctor') {
    promptText = 'Select a player to protect:';
    canAct = true;
  } else if (myRole === 'investigator') {
    promptText = 'Select a player to investigate:';
    canAct = true;
  } else {
    promptText = 'Blend in (select a player randomly to fake an action):';
    canAct = true;
  }

  let html = `<p class="text-center mb-md">${promptText}</p>`;
  
  if (canAct) {
    html += '<div class="action-grid">';
    alivePlayers.forEach(p => {
      const isSelf = p.playerId === playerId;
      if (isSelf && myRole !== 'doctor') return; // Cannot act on self unless doctor
      
      html += `
        <div class="action-card" data-target-id="${p.playerId}">
          <div class="action-card__avatar">${getInitial(p.displayName)}</div>
          <span class="action-card__name">${escapeHtml(p.displayName)}</span>
        </div>
      `;
    });
    html += '</div>';
    
    html += `
      <button id="btn-submit-night-action" class="btn btn--primary btn--full mt-lg" disabled>
        Confirm Action
      </button>
    `;
  }

  nightActionContainer.innerHTML = html;

  if (canAct) {
    const cards = nightActionContainer.querySelectorAll('.action-card');
    const submitBtn = document.getElementById('btn-submit-night-action');
    let selectedId = null;

    cards.forEach(card => {
      card.addEventListener('click', () => {
        if (card.classList.contains('is-disabled')) return;
        cards.forEach(c => c.classList.remove('is-selected'));
        card.classList.add('is-selected');
        selectedId = card.getAttribute('data-target-id');
        submitBtn.disabled = false;
      });
    });

    submitBtn.addEventListener('click', () => {
      if (selectedId && playerAPI) {
        playerAPI.sendAction(selectedId);
        submitBtn.disabled = true;
        submitBtn.textContent = 'Action Confirmed';
        cards.forEach(c => c.classList.add('is-disabled'));
      }
    });
  }
}

function renderVotingUI(alivePlayers, myRole) {
  const isAlive = alivePlayers.some(p => p.playerId === playerId);
  let html = '';

  if (!isAlive) {
    html = '<p class="text-center mb-md">You are dead. Watching the votes.</p>';
  } else {
    html = '<p class="text-center mb-md">Vote to eliminate a player:</p>';
    html += '<div class="action-grid">';
    
    // Allow skip vote
    html += `
      <div class="action-card" data-target-id="skip">
        <div class="action-card__avatar">⏭️</div>
        <span class="action-card__name">Skip Vote</span>
      </div>
    `;

    alivePlayers.forEach(p => {
      if (p.playerId === playerId) return; // Cannot vote for yourself
      html += `
        <div class="action-card" data-target-id="${p.playerId}">
          <div class="action-card__avatar">${getInitial(p.displayName)}</div>
          <span class="action-card__name">${escapeHtml(p.displayName)}</span>
        </div>
      `;
    });
    html += '</div>';
    
    html += `
      <button id="btn-submit-vote" class="btn btn--danger btn--full mt-lg" disabled>
        Cast Vote
      </button>
    `;
  }

  voteActionContainer.innerHTML = html;

  if (isAlive) {
    const cards = voteActionContainer.querySelectorAll('.action-card');
    const submitBtn = document.getElementById('btn-submit-vote');
    let selectedId = null;

    cards.forEach(card => {
      card.addEventListener('click', () => {
        if (card.classList.contains('is-disabled')) return;
        cards.forEach(c => c.classList.remove('is-selected'));
        card.classList.add('is-selected');
        selectedId = card.getAttribute('data-target-id');
        submitBtn.disabled = false;
      });
    });

    submitBtn.addEventListener('click', () => {
      if (selectedId && playerAPI) {
        playerAPI.sendVote(selectedId);
        submitBtn.disabled = true;
        submitBtn.textContent = 'Vote Cast';
        cards.forEach(c => c.classList.add('is-disabled'));
      }
    });
  }
}

// ---- Persistent Night Result Modal ----
// Shows investigation / doctor results that stay on screen until dismissed
function showNightResultModal(resultLines) {
  // Remove any existing modal
  const existing = document.getElementById('night-result-modal');
  if (existing) existing.remove();

  const resultsHtml = resultLines.map(line => `
    <div style="
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: var(--radius-md);
      padding: var(--space-lg);
      margin-bottom: var(--space-md);
      text-align: center;
    ">
      <div style="font-size: 2.5rem; margin-bottom: var(--space-sm);">${line.icon}</div>
      <h3 style="font-size: var(--font-size-lg); margin-bottom: var(--space-sm); font-weight: 700;">${escapeHtml(line.title)}</h3>
      <p style="font-size: var(--font-size-base); line-height: 1.5; color: var(--color-text-primary);">${line.text}</p>
    </div>
  `).join('');

  const modal = document.createElement('div');
  modal.id = 'night-result-modal';
  modal.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    padding: var(--space-lg);
    animation: fadeSlideIn 0.3s ease both;
  `;

  modal.innerHTML = `
    <div style="
      width: 100%;
      max-width: 400px;
      background: var(--color-bg-card);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-lg);
      padding: var(--space-xl);
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    ">
      <h2 style="text-align: center; font-size: var(--font-size-xl); margin-bottom: var(--space-lg);">
        🌅 Night Report
      </h2>
      ${resultsHtml}
      <button id="btn-dismiss-night-result" style="
        width: 100%;
        padding: 14px;
        border: none;
        border-radius: var(--radius-md);
        background: var(--color-accent-gradient);
        color: #fff;
        font-family: var(--font-family);
        font-size: var(--font-size-base);
        font-weight: 600;
        cursor: pointer;
        margin-top: var(--space-md);
        min-height: 48px;
      ">
        ✅ Got it
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('btn-dismiss-night-result').addEventListener('click', () => {
    modal.style.opacity = '0';
    modal.style.transition = 'opacity 0.2s ease';
    setTimeout(() => modal.remove(), 200);
  });
}

// ---- Start ----
document.addEventListener('DOMContentLoaded', () => {
  init();
  window.addEventListener('beforeunload', () => {
    hostAPI?.destroy();
    playerAPI?.destroy();
  });
});
