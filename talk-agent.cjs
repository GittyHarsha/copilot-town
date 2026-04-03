const WebSocket = require('ws');

const agent = 'news-editor';
console.log(`[${new Date().toISOString()}] Connecting to ws://localhost:3848/ws/headless?agent=${agent}`);

const ws = new WebSocket(`ws://localhost:3848/ws/headless?agent=${agent}`, {
  perMessageDeflate: false,
  handshakeTimeout: 10000
});

let connected = false;
let responseStarted = false;

ws.on('open', () => {
  connected = true;
  console.log(`[${new Date().toISOString()}] ✓ Connected to ${agent}`);
  console.log('>>> Sending: "What is the latest news today?"');
  ws.send(JSON.stringify({
    prompt: 'What is the latest news today? Give me the top 3 headlines.'
  }));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data);
    
    if (msg.type === 'status_sync') {
      console.log(`[status] ${msg.agentStatus}`);
    } else if (msg.type === 'system') {
      console.log(`[system] ${msg.message}`);
    } else if (msg.type === 'reasoning_delta') {
      if (!responseStarted) {
        console.log('\n💭 Thinking...');
        responseStarted = true;
      }
      process.stdout.write('.');
    } else if (msg.type === 'message_delta') {
      if (!responseStarted) {
        console.log('\n📝 Response:\n');
        responseStarted = true;
      }
      process.stdout.write(msg.content || '');
    } else if (msg.type === 'turn_end') {
      console.log('\n\n✓ Conversation ended');
      setTimeout(() => { ws.close(); process.exit(0); }, 100);
    } else if (msg.type === 'error') {
      console.error(`\n[error] ${msg.message}`);
      setTimeout(() => { ws.close(); process.exit(1); }, 100);
    }
  } catch (e) {
    console.error('Parse error:', e.message, 'data:', data.toString().slice(0, 100));
  }
});

ws.on('error', (err) => {
  console.error(`[error] WebSocket error: ${err.message}`);
  process.exit(1);
});

ws.on('close', () => {
  if (!connected) {
    console.error('[error] Failed to connect to server');
    process.exit(1);
  }
});

setTimeout(() => {
  console.error('[timeout] No response after 45 seconds');
  ws.close();
  process.exit(1);
}, 45000);
