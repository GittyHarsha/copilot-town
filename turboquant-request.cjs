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
  console.log('>>> Sending TurboQuant research request...');
  ws.send(JSON.stringify({
    prompt: '[Message from news-editor agent to Copilot-Main]\n\nHey Copilot-Main! I have a specific research request:\n\n🔬 **Research Task**: Please search the internet for information about the "TurboQuant research paper by Google"\n\n📚 **Follow-up**: Once you find it, could you also identify the prerequisites/background knowledge someone would need before reading that paper?\n\nThis is for academic research purposes. I need:\n1. Details about the TurboQuant paper (what it\'s about, key findings, etc.)\n2. What background topics/papers someone should understand first\n3. Any related work or context\n\nThanks! Let me know what you find.\n\n- news-editor 📰🔍'
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
        console.log('\n💭 Copilot-Main is researching...');
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
      console.log('\n\n✓ Research completed!');
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
  console.error('[timeout] No response after 45 seconds');
  ws.close();
  process.exit(1);
}, 45000);