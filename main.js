
'use strict';

const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
} = require('electron');

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { GoogleGenAI } = require('@google/genai');

// ======================================================================
// 01. CONFIGURATION
// ======================================================================

const ISLAND_SIZES = Object.freeze({
  compact: Object.freeze({ width: 250, height: 60 }),
  expanded: Object.freeze({ width: 520, height: 500 }),
});

const TOP_MARGIN = 8;

const IPC_CHANNEL_SET_EXPANDED = 'nexus:set-expanded';
const IPC_CHANNEL_ASK_AI = 'nexus:ask-ai';
const IPC_CHANNEL_CANCEL_AI = 'nexus:cancel-ai';
const IPC_CHANNEL_AI_EVENT = 'nexus:ai-event';
const IPC_CHANNEL_CURSOR_POSITION = 'nexus:cursor-position';

const GEMINI_MODELS = Object.freeze([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]);

const GEMINI_MODEL = 'gemini-3.8-flash';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_MESSAGES = 12;

const MODEL_TIMEOUT_MS = 25000;
const TOTAL_TIMEOUT_MS = 60000;

// ======================================================================
// 02. ENVIRONMENT
// ======================================================================

let envLoadFailed = false;

const envPath = path.join(__dirname, '.env');

if (typeof process.loadEnvFile === 'function') {
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch (error) {
      envLoadFailed = true;

      console.error(
        'NEXUS: Failed to load .env:',
        error.message
      );
    }
  }
}

// ======================================================================
// 03. APPLICATION STATE
// ======================================================================

/** @type {BrowserWindow | null} */
let mainWindow = null;

let currentExpanded = false;
let geminiClient = null;
let conversationHistory = [];
let cursorTrackingTimer = null;

/** @type {null | object} */
let activeAIRequest = null;

const quotaExhaustedModels = new Set();

const rendererFileUrl = pathToFileURL(
  path.join(__dirname, 'renderer', 'index.html')
).href;

// ======================================================================
// 04. WINDOW POSITIONING
// ======================================================================

function getTopCenterBounds(width, height) {
  const { workArea } = screen.getPrimaryDisplay();

  const clampedWidth = Math.min(width, workArea.width);
  const clampedHeight = Math.min(height, workArea.height);

  return {
    x: Math.round(
      workArea.x + (workArea.width - clampedWidth) / 2
    ),

    y: Math.round(workArea.y + TOP_MARGIN),

    width: clampedWidth,
    height: clampedHeight,
  };
}

function repositionToTopCenter() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const preset = currentExpanded
    ? ISLAND_SIZES.expanded
    : ISLAND_SIZES.compact;

  mainWindow.setBounds(
    getTopCenterBounds(preset.width, preset.height)
  );
}

function applyIslandMode(expanded) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (currentExpanded === expanded) return;

  currentExpanded = expanded;

  const preset = expanded
    ? ISLAND_SIZES.expanded
    : ISLAND_SIZES.compact;

  mainWindow.setBounds(
    getTopCenterBounds(preset.width, preset.height)
  );
}

function handleSetExpanded(event, isExpanded) {
  if (!isTrustedRenderer(event)) return;
  if (typeof isExpanded !== 'boolean') return;

  applyIslandMode(isExpanded);
}

// ======================================================================
// 05. GLOBAL CURSOR TRACKING
// ======================================================================

function sendCursorPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    const cursor = screen.getCursorScreenPoint();
    const windowBounds = mainWindow.getBounds();

    mainWindow.webContents.send(
      IPC_CHANNEL_CURSOR_POSITION,
      {
        x: cursor.x,
        y: cursor.y,
        windowBounds,
      }
    );

  } catch (error) {
    console.warn(
      'NEXUS: Cursor tracking unavailable:',
      error
    );
  }
}

function startCursorTracking() {
  if (cursorTrackingTimer !== null) return;

  sendCursorPosition();

  cursorTrackingTimer = setInterval(
    sendCursorPosition,
    33
  );
}

function stopCursorTracking() {
  if (cursorTrackingTimer === null) return;

  clearInterval(cursorTrackingTimer);
  cursorTrackingTimer = null;
}

// ======================================================================
// 06. API ERROR UTILITIES
// ======================================================================

function getErrorStatus(error) {
  const directStatus = Number(
    error?.status || error?.code
  );

  if (
    Number.isFinite(directStatus) &&
    directStatus > 0
  ) {
    return directStatus;
  }

  try {
    const parsed = JSON.parse(error?.message || '');

    return Number(parsed?.error?.code) || 0;

  } catch {
    return 0;
  }
}

function getErrorMessage(error) {
  const messages = [
    error?.message,
    error?.error?.message,
    error?.response?.data?.error?.message,
  ];

  return messages
    .filter((value) => typeof value === 'string')
    .join(' ');
}

