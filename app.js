
'use strict';

/**
 * NEXUS — renderer/app.js
 *
 * Features:
 *   - Live 12-hour clock
 *   - Natural blinking and occasional double blinking
 *   - Global Windows cursor tracking
 *   - Local mouse tracking fallback
 *   - Smooth eye movement through CSS transitions
 *   - Assistant expression and state management
 *   - Island expansion
 *   - Five-section workspace navigation
 *   - Gemini AI streaming
 *   - First-response-wins provider selection
 *   - Live chat rendering
 *   - Independent animation timer management
 *
 * Plain vanilla JavaScript.
 */

(() => {
  // ======================================================================
  // 01. CONFIGURATION
  // ======================================================================

  const STATE_CONFIG = Object.freeze({
    idle: Object.freeze({
      label: 'Idle',
      expression: 'neutral',
      micPressed: false,
      micAriaLabel: 'Activate voice assistant',
      assistantMessage: 'Ready',
    }),

    listening: Object.freeze({
      label: 'Listening',
      expression: 'listening',
      micPressed: true,
      micAriaLabel: 'Stop listening',
      assistantMessage: 'Listening…',
    }),

    thinking: Object.freeze({
      label: 'Thinking',
      expression: 'thinking',
      micPressed: false,
      micAriaLabel: 'Assistant is thinking',
      assistantMessage: 'Thinking…',
    }),

    speaking: Object.freeze({
      label: 'Speaking',
      expression: 'speaking',
      micPressed: false,
      micAriaLabel: 'Assistant is speaking',
      assistantMessage: 'Speaking…',
    }),

    error: Object.freeze({
      label: 'Error',
      expression: 'concerned',
      micPressed: false,
      micAriaLabel: 'Voice assistant unavailable',
      assistantMessage: 'Something went wrong',
    }),
  });

  const IDLE_EXPRESSIONS = Object.freeze([
    'happy',
    'curious',
    'surprised',
  ]);

  const WORKSPACE_SECTIONS = Object.freeze([
    'home',
    'chat',
    'voice',
    'tools',
    'more',
  ]);

  const BLINK_EXCLUDED_EXPRESSIONS = Object.freeze([
    'sleepy',
    'thinking',
  ]);

  const BLINK_MIN_MS = 2400;
  const BLINK_MAX_MS = 6800;
  const DOUBLE_BLINK_CHANCE = 0.15;
  const DOUBLE_BLINK_DELAY = 260;

  const PERSONALITY_MIN_MS = 9000;
  const PERSONALITY_MAX_MS = 17000;
  const PERSONALITY_DURATION_MS = 1600;

  const LOOK_MAX_PX = 2.5;
  const LOOK_DISTANCE_SCALE = 350;

  const MAX_CHAT_LENGTH = 4000;

  // ======================================================================
  // 02. ELEMENT REFERENCES
  // ======================================================================

  const els = {
    island: null,
    islandExpanded: null,

    character: null,
    eyes: null,
    eyeLeft: null,
    eyeRight: null,
    mouth: null,

    clock: null,
    clockExpanded: null,

    voiceStatus: null,
    voiceStatusText: null,
    voiceStatusExpanded: null,

    micButton: null,
    assistantMessage: null,

    chatMessages: null,
    chatThinking: null,
    chatForm: null,
    chatInput: null,
    chatSend: null,
  };

  // ======================================================================
  // 03. APPLICATION STATE
  // ======================================================================

  const state = {
    assistant: 'idle',
    hovered: false,
    focused: false,
    workspaceSection: 'home',
  };

  const timers = {
    clock: null,
    blink: null,
    blinkFollowup: null,
    personality: null,
    personalityReset: null,
    expressionReset: null,
  };

  let lastSentExpanded = null;
  let cursorUnsubscribe = null;
  let aiEventUnsubscribe = null;

  let reducedMotion = false;
  let initialized = false;
  let chatPending = false;

  // Streaming chat state.
  let activeChatRequestId = null;
  let activeChatBubble = null;
  let chatRequestStarting = false;
  let earlyAIEvents = [];

  // ======================================================================
  // 04. UTILITIES
  // ======================================================================

  const get = (id) => document.getElementById(id);

  function cacheElements() {
    els.island = get('island');
    els.islandExpanded = get('island-expanded');

    els.character = get('character');
    els.eyes = get('eyes');
    els.eyeLeft = get('eye-left');
    els.eyeRight = get('eye-right');
    els.mouth = get('mouth');

    els.clock = get('clock');
    els.clockExpanded = get('clock-expanded');

    els.voiceStatus = get('voice-status');
    els.voiceStatusText = get('voice-status-text');
    els.voiceStatusExpanded = get('voice-status-expanded');

    els.micButton = get('mic-button');
    els.assistantMessage = get('assistant-message');

    els.chatMessages = get('chat-messages');
    els.chatThinking = get('chat-thinking');
    els.chatForm = get('chat-form');
    els.chatInput = get('chat-input');
    els.chatSend = get('chat-send');
  }

  function setExpression(expression) {
    [
      els.eyeLeft,
      els.eyeRight,
      els.mouth,
      els.character,
    ].forEach((element) => {
      if (element) {
        element.setAttribute('data-expression', expression);
      }
    });
  }

  function clearTimer(name) {
    if (timers[name] !== null) {
      window.clearTimeout(timers[name]);
      timers[name] = null;
    }
  }

  function clearExpressionReset() {
    clearTimer('expressionReset');
  }

  function clearPersonalityReset() {
    clearTimer('personalityReset');
  }

  // ======================================================================
  // 05. PRELOAD BRIDGE
  // ======================================================================

  function getBridge() {
    return typeof window !== 'undefined'
      ? window.nexusWindow
      : undefined;
  }

  function syncExpandedToMain(isExpanded) {
    if (lastSentExpanded === isExpanded) return;

    const api = getBridge();

    if (!api || typeof api.setExpanded !== 'function') {
      return;
    }

    try {
      const sent = api.setExpanded(isExpanded);

      if (sent === true) {
        lastSentExpanded = isExpanded;
      }
    } catch {
      // IPC errors must not interrupt the renderer.
    }
  }

  // ======================================================================
  // 06. CLOCK
  // ======================================================================

  function formatTime(date) {
    const hours24 = date.getHours();
    const hours12 = hours24 % 12 || 12;

    const minutes = String(
      date.getMinutes()
    ).padStart(2, '0');

    const suffix = hours24 < 12 ? 'AM' : 'PM';

    return {
      display: `${hours12}:${minutes} ${suffix}`,
      iso: date.toISOString(),
    };
  }

  function updateClock() {
    const { display, iso } = formatTime(new Date());

    if (els.clock) {
      els.clock.textContent = display;
      els.clock.setAttribute('datetime', iso);
    }

    if (els.clockExpanded) {
      els.clockExpanded.textContent = display;
      els.clockExpanded.setAttribute('datetime', iso);
    }
  }

  function scheduleClockTick() {
    clearTimer('clock');

    updateClock();

    const delay = 1000 - (Date.now() % 1000);

    timers.clock = window.setTimeout(
      scheduleClockTick,
      delay
    );
  }

  // ======================================================================
  // 07. CHARACTER — BLINKING
  // ======================================================================

  function currentEyeExpression() {
    return els.eyeLeft
      ? els.eyeLeft.getAttribute('data-expression')
      : null;
  }

  function shouldAutoBlink() {
    if (reducedMotion || document.hidden) {
      return false;
    }

    return !BLINK_EXCLUDED_EXPRESSIONS.includes(
      currentEyeExpression()
    );
  }

  function triggerBlink() {
    if (!els.eyeLeft || !els.eyeRight) return;

    [els.eyeLeft, els.eyeRight].forEach((eye) => {
      eye.classList.remove('is-blinking');

      void eye.offsetWidth;

      eye.classList.add('is-blinking');
    });
  }

  function scheduleBlink() {
    clearTimer('blink');

    if (!shouldAutoBlink()) return;

    const delay =
      BLINK_MIN_MS +
      Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);

    timers.blink = window.setTimeout(() => {
      timers.blink = null;

      if (!shouldAutoBlink()) {
        scheduleBlink();
        return;
      }

      triggerBlink();

      if (Math.random() < DOUBLE_BLINK_CHANCE) {
        clearTimer('blinkFollowup');

        timers.blinkFollowup = window.setTimeout(() => {
          timers.blinkFollowup = null;

          if (shouldAutoBlink()) {
            triggerBlink();
          }
        }, DOUBLE_BLINK_DELAY);
      }

      scheduleBlink();
    }, delay);
  }

  // ======================================================================
  // 08. CHARACTER — CURSOR TRACKING
  // ======================================================================

  function setLook(x, y) {
    const root = document.documentElement;

    root.style.setProperty(
      '--look-x',
      `${x.toFixed(2)}px`
    );

    root.style.setProperty(
      '--look-y',
      `${y.toFixed(2)}px`
    );
  }

  function calculateLook(cursorX, cursorY, windowBounds) {
    if (!els.eyes || !windowBounds) return;

    const rect = els.eyes.getBoundingClientRect();

    if (!rect.width || !rect.height) return;

    const centerX =
      windowBounds.x + rect.left + rect.width / 2;

    const centerY =
      windowBounds.y + rect.top + rect.height / 2;

    const dx = cursorX - centerX;
    const dy = cursorY - centerY;

    const distance = Math.hypot(dx, dy);

    if (distance < 1) {
      setLook(0, 0);
      return;
    }

    const intensity = Math.min(
      1,
      distance / LOOK_DISTANCE_SCALE
    );

    const angle = Math.atan2(dy, dx);

    setLook(
      Math.cos(angle) * intensity * LOOK_MAX_PX,
      Math.sin(angle) * intensity * LOOK_MAX_PX
    );
  }

  function calculateLocalLook(cursorX, cursorY) {
    if (!els.eyes) return;

    const rect = els.eyes.getBoundingClientRect();

    if (!rect.width || !rect.height) return;

    const dx = cursorX - (rect.left + rect.width / 2);
    const dy = cursorY - (rect.top + rect.height / 2);

    const distance = Math.hypot(dx, dy);

    if (distance < 1) {
      setLook(0, 0);
      return;
    }

    const intensity = Math.min(
      1,
      distance / LOOK_DISTANCE_SCALE
    );

    const angle = Math.atan2(dy, dx);

    setLook(
      Math.cos(angle) * intensity * LOOK_MAX_PX,
      Math.sin(angle) * intensity * LOOK_MAX_PX
    );
  }

  function bindMouseTracking() {
    if (reducedMotion || !els.eyes) return;

    const api = getBridge();

    if (api && typeof api.onCursorPosition === 'function') {
      try {
        const unsubscribe = api.onCursorPosition(
          (position) => {
            if (document.hidden || !position) return;

            calculateLook(
              position.x,
              position.y,
              position.windowBounds
            );
          }
        );

        if (typeof unsubscribe === 'function') {
          cursorUnsubscribe = unsubscribe;
        }

        return;
      } catch {
        cursorUnsubscribe = null;
      }
    }

    document.addEventListener(
      'mousemove',
      (event) => {
        if (document.hidden) return;

        calculateLocalLook(
          event.clientX,
          event.clientY
        );
      },
      { passive: true }
    );

    document.addEventListener(
      'mouseleave',
      () => setLook(0, 0)
    );
  }

  // ======================================================================
  // 09. ASSISTANT STATE
  // ======================================================================

  function setAssistantState(next) {
    const config = STATE_CONFIG[next];

    if (!config) return;

    state.assistant = next;

    clearExpressionReset();
    clearPersonalityReset();

    if (els.island) {
      els.island.dataset.assistantState = next;
    }

    if (els.micButton) {
      els.micButton.dataset.state = next;

      els.micButton.setAttribute(
        'aria-pressed',
        String(config.micPressed)
      );

      els.micButton.setAttribute(
        'aria-label',
        config.micAriaLabel
      );
    }

    if (els.voiceStatus) {
      els.voiceStatus.dataset.state = next;
    }

    if (els.voiceStatusText) {
      els.voiceStatusText.textContent = config.label;
    }

    if (els.voiceStatusExpanded) {
      els.voiceStatusExpanded.dataset.state = next;
      els.voiceStatusExpanded.textContent = config.label;
    }

    if (els.assistantMessage) {
      els.assistantMessage.textContent =
        config.assistantMessage;
    }

    setExpression(config.expression);

    if (next === 'thinking') {
      clearTimer('blink');
      clearTimer('blinkFollowup');
    } else if (!document.hidden) {
      scheduleBlink();
    }
  }

  // ======================================================================
  // 10. ISLAND EXPANSION
  // ======================================================================

  function applyExpandedState() {
    if (!els.island) return;

    const expanded = state.hovered || state.focused;

    els.island.classList.toggle(
      'is-expanded',
      expanded
    );

    els.island.setAttribute(
      'aria-expanded',
      String(expanded)
    );

    if (els.islandExpanded) {
      els.islandExpanded.setAttribute(
        'aria-hidden',
        String(!expanded)
      );
    }

    syncExpandedToMain(expanded);
  }

  function bindIslandInteractions() {
    if (!els.island) return;

    els.island.addEventListener('mouseenter', () => {
      if (state.hovered) return;

      state.hovered = true;
      applyExpandedState();
    });

    els.island.addEventListener('mouseleave', () => {
      if (!state.hovered) return;

      state.hovered = false;
      applyExpandedState();
    });

    els.island.addEventListener('focusin', () => {
      if (state.focused) return;

      state.focused = true;
      applyExpandedState();
    });

    els.island.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;

      if (next && els.island.contains(next)) return;
      if (!state.focused) return;

      state.focused = false;
      applyExpandedState();
    });
  }

  // ======================================================================
  // 11. WORKSPACE NAVIGATION
  // ======================================================================

  function showWorkspaceSection(sectionName, focusChat = false) {
    if (!WORKSPACE_SECTIONS.includes(sectionName)) {
      return;
    }

    state.workspaceSection = sectionName;

    document.querySelectorAll('[data-section]').forEach(
      (section) => {
        const isActive =
          section.dataset.section === sectionName;

        section.hidden = !isActive;

        section.classList.toggle(
          'is-active',
          isActive
        );

        section.setAttribute(
          'aria-hidden',
          String(!isActive)
        );
      }
    );

    document.querySelectorAll('[data-nav-section]').forEach(
      (button) => {
        const isActive =
          button.dataset.navSection === sectionName;

        button.classList.toggle(
          'is-active',
          isActive
        );

        if (isActive) {
          button.setAttribute('aria-current', 'page');
        } else {
          button.removeAttribute('aria-current');
        }
      }
    );

    if (
      focusChat &&
      sectionName === 'chat' &&
      els.chatInput
    ) {
      window.setTimeout(() => {
        if (!document.hidden && !els.chatInput.disabled) {
          els.chatInput.focus();
        }
      }, 120);
    }
  }

  function bindWorkspaceNavigation() {
    document.querySelectorAll('[data-nav-section]').forEach(
      (button) => {
        button.addEventListener('click', () => {
          const section = button.dataset.navSection;

          showWorkspaceSection(
            section,
            section === 'chat'
          );
        });
      }
    );

    document.querySelectorAll('[data-open-section]').forEach(
      (button) => {
        button.addEventListener('click', () => {
          const section = button.dataset.openSection;

          showWorkspaceSection(
            section,
            section === 'chat'
          );
        });
      }
    );

    showWorkspaceSection('home');
  }

  // ======================================================================
  // 12. MICROPHONE BUTTON — VISUAL ONLY
  // ======================================================================

  function bindMicButton() {
    if (!els.micButton) return;

    els.micButton.addEventListener('click', () => {
      // Real voice recording has not been implemented.
      // Never pretend that the microphone is listening.
      showWorkspaceSection('voice');
    });
  }

  // ======================================================================
  // 13. MULTI-MODEL STREAMING CHAT
  // ======================================================================

  const CHAT_ERROR_MESSAGES = Object.freeze({
    missing_api_key:
      'No Gemini API key was found. Check GEMINI_API_KEY in your .env file.',

    missing_api_key:
      'No Gemini API key was found. Check GEMINI_API_KEY in your .env file.',

    configuration:
      'The API configuration could not be loaded. Check your .env file.',

    rate_limit:
      'The Gemini API is receiving too many requests. Please try again shortly.',

    authentication:
      'The Gemini API key was rejected. Check GEMINI_API_KEY in your .env file.',

    network:
      'Could not reach the Gemini API. Check your internet connection.',

    invalid_message:
      'Please enter a message of up to 4000 characters.',

    unavailable:
      'The AI service is currently unavailable. Please try again.',

    api_error:
      'The AI could not complete that request. Please try again.',

    busy:
      'Please wait for the current response to finish.',

    timeout:
      'Gemini took too long to respond. Please try again.',
  });

  function appendChatMessage(role, text, isError = false) {
    if (!els.chatMessages) return null;

    const message = document.createElement('p');

    message.className =
      `chat__message chat__message--${role}`;

    if (isError) {
      message.classList.add('chat__message--error');
    }

    message.textContent = text;

    els.chatMessages.appendChild(message);

    els.chatMessages.scrollTop =
      els.chatMessages.scrollHeight;

    return message;
  }

  function setChatPending(pending) {
    chatPending = pending;

    if (els.chatSend) {
      els.chatSend.disabled = pending;
    }

    if (els.chatInput) {
      els.chatInput.disabled = pending;
    }

    if (els.chatThinking) {
      els.chatThinking.hidden = !pending;

      if (pending) {
        els.chatThinking.textContent = 'Connecting to AI…';
      }
    }
  }

  function setChatStatus(message) {
    if (!els.chatThinking) return;

    els.chatThinking.textContent = message;
    els.chatThinking.hidden = false;
  }

  function appendStreamingText(text) {
    if (
      !activeChatBubble ||
      typeof text !== 'string' ||
      !text
    ) {
      return;
    }

    activeChatBubble.textContent += text;

    if (els.chatMessages) {
      els.chatMessages.scrollTop =
        els.chatMessages.scrollHeight;
    }
  }

  function finishChatRequest() {
    activeChatRequestId = null;
    activeChatBubble = null;
    chatRequestStarting = false;
    earlyAIEvents = [];

    setChatPending(false);
  }

  function showChatError(errorCode) {
    const message =
      CHAT_ERROR_MESSAGES[errorCode] ||
      CHAT_ERROR_MESSAGES.api_error;

    appendChatMessage('assistant', message, true);

    setAssistantState('error');
  }

  function handleAIEvent(payload) {
    if (!payload || typeof payload !== 'object') return;

    // The IPC event may arrive before askGemini() returns its request ID.
    if (!activeChatRequestId) {
      if (chatRequestStarting) {
        earlyAIEvents.push(payload);
      }

      return;
    }

    if (payload.requestId !== activeChatRequestId) {
      return;
    }

    switch (payload.type) {
      case 'started': {
        setChatStatus('Connecting to AI providers…');
        break;
      }

      case 'winner': {
        const provider =
          typeof payload.provider === 'string'
            ? payload.provider
            : 'AI';

        const model =
          typeof payload.model === 'string'
            ? payload.model
            : '';

        setChatStatus(
          model
            ? `Responding with ${provider} · ${model}`
            : `Responding with ${provider}…`
        );

        break;
      }

      case 'chunk': {
        const chunk =
          typeof payload.text === 'string'
            ? payload.text
            : '';

        if (chunk) {
          appendStreamingText(chunk);
        }

        break;
      }

      case 'complete': {
        if (payload.ok === true) {
          // Safety fallback in case a provider returned a final
          // response without sending visible chunks.
          if (
            activeChatBubble &&
            !activeChatBubble.textContent &&
            typeof payload.text === 'string'
          ) {
            activeChatBubble.textContent = payload.text;
          }

          if (
            !activeChatBubble ||
            !activeChatBubble.textContent.trim()
          ) {
            showChatError('api_error');
            finishChatRequest();
            return;
          }

          setAssistantState('speaking');
          finishChatRequest();

          timers.expressionReset = window.setTimeout(() => {
            timers.expressionReset = null;

            if (state.assistant === 'speaking') {
              setAssistantState('idle');
            }
          }, 2200);

        } else if (payload.cancelled === true) {
          finishChatRequest();
          setAssistantState('idle');

        } else {
          showChatError(
            typeof payload.error === 'string'
              ? payload.error
              : 'api_error'
          );

          finishChatRequest();
        }

        break;
      }

      case 'error': {
        showChatError(
          typeof payload.error === 'string'
            ? payload.error
            : 'api_error'
        );

        finishChatRequest();
        break;
      }

      default:
        break;
    }
  }

  function bindAIEvents() {
    const api = getBridge();

    if (!api || typeof api.onAIEvent !== 'function') {
      return false;
    }

    try {
      const unsubscribe = api.onAIEvent(handleAIEvent);

      if (typeof unsubscribe === 'function') {
        aiEventUnsubscribe = unsubscribe;
      }

      return true;

    } catch {
      aiEventUnsubscribe = null;
      return false;
    }
  }

  async function handleChatSubmit(event) {
    event.preventDefault();

    if (chatPending || !els.chatInput) return;

    const text = els.chatInput.value.trim();

    if (!text) {
      els.chatInput.focus();
      return;
    }

    if (text.length > MAX_CHAT_LENGTH) {
      showChatError('invalid_message');
      return;
    }

    const api = getBridge();

    if (
      !api ||
      typeof api.askGemini !== 'function' ||
      typeof api.onAIEvent !== 'function'
    ) {
      showChatError('unavailable');
      return;
    }

    // Register the listener before making the request.
    // This prevents us from missing the first streaming event.
    if (!aiEventUnsubscribe && !bindAIEvents()) {
      showChatError('unavailable');
      return;
    }

    appendChatMessage('user', text);

    els.chatInput.value = '';

    activeChatBubble = appendChatMessage(
      'assistant',
      ''
    );

    activeChatRequestId = null;
    earlyAIEvents = [];
    chatRequestStarting = true;

    setChatPending(true);
    setAssistantState('thinking');

    try {
      const result = await api.askGemini(text);

      chatRequestStarting = false;

      if (
        !result ||
        typeof result !== 'object' ||
        result.ok !== true ||
        typeof result.requestId !== 'string'
      ) {
        showChatError(
          result && typeof result.error === 'string'
            ? result.error
            : 'api_error'
        );

        finishChatRequest();
        return;
      }

      activeChatRequestId = result.requestId;

      // Process any events that arrived before the request ID
      // was returned by the main process.
      const bufferedEvents = earlyAIEvents;
      earlyAIEvents = [];

      for (const payload of bufferedEvents) {
        if (
          !activeChatRequestId ||
          payload.requestId !== activeChatRequestId
        ) {
          continue;
        }

        handleAIEvent(payload);

        // A completion/error event ends this request.
        if (!activeChatRequestId) {
          break;
        }
      }

    } catch {
      showChatError('unavailable');
      finishChatRequest();
    }
  }

  function bindChat() {
    if (!els.chatForm) return;

    els.chatForm.addEventListener(
      'submit',
      handleChatSubmit
    );
  }

  // ======================================================================
  // 14. IDLE PERSONALITY
  // ======================================================================

  function schedulePersonalityTick() {
    clearTimer('personality');

    if (reducedMotion || document.hidden) return;

    const delay =
      PERSONALITY_MIN_MS +
      Math.random() *
        (PERSONALITY_MAX_MS - PERSONALITY_MIN_MS);

    timers.personality = window.setTimeout(
      runPersonalityTick,
      delay
    );
  }

  function runPersonalityTick() {
    timers.personality = null;

    const canFlicker =
      state.assistant === 'idle' &&
      !state.hovered &&
      !state.focused &&
      !document.hidden;

    if (canFlicker) {
      const expression =
        IDLE_EXPRESSIONS[
          Math.floor(
            Math.random() * IDLE_EXPRESSIONS.length
          )
        ];

      setExpression(expression);

      clearPersonalityReset();

      timers.personalityReset = window.setTimeout(() => {
        timers.personalityReset = null;

        if (state.assistant === 'idle') {
          setExpression(STATE_CONFIG.idle.expression);
        }
      }, PERSONALITY_DURATION_MS);
    }

    schedulePersonalityTick();
  }

  // ======================================================================
  // 15. VISIBILITY HANDLING
  // ======================================================================

  function handleVisibilityChange() {
    if (document.hidden) {
      setLook(0, 0);

      clearTimer('clock');
      clearTimer('blink');
      clearTimer('blinkFollowup');
      clearTimer('personality');
      clearPersonalityReset();

      return;
    }

    scheduleClockTick();
    scheduleBlink();
    schedulePersonalityTick();
  }

  // ======================================================================
  // 16. CLEANUP
  // ======================================================================

  function cleanup() {
    if (typeof cursorUnsubscribe === 'function') {
      cursorUnsubscribe();
      cursorUnsubscribe = null;
    }

    if (typeof aiEventUnsubscribe === 'function') {
      aiEventUnsubscribe();
      aiEventUnsubscribe = null;
    }

    Object.keys(timers).forEach(clearTimer);
  }

  // ======================================================================
  // 17. INITIALIZATION
  // ======================================================================

  function init() {
    if (initialized) return;

    initialized = true;

    reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    cacheElements();

    bindIslandInteractions();
    bindWorkspaceNavigation();
    bindMicButton();
    bindChat();
    bindMouseTracking();

    scheduleClockTick();

    setAssistantState('idle');

    scheduleBlink();
    schedulePersonalityTick();

    applyExpandedState();

    document.addEventListener(
      'visibilitychange',
      handleVisibilityChange
    );

    window.addEventListener(
      'beforeunload',
      cleanup,
      { once: true }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      init,
      { once: true }
    );
  } else {
    init();
  }
})();
