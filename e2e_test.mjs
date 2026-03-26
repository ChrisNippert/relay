import https from 'https';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {'Content-Type': 'application/json'};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = https.request({hostname:'localhost',port:8080,path,method,headers}, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({status: res.statusCode, data: JSON.parse(b)}); }
        catch { resolve({status: res.statusCode, data: b}); }
      });
    });
    r.on('error', reject);
    r.setTimeout(5000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  // Register a test user
  let res = await req('POST', '/api/auth/register', {username:'chattest', email:'chattest@test.com', password:'password123'});
  console.log('Register:', res.status, JSON.stringify(res.data).substring(0, 200));
  
  // Login
  res = await req('POST', '/api/auth/login', {email:'chattest@test.com', password:'password123'});
  console.log('Login:', res.status);
  const token = res.data.token;
  if (!token) { console.log('No token'); return; }
  const userId = res.data.user && res.data.user.id;
  console.log('User ID:', userId);
  
  // Get servers
  res = await req('GET', '/api/servers', null, token);
  console.log('Servers:', res.status, JSON.stringify(res.data).substring(0, 300));
  
  // Create a server if none exist
  if (!res.data || res.data.length === 0) {
    res = await req('POST', '/api/servers', {name: 'Test Server'}, token);
    console.log('Created server:', res.status, JSON.stringify(res.data).substring(0, 200));
  }
  const server = Array.isArray(res.data) ? res.data[0] : res.data;
  console.log('Using server:', server && server.id, server && server.name);
  
  // Get channels
  res = await req('GET', '/api/servers/' + server.id + '/channels', null, token);
  console.log('Channels:', res.status, JSON.stringify(res.data).substring(0, 500));
  
  const textChannel = res.data && res.data.find(ch => ch.type === 'text');
  if (!textChannel) { console.log('No text channel found'); return; }
  console.log('Text channel:', textChannel.id, textChannel.name, 'type:', textChannel.type);
  
  // Get messages from that channel
  res = await req('GET', '/api/channels/' + textChannel.id + '/messages', null, token);
  console.log('Messages count:', Array.isArray(res.data) ? res.data.length : 'ERROR', typeof res.data);
  if (Array.isArray(res.data) && res.data.length > 0) {
    console.log('Last message:', JSON.stringify(res.data[0]).substring(0, 200));
  }
  
  // Now test WebSocket: connect and send a message
  const ws = new WebSocket('wss://localhost:8080/ws?token=' + encodeURIComponent(token));
  
  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      console.log('WS connected');
      resolve();
    };
    ws.onerror = (e) => {
      console.log('WS error:', e);
      reject(e);
    };
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
  
  // Listen for messages
  const received = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    console.log('WS received:', msg.type, JSON.stringify(msg.payload).substring(0, 200));
    received.push(msg);
  };
  
  // Send a chat message
  const chatMsg = {
    type: 'chat_message',
    payload: {
      channel_id: textChannel.id,
      content: 'Hello from e2e test ' + Date.now(),
      type: 'text'
    }
  };
  console.log('Sending:', JSON.stringify(chatMsg));
  ws.send(JSON.stringify(chatMsg));
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log('Total WS messages received:', received.length);
  const chatMessages = received.filter(m => m.type === 'chat_message');
  console.log('Chat messages received:', chatMessages.length);
  if (chatMessages.length > 0) {
    console.log('Chat message payload:', JSON.stringify(chatMessages[0].payload).substring(0, 300));
  }
  
  // Now check messages via REST to confirm it was saved
  res = await req('GET', '/api/channels/' + textChannel.id + '/messages?limit=5', null, token);
  console.log('Messages after send:', Array.isArray(res.data) ? res.data.length : 'ERROR');
  if (Array.isArray(res.data) && res.data.length > 0) {
    console.log('Latest message:', JSON.stringify(res.data[0]).substring(0, 300));
  }
  
  ws.close();
  console.log('Done');
}

main().catch(e => console.error('Error:', e.message));