function isDailyQuotaExceeded(error) {
  const message = getErrorMessage(error);

  return (
    /GenerateRequestsPerDayPer(?:Project)?PerModel-FreeTier/i.test(message) ||
    /Generate content requests per day limit exceeded/i.test(message) ||
    /requests per day limit exceeded/i.test(message)
  );
}

function getPublicErrorCode(error) {
  if (
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError'
  ) {
    return 'timeout';
  }

  const status = getErrorStatus(error);

  if (status === 401 || status === 403) {
    return 'authentication';
  }

  if (status === 429) {
    return 'rate_limit';
  }

  if (
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return 'api_error';
  }

  const code =
    typeof error?.code === 'string'
      ? error.code
      : '';

  const message = getErrorMessage(error);

  if (
    /^(EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENOTFOUND|ETIMEDOUT)$/.test(code) ||
    /fetch failed|network error/i.test(message)
  ) {
    return 'network';
  }

  return 'api_error';
}

function sanitizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const parts = Array.isArray(entry.parts) ? entry.parts : [];

  const safeParts = parts
    .filter((part) => part && typeof part === 'object')
    .map((part) => ({
      text: typeof part.text === 'string' ? part.text.slice(0, 2000) : '',
    }))
    .filter((part) => part.text.length > 0);

  if (!safeParts.length) {
    return null;
  }

  return {
    role: entry.role === 'model' ? 'model' : 'user',
    parts: safeParts,
  };
}

function updateConversationHistory(userMessage, answer) {
  const newHistory = [
    ...conversationHistory,
    {
      role: 'user',
      parts: [{ text: userMessage.slice(0, MAX_MESSAGE_LENGTH) }],
    },
    {
      role: 'model',
      parts: [{ text: answer.slice(0, MAX_MESSAGE_LENGTH) }],
    },
  ]
    .map(sanitizeHistoryEntry)
    .filter(Boolean)
    .slice(-MAX_HISTORY_MESSAGES);

  conversationHistory = newHistory;
}

// ======================================================================
// 07. TRUSTED RENDERER VALIDATION
// ======================================================================

function isTrustedRenderer(event) {
  return (
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    !!event.senderFrame &&
    event.senderFrame.isMainFrame !== false &&
    event.senderFrame.url === rendererFileUrl
  );
}

// ======================================================================
// 08. REQUEST EVENT SYSTEM
// ======================================================================

function sendAIEvent(request, type, details = {}) {
  if (!request || request.finished) return;

  if (
    request.cancelled &&
    type !== 'complete'
  ) {
    return;
  }

  if (
    !request.sender ||
    request.sender.isDestroyed()
  ) {
    return;
  }

  try {
    request.sender.send(
      IPC_CHANNEL_AI_EVENT,
      {
        ...details,
        requestId: request.id,
        type,
      }
    );

    if (
      type === 'complete' ||
      type === 'error'
    ) {
      request.finished = true;
    }

  } catch (error) {
    console.warn(
      'NEXUS: Could not send AI event:',
      error
    );
  }
}

function registerController(request, provider, controller) {
  const entry = {
    provider,
    controller,
  };

  request.controllers.add(entry);

  return () => {
    request.controllers.delete(entry);
  };
}

function abortOtherProviders(request, winningProvider) {
  for (const entry of request.controllers) {
    if (entry.provider !== winningProvider) {
      try {
        entry.controller.abort();
      } catch {
        // Ignore already-aborted requests.
      }
    }
  }
}

function abortAllProviders(request) {
  for (const entry of request.controllers) {
    try {
      entry.controller.abort();
    } catch {
      // Ignore already-aborted requests.
    }
  }
}

function claimWinner(request, provider, model) {
  if (request.cancelled || request.finished) {
    return false;
  }

  if (request.winner) {
    return request.winner === provider;
  }

  request.winner = provider;
  request.winningModel = model;

  console.log(
    `NEXUS: ${provider} won using ${model}.`
  );

  sendAIEvent(request, 'winner', {
    provider,
    model,
  });

  abortOtherProviders(request, provider);

  return true;
}

function emitAIChunk(request, provider, text) {
  if (
    request.cancelled ||
    request.finished ||
    request.winner !== provider ||
    typeof text !== 'string' ||
    !text
  ) {
    return;
  }

  request.answer += text;

  sendAIEvent(request, 'chunk', {
    provider,
    text,
  });
}

// ======================================================================
// 09. GEMINI STREAMING PROVIDER
// ======================================================================

