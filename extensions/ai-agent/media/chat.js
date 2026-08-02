const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const modelInfo = document.getElementById('model-info');

let isStreaming = false;
let currentAssistantMsg = null;

// --- PostMessage handlers ---
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'response':
      handleResponse(msg.content, msg.partial);
      break;
    case 'error':
      handleError(msg.message);
      break;
    case 'status':
      handleStatus(msg);
      break;
    case 'thinking':
      handleThinking(msg.thinking);
      break;
  }
});

function handleResponse(content, partial) {
  if (partial && !currentAssistantMsg) {
    currentAssistantMsg = addMessage('assistant', content, true);
  } else if (partial && currentAssistantMsg) {
    currentAssistantMsg.innerHTML = '<div class="content">' + renderMarkdown(content) + '<span class="streaming-cursor"></span></div>';
  } else if (!partial) {
    if (currentAssistantMsg) {
      currentAssistantMsg.innerHTML = '<div class="content">' + renderMarkdown(content || currentAssistantMsg._fullText || '') + '</div>';
      currentAssistantMsg = null;
    }
    setStreaming(false);
  }
  scrollToBottom();
}

function handleError(message) {
  addMessage('error', message);
  setStreaming(false);
  scrollToBottom();
}

function handleStatus(msg) {
  if (msg.serverRunning) {
    statusIndicator.className = 'status-online';
    statusText.textContent = 'Ready';
  } else {
    statusIndicator.className = 'status-offline';
    statusText.textContent = 'Offline';
  }
  modelInfo.textContent = msg.provider ? `${msg.provider} / ${msg.model}` : '';
}

function handleThinking(thinking) {
  if (thinking) {
    addThinking();
  } else {
    removeThinking();
  }
}

// --- Send message ---
function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isStreaming) return;

  addMessage('user', text);
  inputEl.value = '';
  setStreaming(true);

  vscode.postMessage({ type: 'chat', message: text });
}

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

cancelBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'cancel' });
  setStreaming(false);
});

// --- UI helpers ---
function setStreaming(v) {
  isStreaming = v;
  sendBtn.style.display = v ? 'none' : '';
  cancelBtn.style.display = v ? '' : 'none';
  inputEl.disabled = v;
}

function addMessage(role, text, isStreaming_) {
  const div = document.createElement('div');
  div.className = `message message-${role}`;
  if (role === 'user') {
    const content = document.createElement('div');
    content.className = 'content';
    content.textContent = text;
    div.appendChild(content);
  } else {
    div.innerHTML = '<div class="content">' + renderMarkdown(text) + (isStreaming_ ? '<span class="streaming-cursor"></span>' : '') + '</div>';
    if (isStreaming_) div._fullText = text;
  }
  messagesEl.appendChild(div);
  return div;
}

function addThinking() {
  removeThinking();
  const div = document.createElement('div');
  div.className = 'thinking-indicator';
  div.id = 'thinking';
  div.innerHTML = '<span>AI is thinking</span><span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  messagesEl.appendChild(div);
}

function removeThinking() {
  const el = document.getElementById('thinking');
  if (el) el.remove();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// --- Minimal Markdown renderer ---
function renderMarkdown(text) {
  let html = text;
  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return '<pre><code>' + escapeHtml(code.trimEnd()) + '</code></pre>';
  });
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p>\s*<\/p>/g, '');
  return html;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Request initial status
vscode.postMessage({ type: 'info' });
