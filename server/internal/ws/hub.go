package ws

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/relay-chat/relay/internal/db"
)

// FederationRelay defines the callback interface for relaying messages to federated peers.
// This avoids an import cycle between ws and federation packages.
type FederationRelay interface {
	RelayMessage(serverID, channelID, messageID, content, nonce, msgType string, keyEpoch int, replyToID *string, authorID, username, displayName, avatarURL, nameColor, createdAt string)
	RelayEdit(serverID, channelID, messageID, content, authorID, username, displayName, avatarURL, nameColor string)
	RelayDelete(serverID, channelID, messageID string)
	RelayTyping(serverID, channelID, authorID, username, displayName, avatarURL, nameColor string, started bool)
	RelayPresence(userID, status string)
	RelayDM(channelID, messageID, content, nonce, msgType, authorID, username, displayName, avatarURL, nameColor, createdAt string)
	RelayVoiceState(serverID, channelID string, userIDs []string)
	RelayCallSignal(serverID, channelID, fromUserID, targetUserID, signalType string, signal json.RawMessage)
}

type Hub struct {
	db              *db.DB
	clients         map[string]map[*Client]bool // userID -> set of active connections
	voiceChannels   map[string]map[string]bool  // channelID -> set of local userIDs
	fedVoiceUsers   map[string][]string         // channelID -> federated userIDs
	federatedOnline map[string]bool             // remote federated userIDs currently online
	register        chan *Client
	unregister      chan *Client
	mu              sync.RWMutex
	fedRelay        FederationRelay
}

func NewHub(database *db.DB) *Hub {
	return &Hub{
		db:              database,
		clients:         make(map[string]map[*Client]bool),
		voiceChannels:   make(map[string]map[string]bool),
		fedVoiceUsers:   make(map[string][]string),
		federatedOnline: make(map[string]bool),
		register:        make(chan *Client),
		unregister:      make(chan *Client),
	}
}

// SetFederationHub stores the federation relay for message relay.
func (h *Hub) SetFederationHub(relay FederationRelay) {
	h.fedRelay = relay
}

// GetFederationRelay returns the federation relay.
func (h *Hub) GetFederationRelay() FederationRelay {
	return h.fedRelay
}

// GetDB returns the database reference.
func (h *Hub) GetDB() *db.DB {
	return h.db
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			if h.clients[client.userID] == nil {
				h.clients[client.userID] = make(map[*Client]bool)
			}
			h.clients[client.userID][client] = true
			isFirst := len(h.clients[client.userID]) == 1
			h.mu.Unlock()

			log.Printf("User %s connected (%d sessions)", client.userID, func() int {
				h.mu.RLock()
				n := len(h.clients[client.userID])
				h.mu.RUnlock()
				return n
			}())
			if isFirst {
				h.db.UpdateUserStatus(client.userID, "online")
				h.broadcastPresence(client.userID, "online")
			}

			// Send the connecting client current online status of related users
			h.sendPresenceSync(client)

		case client := <-h.unregister:
			h.mu.Lock()
			conns := h.clients[client.userID]
			delete(conns, client)
			close(client.send)
			isEmpty := len(conns) == 0
			if isEmpty {
				delete(h.clients, client.userID)
			}
			h.mu.Unlock()

			log.Printf("User %s disconnected", client.userID)
			if isEmpty {
				h.db.UpdateUserStatus(client.userID, "offline")
				h.broadcastPresence(client.userID, "offline")
				HandleDisconnect(h, client.userID)
			}
		}
	}
}

func (h *Hub) broadcastPresence(userID, status string) {
	msg := WSMessage{
		Type: "presence",
		Payload: json.RawMessage(mustMarshal(map[string]string{
			"user_id": userID,
			"status":  status,
		})),
	}
	data := mustMarshal(msg)

	// Only send presence to users who share a server with this user
	peerIDs := h.getRelatedUserIDs(userID)

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, peerID := range peerIDs {
		for client := range h.clients[peerID] {
			select {
			case client.send <- data:
			default:
			}
		}
	}

	// Relay to federation peers
	if h.fedRelay != nil {
		h.fedRelay.RelayPresence(userID, status)
	}
}

// sendPresenceSync sends the connecting client the online status of all related users.
func (h *Hub) sendPresenceSync(client *Client) {
	peerIDs := h.getRelatedUserIDs(client.userID)

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, peerID := range peerIDs {
		if len(h.clients[peerID]) > 0 || h.federatedOnline[peerID] {
			msg := WSMessage{
				Type: "presence",
				Payload: json.RawMessage(mustMarshal(map[string]string{
					"user_id": peerID,
					"status":  "online",
				})),
			}
			data := mustMarshal(msg)
			select {
			case client.send <- data:
			default:
			}
		}
	}
}