async function runGemini(request, userMessage) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'Gemini API key is not configured.'
    );
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  const safeHistory = conversationHistory
    .map(sanitizeHistoryEntry)
    .filter(Boolean);

  const requestMessages = [
    ...safeHistory,
    {
      role: 'user',
      parts: [{ text: userMessage }],
    },
  ];

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    if (request.cancelled || request.finished) {
      return;
    }

    if (
      request.winner &&
      request.winner !== 'Gemini'
    ) {
      return;
    }

    if (quotaExhaustedModels.has(model)) {
      console.log(
        `NEXUS: Skipping exhausted Gemini model ${model}.`
      );

      continue;
    }

    const controller = new AbortController();

    const unregister = registerController(
      request,
      'Gemini',
      controller
    );

    const timeoutId = setTimeout(() => {
      if (!request.winner) {
        controller.abort();
      }
    }, MODEL_TIMEOUT_MS);

    const startedAt = Date.now();
    let modelAnswer = '';

    console.log(
      `NEXUS: Starting Gemini model ${model}.`
    );

    try {
      const stream =
        await geminiClient.models.generateContentStream({
          model,
          contents: requestMessages,
          config: {
            abortSignal: controller.signal,
          },
        });

      for await (const chunk of stream) {
        if (
          request.cancelled ||
          request.finished
        ) {
          return;
        }

        if (
          request.winner &&
          request.winner !== 'Gemini'
        ) {
          return;
        }

        const text =
          typeof chunk?.text === 'string'
            ? chunk.text
            : '';

        if (!text) continue;

        if (!request.winner) {
          claimWinner(request, 'Gemini', model);
        }

        if (request.winner !== 'Gemini') {
          return;
        }

        modelAnswer += text;
        emitAIChunk(request, 'Gemini', text);
      }

      if (!modelAnswer.trim()) {
        throw new Error(
          'Gemini returned an empty response.'
        );
      }

      request.successfulModel = model;

      console.log(
        `NEXUS: Gemini ${model} completed in ` +
        `${((Date.now() - startedAt) / 1000).toFixed(2)} seconds.`
      );

      return;

    } catch (error) {
      lastError = error;

      if (
        request.cancelled ||
        request.finished
      ) {
        return;
      }

      if (
        request.winner &&
        request.winner !== 'Gemini'
      ) {
        return;
      }

      if (request.winner === 'Gemini') {
        throw error;
      }

      if (isDailyQuotaExceeded(error)) {
        quotaExhaustedModels.add(model);

        console.warn(
          `NEXUS: Daily quota exhausted for ${model}.`
        );

        continue;
      }

      const status = getErrorStatus(error);
      const retryable =
        error?.name === 'AbortError' ||
        error?.name === 'TimeoutError' ||
        status === 502 ||
        status === 503 ||
        status === 504;

      console.warn(
        'NEXUS: Gemini model failed:',
        {
          model,
          status,
          message: error?.message,
        }
      );

      if (!retryable) {
        throw error;
      }

    } finally {
      clearTimeout(timeoutId);
      unregister();
    }
  }

  throw lastError || new Error(
    'No available Gemini model completed the request.'
  );
}

// ======================================================================
// 10. GEMINI REQUEST EXECUTION
// ======================================================================

async function executeAIRequest(request, userMessage) {
  if (!process.env.GEMINI_API_KEY) {
    sendAIEvent(request, 'error', {
      error: 'missing_api_key',
    });

    if (activeAIRequest === request) {
      activeAIRequest = null;
    }

    return;
  }

  sendAIEvent(request, 'started', {
    providers: ['Gemini'],
  });

  const timeoutId = setTimeout(() => {
    if (
      request.cancelled ||
      request.finished
    ) {
      return;
    }

    console.warn(
      'NEXUS: Overall AI request timed out.'
    );

    abortAllProviders(request);

    sendAIEvent(request, 'error', {
      error: 'timeout',
    });

  }, TOTAL_TIMEOUT_MS);

  try {
    await runGemini(request, userMessage);

    if (
      request.cancelled ||
      request.finished
    ) {
      return;
    }

    if (!request.winner || !request.answer.trim()) {
      sendAIEvent(request, 'error', {
        error: 'api_error',
      });

      return;
    }

    const answer = request.answer.trim();
    updateConversationHistory(userMessage, answer);

    console.log(
      `NEXUS: ${request.winner} successfully completed the response.`
    );

    sendAIEvent(request, 'complete', {
      ok: true,
      provider: request.winner,
      model: request.successfulModel || null,
      text: answer,
    });

  } catch (error) {
    console.error(
      'NEXUS: AI engine error:',
      error
    );

    sendAIEvent(request, 'error', {
      error: getPublicErrorCode(error),
    });

  } finally {
    clearTimeout(timeoutId);
    abortAllProviders(request);
    request.controllers.clear();

    if (activeAIRequest === request) {
      activeAIRequest = null;
    }
  }
}

// ======================================================================
// 12. IPC VALIDATION AND REQUEST HANDLING
// ======================================================================

