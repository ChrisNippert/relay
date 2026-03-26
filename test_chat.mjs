import https from 'https';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';


const agent = new https.Agent({rejectUnauthorized: false});

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {'Content-Type': 'application/json'};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request('https://localhost:8080' + path, {method, headers, agent}, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({status: res.statusCode, body: JSON.parse(d)}) }
        catch(e) { resolve({status: res.statusCode, body: d}) }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // Try to register or login
  let r = await request('POST', '/api/auth/register', {
    username: 'chattest',
    email: 'chattest@test.com',
    password: 'chattest123',
    display_name: 'ChatTest'
  });
  console.log('Register:', r.status, typeof r.body === 'object' ? '' : r.body);

  if (r.status !== 200 && r.status !== 201) {
    r = await request('POST', '/api/auth/login', {
      email: 'chattest@test.com',
      password: 'chattest123'
    });
    console.log('Login:', r.status);
  }

  const token = r.body?.token;
  if (!token) { console.log('No token:', JSON.stringify(r)); return; }
  console.log('Auth OK, user:', r.body.user?.username);

  // Create a server to get a channel
  let sr = await request('POST', '/api/servers', {name: 'testserver'}, token);
  console.log('Create server:', sr.status);
  
  // Get channels
  const serverId = sr.body?.id;
  if (!serverId) { console.log('No server id:', JSON.stringify(sr)); return; }
  
  let ch = await request('GET', '/api/servers/' + serverId + '/channels', null, token);
  console.log('Channels:', ch.status, Array.isArray(ch.body) ? ch.body.map(c => c.name + '(' + c.type + ')').join(', ') : ch.body);
  
  const textChannel = Array.isArray(ch.body) ? ch.body.find(c => c.type === 'text') : null;
  if (!textChannel) { console.log('No text channel'); return; }
  console.log('Using channel:', textChannel.id, textChannel.name);

  // Test REST API - get messages
  const msgs = await request('GET', '/api/channels/' + textChannel.id + '/messages', null, token);
  console.log('GET messages:', msgs.status, Array.isArray(msgs.body) ? msgs.body.length + ' messages' : msgs.body);

  // Connect WebSocket (native Node.js 22+)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const ws = new WebSocket('wss://localhost:8080/ws?token=' + token);
  
  ws.addEventListener('open', () => {
    console.log('WS connected');
    ws.send(JSON.stringify({
      type: 'chat_message',
      payload: {channel_id: textChannel.id, content: 'test from script', type: 'text'}
    }));
    console.log('Chat message sent via WS');
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'chat_message') {
      console.log('WS received chat_message:', JSON.stringify(msg.payload).substring(0, 150));
      console.log('SUCCESS - full round trip works');
      ws.close();
      process.exit(0);
    } else {
      console.log('WS received:', msg.type);
    }
  });

  ws.addEventListener('error', (ev) => console.error('WS error:', ev.message || ev));
  ws.addEventListener('close', () => console.log('WS closed'));

  setTimeout(() => {
    console.log('TIMEOUT - no chat_message received back');
    ws.close();
    process.exit(1);
  }, 5000);
}

main().catch(e => console.error('Fatal:', e));
