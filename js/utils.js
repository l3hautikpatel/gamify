/* ============================================================
   Online Mafia — Utility Functions
   ============================================================ */

/**
 * Generate a 6-character alphanumeric room code.
 * Excludes ambiguous characters: O, 0, I, 1, L
 */
export function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Build the host's deterministic PeerJS ID from a room code.
 * This is critical for reconnection — see Section 4 & 7 of the spec.
 */
export function buildHostPeerId(roomCode) {
  const normalized = (roomCode || '').toLowerCase().trim();
  return `mafia-${normalized}-host`;
}

/**
 * Build a shareable join link for a room.
 */
export function buildShareableLink(roomCode) {
  const url = new URL(normalizeLocalOrigin(window.location.href));
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', roomCode);
  return url.toString();
}

/**
 * Generate a stable player ID (UUID v4-ish).
 * Used to identify players across reconnections — not the display name.
 */
export function generatePlayerId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return 'p_' + crypto.randomUUID().slice(0, 8);
  }
  return 'p_' + Math.random().toString(36).substring(2, 10);
}

/**
 * Format a timestamp for the connection log.
 */
export function formatTimestamp(date = new Date()) {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Get the first letter of a name for avatar display.
 */
export function getInitial(name) {
  return (name || '?')[0].toUpperCase();
}

/**
 * Parse URL search params for a room code.
 */
export function getRoomCodeFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('room') || '';
}

export function isLocalHost(hostname = '') {
  const normalized = (hostname || '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '0.0.0.0';
}

export function normalizeLocalOrigin(url = window.location.href) {
  if (typeof window === 'undefined') return url;

  const parsed = new URL(url);
  if (!isLocalHost(parsed.hostname)) return url;

  parsed.hostname = '127.0.0.1';
  return parsed.toString();
}

/**
 * Copy text to clipboard with fallback.
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / insecure contexts
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Remove after animation
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

/**
 * Track whether this tab is allowed to auto-restore a session.
 * This prevents a new browser tab from inheriting the host/player session
 * from shared localStorage and jumping into the wrong screen.
 */
function setRestoreToken() {
  try {
    sessionStorage.setItem('mafia_restore_token', '1');
  } catch {
    // ignore
  }
}

function clearRestoreToken() {
  try {
    sessionStorage.removeItem('mafia_restore_token');
  } catch {
    // ignore
  }
}

function canAutoRestore() {
  try {
    return sessionStorage.getItem('mafia_restore_token') === '1';
  } catch {
    return false;
  }
}

/**
 * Save session data to localStorage.
 * Even in Phase 1, we prep the session structure for future reconnection.
 */
export function saveSession(data) {
  try {
    localStorage.setItem('mafia_session', JSON.stringify(data));
    setRestoreToken();
  } catch {
    // localStorage might be full or blocked
    console.warn('Could not save session to localStorage');
  }
}

/**
 * Load session data from localStorage.
 */
export function loadSession() {
  if (!canAutoRestore()) return null;

  try {
    const raw = localStorage.getItem('mafia_session');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Clear session data.
 */
export function clearSession() {
  try {
    localStorage.removeItem('mafia_session');
    localStorage.removeItem('mafia_host_state');
    clearRestoreToken();
  } catch {
    // ignore
  }
}

/**
 * Save host state to localStorage (host-only).
 */
export function saveHostState(data) {
  try {
    localStorage.setItem('mafia_host_state', JSON.stringify(data));
    setRestoreToken();
  } catch {
    console.warn('Could not save host state to localStorage');
  }
}

/**
 * Load host state from localStorage.
 */
export function loadHostState() {
  if (!canAutoRestore()) return null;

  try {
    const raw = localStorage.getItem('mafia_host_state');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Fisher-Yates shuffle algorithm for an array.
 * Mutates the array in-place and returns it.
 */
export function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
