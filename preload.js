
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_SET_EXPANDED = 'nexus:set-expanded';
const CHANNEL_ASK_AI = 'nexus:ask-ai';
const CHANNEL_CANCEL_AI = 'nexus:cancel-ai';
const CHANNEL_AI_EVENT = 'nexus:ai-event';
const CHANNEL_CURSOR_POSITION = 'nexus:cursor-position';

contextBridge.exposeInMainWorld('nexusWindow', {
  setExpanded(expanded) {
    if (typeof expanded !== 'boolean') return;

    ipcRenderer.send(CHANNEL_SET_EXPANDED, expanded);
  },

  askGemini(message) {
    if (typeof message !== 'string') {
      return Promise.resolve({
        ok: false,
        error: 'invalid_message',
      });
    }

    return ipcRenderer.invoke(CHANNEL_ASK_AI, message);
  },

  cancelAI(requestId) {
    if (typeof requestId !== 'string' || !requestId) return;

    ipcRenderer.send(CHANNEL_CANCEL_AI, requestId);
  },

  onAIEvent(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, payload) => {
      if (
        !payload ||
        typeof payload.requestId !== 'string' ||
        typeof payload.type !== 'string'
      ) {
        return;
      }

      callback(payload);
    };

    ipcRenderer.on(CHANNEL_AI_EVENT, listener);

    return () => {
      ipcRenderer.removeListener(CHANNEL_AI_EVENT, listener);
    };
  },

  onCursorPosition(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, position) => {
      if (
        !position ||
        typeof position.x !== 'number' ||
        typeof position.y !== 'number'
      ) {
        return;
      }

      callback(position);
    };

    ipcRenderer.on(CHANNEL_CURSOR_POSITION, listener);

    return () => {
      ipcRenderer.removeListener(CHANNEL_CURSOR_POSITION, listener);
    };
  },
});