function handleAskAI(event, message) {
  if (!isTrustedRenderer(event)) {
    return {
      ok: false,
      error: 'unavailable',
    };
  }

  if (typeof message !== 'string') {
    return {
      ok: false,
      error: 'invalid_message',
    };
  }

  const text = message.trim();

  if (
    !text ||
    text.length > MAX_MESSAGE_LENGTH
  ) {
    return {
      ok: false,
      error: 'invalid_message',
    };
  }

  if (activeAIRequest) {
    return {
      ok: false,
      error: 'busy',
    };
  }

  if (envLoadFailed) {
    return {
      ok: false,
      error: 'configuration',
    };
  }

  if (
    !process.env.GEMINI_API_KEY &&
    !process.env.GROQ_API_KEY
  ) {
    return {
      ok: false,
      error: 'missing_api_keys',
    };
  }

  const request = {
    id: crypto.randomUUID(),

    sender: event.sender,

    winner: null,
    winningModel: null,
    successfulModel: null,

    answer: '',

    cancelled: false,
    finished: false,

    controllers: new Set(),
  };

  activeAIRequest = request;

  console.log(
    'NEXUS: Accepted AI request:',
    request.id
  );

  // Start the providers in the background.
  // Return the request ID immediately to the renderer.
  executeAIRequest(request, text).catch((error) => {
    console.error(
      'NEXUS: Unhandled AI request error:',
      error
    );

    sendAIEvent(request, 'error', {
      error: 'api_error',
    });

    if (activeAIRequest === request) {
      activeAIRequest = null;
    }
  });

  return {
    ok: true,
    requestId: request.id,
  };
}

function handleCancelAI(event, requestId) {
  if (!isTrustedRenderer(event)) return;

  if (typeof requestId !== 'string') {
    return;
  }

  const request = activeAIRequest;

  if (
    !request ||
    request.id !== requestId ||
    request.finished
  ) {
    return;
  }

  request.cancelled = true;

  abortAllProviders(request);

  sendAIEvent(request, 'complete', {
    ok: false,
    cancelled: true,
    error: 'cancelled',
  });

  if (activeAIRequest === request) {
    activeAIRequest = null;
  }

  console.log(
    'NEXUS: AI request cancelled.'
  );
}

// ======================================================================
// 13. MAIN WINDOW
// ======================================================================

function createMainWindow() {
  const preset = ISLAND_SIZES.compact;

  const bounds = getTopCenterBounds(
    preset.width,
    preset.height
  );

  mainWindow = new BrowserWindow({
    ...bounds,

    title: 'NEXUS',

    show: false,

    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,

    resizable: false,
    movable: false,

    minimizable: false,
    maximizable: false,
    fullscreenable: false,

    skipTaskbar: true,
    alwaysOnTop: true,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),

      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,

      allowRunningInsecureContent: false,
    },
  });

  currentExpanded = false;

  const { webContents } = mainWindow;

  webContents.setWindowOpenHandler(() => ({
    action: 'deny',
  }));

  webContents.on('will-navigate', (event, url) => {
    if (url !== rendererFileUrl) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    if (activeAIRequest) {
      activeAIRequest.cancelled = true;

      abortAllProviders(activeAIRequest);

      activeAIRequest = null;
    }

    mainWindow = null;
  });

  mainWindow
    .loadFile(
      path.join(__dirname, 'renderer', 'index.html')
    )
    .catch((error) => {
      console.error(
        'NEXUS: Failed to load renderer/index.html:',
        error
      );
    });
}

// ======================================================================
// 14. APPLICATION LIFECYCLE
// ======================================================================

if (!app.requestSingleInstanceLock()) {
  app.quit();

} else {
  app.on('second-instance', () => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    ipcMain.on(
      IPC_CHANNEL_SET_EXPANDED,
      handleSetExpanded
    );

    ipcMain.handle(
      IPC_CHANNEL_ASK_AI,
      handleAskAI
    );

    ipcMain.on(
      IPC_CHANNEL_CANCEL_AI,
      handleCancelAI
    );

    createMainWindow();

    startCursorTracking();

    screen.on(
      'display-metrics-changed',
      repositionToTopCenter
    );

    screen.on(
      'display-added',
      repositionToTopCenter
    );

    screen.on(
      'display-removed',
      repositionToTopCenter
    );
  });

  app.on('will-quit', () => {
    stopCursorTracking();

    if (activeAIRequest) {
      activeAIRequest.cancelled = true;

      abortAllProviders(activeAIRequest);

      activeAIRequest = null;
    }

    ipcMain.removeListener(
      IPC_CHANNEL_SET_EXPANDED,
      handleSetExpanded
    );

    ipcMain.removeHandler(
      IPC_CHANNEL_ASK_AI
    );

    ipcMain.removeListener(
      IPC_CHANNEL_CANCEL_AI,
      handleCancelAI
    );
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
