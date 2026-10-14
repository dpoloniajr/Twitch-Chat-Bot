/**
 * Chat Box Overlay
 * Displays live chat messages in a scrolling overlay
 *
 * Usage: Add as Browser Source in OBS
 * URL: http://localhost:3001/obs/overlays/chat-box.html
 * Recommended size: 400x300 or custom based on your scene
 *
 * URL Parameters:
 *   ?limit=15        - Maximum number of messages to display (default: 15)
 *   ?timeout=8000    - Time before message fades out (ms, default: 8000)
 *   ?hideBot=true    - Hide bot messages (default: false)
 *   ?hideCommands=true - Hide command messages starting with ! (default: false)
 *   ?colorByRole=true - Color messages by user role (broadcaster, mod, etc.)
 */
(function() {
  'use strict';

  /** Section of GET /obs/config read by this overlay. */
  interface ChatBoxObsConfig {
    overlays: {
      chatBox: {
        messageTimeout?: number; // seconds
        hideBot?: boolean;
      };
    };
  }

  /** Payload of the `chat` WebSocket message. */
  interface ChatMessage {
    username?: string;
    user?: string;
    message?: string;
    role?: string;
    isBroadcaster?: boolean;
    timestamp?: string;
  }

  type ChatBoxWindow = Window & {
    chatMessages?: ChatMessage[];
    client?: OverlayClient;
    testMessage?: (username?: string, message?: string) => void;
  };

  const chatMessages = document.getElementById('chat-messages')!;

  // Configuration - loaded from dashboard /obs/config endpoint
  let config = {
    maxMessages: 15,
    messageTimeout: 8000,
    hideBot: false,
    hideCommands: false,
    colorByRole: false
  };

  // Store messages
  let messages: ChatMessage[] = [];
  // Fade-out timer of each displayed message, keyed by the message object itself
  // (timestamp + username is not unique, so it cannot identify a message)
  let messageTimeouts = new Map<ChatMessage, ReturnType<typeof setTimeout>>();

  // Load configuration from dashboard
  async function loadConfig(): Promise<void> {
    try {
      const res = await fetch('/obs/config');
      const obsConfig = await res.json() as ChatBoxObsConfig;
      const chatBoxConfig = obsConfig.overlays.chatBox;

      // Apply dashboard configuration
      config.maxMessages = 15;
      config.messageTimeout = (chatBoxConfig.messageTimeout || 8) * 1000;
      config.hideBot = chatBoxConfig.hideBot === true;
      config.hideCommands = false;
      config.colorByRole = false;

      // Allow URL parameters to override dashboard config
      const paramLimit = parseInt(OverlayUtils.getQueryParam('limit') as string);
      if (!isNaN(paramLimit)) config.maxMessages = paramLimit;
      const paramTimeout = parseInt(OverlayUtils.getQueryParam('timeout') as string);
      if (!isNaN(paramTimeout)) config.messageTimeout = paramTimeout;
      if (OverlayUtils.getQueryParam('hideBot') !== null) config.hideBot = OverlayUtils.getQueryParam('hideBot') === 'true';
      if (OverlayUtils.getQueryParam('hideCommands') !== null) config.hideCommands = OverlayUtils.getQueryParam('hideCommands') === 'true';
      if (OverlayUtils.getQueryParam('colorByRole') !== null) config.colorByRole = OverlayUtils.getQueryParam('colorByRole') === 'true';
    } catch (error) {
      console.error('Failed to load OBS config, using defaults:', error);
    }

    // Initialize WebSocket client
    initializeClient();
  }

  function initializeClient(): void {
    const client = new OverlayClient();

    // Listen for chat messages
    client.on('chat', (data: ChatMessage) => {
      console.log('[ChatBoxOverlay] Received chat message:', data);
      addMessage(data);
    });

    client.on('connected', () => {
      console.log('[ChatBoxOverlay] WebSocket connected');
    });

    // Expose for debugging
    (window as ChatBoxWindow).chatMessages = messages;
    (window as ChatBoxWindow).client = client;

    console.log('[ChatBoxOverlay] Ready!');
  }

  /**
   * Get color for user role
   */
  function getRoleColor(role: string | undefined): string {
    const roleColors: Record<string, string> = {
      'broadcaster': '#ff1493',
      'moderator': '#1e90ff',
      'vip': '#daa520',
      'subscriber': '#00a86b'
    };
    return roleColors[role?.toLowerCase() as string] || '#9147ff';
  }

  /**
   * Build HTML for a single chat message
   */
  function buildMessageHtml(msg: ChatMessage): string {
    const username = OverlayUtils.escapeHtml(msg.username || msg.user || 'Unknown');
    const text = OverlayUtils.escapeHtml(msg.message || '');
    const color = config.colorByRole ? getRoleColor(msg.role) : '#9147ff';

    return `
          <div class="chat-message fadeInUp">
            <span class="chat-username" style="color: ${color}">${username}:</span>
            <span class="chat-text">${text}</span>
          </div>
        `;
  }

  /**
   * Add message to chat
   */
  function addMessage(msg: ChatMessage): void {
    // Filter out messages
    if (config.hideBot && msg.isBroadcaster && msg.user?.toLowerCase() === 'excella') {
      return;
    }
    if (config.hideCommands && msg.message?.startsWith('!')) {
      return;
    }

    // Add to list
    messages.push(msg);

    // Keep only maxMessages
    if (messages.length > config.maxMessages) {
      const removed = messages.shift()!;
      // Clear its fade-out timer: the message is already gone
      if (messageTimeouts.has(removed)) {
        clearTimeout(messageTimeouts.get(removed));
        messageTimeouts.delete(removed);
      }
    }

    renderMessages();

    // Set timeout to remove this message
    const timeout = setTimeout(() => {
      messageTimeouts.delete(msg);
      const index = messages.indexOf(msg);
      if (index > -1) {
        messages.splice(index, 1);
        renderMessages();
      }
    }, config.messageTimeout);

    messageTimeouts.set(msg, timeout);
  }

  /**
   * Render all messages
   */
  function renderMessages(): void {
    if (messages.length === 0) {
      chatMessages.innerHTML = '<div style="color: #666; padding: 10px; font-size: 12px;">Waiting for chat messages...</div>';
      return;
    }

    chatMessages.innerHTML = messages.map(msg => buildMessageHtml(msg)).join('');
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Load configuration from dashboard and initialize
  loadConfig();

  // Test function
  (window as ChatBoxWindow).testMessage = (username = 'TestUser', message = 'Hello chat!') => {
    addMessage({
      username,
      message,
      timestamp: new Date().toISOString()
    });
  };
})();
