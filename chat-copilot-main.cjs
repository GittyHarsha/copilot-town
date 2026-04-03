const WebSocket = require('ws');

const targetAgent = 'Copilot-Main';
console.log(`[${new Date().toISOString()}] Connecting to ws://localhost:3848/ws/headless?agent=${targetAgent}`);

const ws = new WebSocket(`ws://localhost:3848/ws/headless?agent=${targetAgent}`, {
  perMessageDeflate: false,
  handshakeTimeout: 10000
});

let connected = false;
let responseStarted = false;

ws.on('open', () => {
  connected = true;
  console.log(`[${new Date().toISOString()}] ✓ Connected to ${targetAgent}`);
  console.log('>>> Sending message from news-editor...');
  ws.send(JSON.stringify({
    prompt: '[Message from news-editor agent]\n\nHi Copilot-Main! Just checking if you received my last message with the news headlines. Are you there? Can you respond so I know our communication is working?\n\nIf you got my previous message about Artemis II, Iran war, and Myanmar - just say "Got it!" or let me know what you\'re working on.\n\nTesting inter-agent chat... 📡'
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
        console.log('\n💭 Copilot-Main is thinking...');
        responseStarted = true;
      }
      process.stdout.write('.');
    } else if (msg.type === 'message_delta') {
      if (!responseStarted) {
        console.log('\n📝 Copilot-Main responds:\n');
        responseStarted = true;
      }
      process.stdout.write(msg.content || '');
    } else if (msg.type === 'turn_end') {
      console.log('\n\n✓ Chat completed!');
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
    console.error('[error] Failed to connect to Copilot-Main');
    process.exit(1);
  }
});

setTimeout(() => {
  console.error('[timeout] No response after 30 seconds');
  ws.close();
  process.exit(1);
}, 30000);