// getRelatedUserIDs returns user IDs who share at least one server with the given user.
func (h *Hub) getRelatedUserIDs(userID string) []string {
	servers, err := h.db.GetServersByUser(userID)
	if err != nil {
		return nil
	}

	seen := make(map[string]bool)
	for _, s := range servers {
		members, err := h.db.GetServerMembers(s.ID)
		if err != nil {
			continue
		}
		for _, m := range members {
			if m.UserID != userID {
				seen[m.UserID] = true
			}
		}
	}

	// Also include DM partners
	dmChannels, err := h.db.GetDMChannels(userID)
	if err == nil {
		for _, ch := range dmChannels {
			participants, err := h.db.GetDMParticipants(ch.ID)
			if err != nil {
				continue
			}
			for _, p := range participants {
				if p != userID {
					seen[p] = true
				}
			}
		}
	}

	// Include federated members of shared servers
	for _, s := range servers {
		fedMembers, err := h.db.GetFederatedMembers(s.ID)
		if err != nil {
			continue
		}
		for _, fm := range fedMembers {
			if fm.ID != userID {
				seen[fm.ID] = true
			}
		}
	}

	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	return ids
}

// SendToUser sends a message to all active connections for a user.
func (h *Hub) SendToUser(userID string, data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients[userID] {
		select {
		case client.send <- data:
		default:
		}
	}
}

// SendToUserExcept sends to all connections for a user except the specified client.
func (h *Hub) SendToUserExcept(userID string, data []byte, except *Client) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients[userID] {
		if client == except {
			continue
		}
		select {
		case client.send <- data:
		default:
		}
	}
}

// SendToServer sends a message to all connected members of a server.
func (h *Hub) SendToServer(serverID string, data []byte) {
	members, err := h.db.GetServerMembers(serverID)
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, m := range members {
		for client := range h.clients[m.UserID] {
			select {
			case client.send <- data:
			default:
			}
		}
	}
}

// SendToChannel sends a message to all connected users with access to a channel.
func (h *Hub) SendToChannel(channelID string, data []byte, excludeUserID string) {
	channel, err := h.db.GetChannel(channelID)
	if err != nil {
		return
	}

	var userIDs []string
	if channel.Type == "dm" {
		userIDs, err = h.db.GetDMParticipants(channelID)
	} else {
		members, err2 := h.db.GetServerMembers(channel.ServerID)
		err = err2
		for _, m := range members {
			userIDs = append(userIDs, m.UserID)
		}
	}
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, uid := range userIDs {
		if uid == excludeUserID {
			continue
		}
		for client := range h.clients[uid] {
			select {
			case client.send <- data:
			default:
			}
		}
	}
}

// VoiceJoin adds a user to a voice channel and returns the list of users in it.
func (h *Hub) VoiceJoin(channelID, userID string) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.voiceChannels[channelID] == nil {
		h.voiceChannels[channelID] = make(map[string]bool)
	}
	h.voiceChannels[channelID][userID] = true
	var users []string
	for uid := range h.voiceChannels[channelID] {
		users = append(users, uid)
	}
	return users
}

// VoiceLeave removes a user from a voice channel.
func (h *Hub) VoiceLeave(channelID, userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.voiceChannels[channelID] != nil {
		delete(h.voiceChannels[channelID], userID)
		if len(h.voiceChannels[channelID]) == 0 {
			delete(h.voiceChannels, channelID)
		}
	}
}

// VoiceUsers returns the list of users in a voice channel (local + federated).
func (h *Hub) VoiceUsers(channelID string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	seen := make(map[string]bool)
	var users []string
	for uid := range h.voiceChannels[channelID] {
		if !seen[uid] {
			seen[uid] = true
			users = append(users, uid)
		}
	}
	for _, uid := range h.fedVoiceUsers[channelID] {
		if !seen[uid] {
			seen[uid] = true
			users = append(users, uid)
		}
	}
	return users
}

// SetFederatedVoiceUsers updates the federated voice user list for a channel.
func (h *Hub) SetFederatedVoiceUsers(channelID string, userIDs []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(userIDs) == 0 {
		delete(h.fedVoiceUsers, channelID)
	} else {
		h.fedVoiceUsers[channelID] = userIDs
	}
}

// VoiceLeaveAll removes a user from all voice channels (on disconnect).
func (h *Hub) VoiceLeaveAll(userID string) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var channels []string
	for chID, users := range h.voiceChannels {
		if users[userID] {
			delete(users, userID)
			channels = append(channels, chID)
			if len(users) == 0 {
				delete(h.voiceChannels, chID)
			}
		}
	}
	return channels
}

func mustMarshal(v interface{}) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("Failed to marshal JSON: %v", err)
		return []byte("{}")
	}
	return data
}

// IsUserOnline returns whether a user has any active connections.
func (h *Hub) IsUserOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID]) > 0
}

// GetOnlineUserIDs returns the set of currently connected user IDs.
func (h *Hub) GetOnlineUserIDs() map[string]bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	online := make(map[string]bool, len(h.clients)+len(h.federatedOnline))
	for uid := range h.clients {
		online[uid] = true
	}
	for uid := range h.federatedOnline {
		online[uid] = true
	}
	return online
}

// SetFederatedOnline updates the online status of a federated remote user.
func (h *Hub) SetFederatedOnline(userID string, online bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if online {
		h.federatedOnline[userID] = true
	} else {
		delete(h.federatedOnline, userID)
	}
}
