package federation

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/relay-chat/relay/internal/config"
	"github.com/relay-chat/relay/internal/db"
)

// FedMessage is the envelope for all S2S WebSocket messages.
type FedMessage struct {
	Type    string          `json:"type"`
	Origin  string          `json:"origin"`
	Payload json.RawMessage `json:"payload"`
}

// Peer represents a connected (or connecting) federated peer.
type Peer struct {
	Name string
	URL  string

	conn   *websocket.Conn
	send   chan []byte
	mu     sync.Mutex
	closed bool
}

// Hub manages all federation peer connections.
type Hub struct {
	cfg      *config.Config
	database *db.DB

	peers map[string]*Peer // URL -> Peer
	mu    sync.RWMutex

	// Handler is set by the caller to process incoming federated messages.
	Handler func(origin string, msg FedMessage)
}

func NewHub(cfg *config.Config, database *db.DB) *Hub {
	return &Hub{
		cfg:      cfg,
		database: database,
		peers:    make(map[string]*Peer),
	}
}

// Start dials all configured peers in the background.
func (h *Hub) Start() {
	if !h.cfg.Federation.Enabled {
		return
	}
	log.Printf("[federation] Starting federation hub (instance: %s)", h.cfg.Federation.InstanceURL)
	for _, p := range h.cfg.Federation.Peers {
		go h.dialPeer(p)
	}
}

// dialPeer connects to a peer and reconnects on failure.
func (h *Hub) dialPeer(peerCfg config.FederationPeer) {
	for {
		h.connectPeer(peerCfg)
		log.Printf("[federation] Connection to %s lost, reconnecting in 5s...", peerCfg.URL)
		time.Sleep(5 * time.Second)
	}
}

func (h *Hub) connectPeer(peerCfg config.FederationPeer) {
	wsURL := toWSURL(peerCfg.URL) + "/api/federation/ws"

	header := http.Header{}
	header.Set("X-Federation-Token", peerCfg.Token)
	header.Set("X-Federation-Origin", h.cfg.Federation.InstanceURL)

	log.Printf("[federation] Dialing peer %s (%s)", peerCfg.Name, wsURL)

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		log.Printf("[federation] Failed to connect to %s: %v", peerCfg.Name, err)
		return
	}

	peer := &Peer{
		Name: peerCfg.Name,
		URL:  peerCfg.URL,
		conn: conn,
		send: make(chan []byte, 256),
	}

	h.mu.Lock()
	h.peers[peerCfg.URL] = peer
	h.mu.Unlock()

	log.Printf("[federation] Connected to peer %s", peerCfg.Name)

	done := make(chan struct{})
	go peer.writePump(done)
	peer.readPump(h, done)

	h.mu.Lock()
	delete(h.peers, peerCfg.URL)
	h.mu.Unlock()
}

// AcceptPeer handles an incoming federation WebSocket connection.
func (h *Hub) AcceptPeer(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("X-Federation-Token")
	origin := r.Header.Get("X-Federation-Origin")

	if token == "" || origin == "" {
		http.Error(w, "missing federation headers", http.StatusUnauthorized)
		return
	}

	if token != h.cfg.Federation.Token {
		http.Error(w, "invalid federation token", http.StatusForbidden)
		return
	}

	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     func(r *http.Request) bool { return true },
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[federation] Failed to upgrade incoming connection from %s: %v", origin, err)
		return
	}

	peer := &Peer{
		Name: origin,
		URL:  origin,
		conn: conn,
		send: make(chan []byte, 256),
	}

	h.mu.Lock()
	// If we already have an outgoing connection to this peer, keep both—
	// use origin URL as distinct key for incoming connections.
	key := "in:" + origin
	h.peers[key] = peer
	h.mu.Unlock()

	log.Printf("[federation] Accepted incoming connection from %s", origin)

	done := make(chan struct{})
	go peer.writePump(done)
	peer.readPump(h, done)

	h.mu.Lock()
	delete(h.peers, key)
	h.mu.Unlock()

	log.Printf("[federation] Incoming connection from %s closed", origin)
}

// Send sends a message to a specific peer by URL.
func (h *Hub) Send(peerURL string, msg FedMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	// Try outgoing connection first, then incoming
	if peer, ok := h.peers[peerURL]; ok {
		peer.safeSend(data)
		return
	}
	if peer, ok := h.peers["in:"+peerURL]; ok {
		peer.safeSend(data)
	}
}

// Broadcast sends a message to all connected peers.
func (h *Hub) Broadcast(msg FedMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, peer := range h.peers {
		peer.safeSend(data)
	}
}

// SendToServersOnPeer sends a message only to peers that have federated members on the given server.
// For federated mirror servers, it sends to the origin instance instead.
func (h *Hub) SendToServersOnPeer(serverID string, msg FedMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	// Check if this is a federated mirror — if so, send to the origin instance
	server, sErr := h.database.GetServer(serverID)
	if sErr == nil && server.Federated && server.InstanceURL != "" {
		h.mu.RLock()
		defer h.mu.RUnlock()
		// Try outgoing connection first, then incoming
		if peer, ok := h.peers[server.InstanceURL]; ok {
			peer.safeSend(data)
			return
		}
		if peer, ok := h.peers["in:"+server.InstanceURL]; ok {
			peer.safeSend(data)
		}
		return
	}

	// For origin servers, find which peers have federated members
	members, err := h.database.GetFederatedMembers(serverID)
	if err != nil || len(members) == 0 {
		return
	}

	origins := make(map[string]bool)
	for _, m := range members {
		origins[m.OriginURL] = true
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	sent := make(map[string]bool)
	for _, peer := range h.peers {
		if origins[peer.URL] && !sent[peer.URL] {
			peer.safeSend(data)
			sent[peer.URL] = true
		}
	}
}

func (p *Peer) safeSend(data []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	select {
	case p.send <- data:
	default:
		// Drop if buffer full
	}
}

func (p *Peer) readPump(h *Hub, done chan struct{}) {
	defer func() {
		close(done)
		p.conn.Close()
		p.mu.Lock()
		p.closed = true
		close(p.send)
		p.mu.Unlock()
	}()

	p.conn.SetReadLimit(1 << 20) // 1MB
	p.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	p.conn.SetPongHandler(func(string) error {
		p.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	for {
		_, message, err := p.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[federation] Read error from %s: %v", p.Name, err)
			}
			return
		}

		var msg FedMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("[federation] Invalid message from %s: %v", p.Name, err)
			continue
		}

		if msg.Origin == "" {
			msg.Origin = p.URL
		}

		if h.Handler != nil {
			h.Handler(p.URL, msg)
		}
	}
}

func (p *Peer) writePump(done chan struct{}) {
	ticker := time.NewTicker(45 * time.Second)
	defer func() {
		ticker.Stop()
		p.conn.Close()
	}()

	for {
		select {
		case message, ok := <-p.send:
			p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				p.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := p.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := p.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}

// toWSURL converts an HTTP(S) URL to WS(S).
func toWSURL(httpURL string) string {
	if len(httpURL) > 5 && httpURL[:5] == "https" {
		return "wss" + httpURL[5:]
	}
	if len(httpURL) > 4 && httpURL[:4] == "http" {
		return "ws" + httpURL[4:]
	}
	return httpURL
}
