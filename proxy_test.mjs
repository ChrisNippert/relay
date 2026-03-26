import https from 'https';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function req(method, path, body, token, port = 8080) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {'Content-Type': 'application/json'};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = https.request({hostname:'localhost',port,path,method,headers}, res => {
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
  // Login through Vite proxy (port 5173)
  console.log('=== Testing through Vite proxy (port 5173) ===');
  let res = await req('POST', '/api/auth/login', {email:'chattest@test.com', password:'password123'}, null, 5173);
  console.log('Login via proxy:', res.status);
  const token = res.data.token;
  if (!token) { console.log('No token'); return; }
  
  // Get messages through Vite proxy
  res = await req('GET', '/api/servers', null, token, 5173);
  const server = res.data[0];
  res = await req('GET', '/api/servers/' + server.id + '/channels', null, token, 5173);
  const textChannel = res.data.find(ch => ch.type === 'text');
  console.log('Channel:', textChannel.id);
  
  res = await req('GET', '/api/channels/' + textChannel.id + '/messages?limit=5', null, token, 5173);
  console.log('Messages via proxy:', Array.isArray(res.data) ? res.data.length : 'ERROR');
  
  // Test WebSocket through Vite proxy
  console.log('Connecting WS through Vite proxy...');
  const ws = new WebSocket('wss://localhost:5173/api/ws?token=' + encodeURIComponent(token));
  
  const connectResult = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log('WS TIMEOUT - proxy may not be forwarding WebSocket');
      resolve('timeout');
    }, 5000);
    
    ws.onopen = () => {
      clearTimeout(timeout);
      console.log('WS connected through proxy');
      resolve('connected');
    };
    ws.onerror = (e) => {
      clearTimeout(timeout);
      console.log('WS ERROR through proxy:', e.type || e);
      resolve('error');
    };
    ws.onclose = (e) => {
      console.log('WS CLOSED:', e.code, e.reason);
    };
  });
  
  if (connectResult !== 'connected') {
    console.log('WebSocket through Vite proxy FAILED');
    
    // Test direct WS connection to backend
    console.log('Testing direct WS to backend (port 8080)...');
    const ws2 = new WebSocket('wss://localhost:8080/api/ws?token=' + encodeURIComponent(token));
    await new Promise((resolve) => {
      const timeout = setTimeout(() => { console.log('Direct WS also TIMEOUT'); resolve(); }, 5000);
      ws2.onopen = () => { clearTimeout(timeout); console.log('Direct WS works'); ws2.close(); resolve(); };
      ws2.onerror = () => { clearTimeout(timeout); console.log('Direct WS also ERROR'); resolve(); };
    });
    return;
  }
  
  // If connected, test sending a message
  const received = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    console.log('WS received:', msg.type);
    received.push(msg);
  };
  
  ws.send(JSON.stringify({
    type: 'chat_message',
    payload: { channel_id: textChannel.id, content: 'Proxy test ' + Date.now(), type: 'text' }
  }));
  
  await new Promise(r => setTimeout(r, 2000));
  console.log('Messages received via proxy WS:', received.length);
  console.log('Chat messages:', received.filter(m => m.type === 'chat_message').length);
  
  ws.close();
  console.log('Done');
}

main().catch(e => console.error('Error:', e.message));
