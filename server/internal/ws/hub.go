package ws

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/relay-chat/relay/internal/db"
)

type Hub struct {
	db         *db.DB
	clients       map[string]*Client          // userID -> Client
	voiceChannels map[string]map[string]bool   // channelID -> set of userIDs
	register      chan *Client
	unregister    chan *Client
	mu            sync.RWMutex
}

func NewHub(database *db.DB) *Hub {
	return &Hub{
		db:         database,
		clients:       make(map[string]*Client),
		voiceChannels: make(map[string]map[string]bool),
		register:      make(chan *Client),
		unregister:    make(chan *Client),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			if existing, ok := h.clients[client.userID]; ok {
				close(existing.send)
				existing.conn.Close()
			}
			h.clients[client.userID] = client
			h.mu.Unlock()

			log.Printf("User %s connected", client.userID)
			h.db.UpdateUserStatus(client.userID, "online")
			h.broadcastPresence(client.userID, "online")

		case client := <-h.unregister:
			h.mu.Lock()
			if existing, ok := h.clients[client.userID]; ok && existing == client {
				delete(h.clients, client.userID)
				close(client.send)
			}
			h.mu.Unlock()

			log.Printf("User %s disconnected", client.userID)
			h.db.UpdateUserStatus(client.userID, "offline")
			h.broadcastPresence(client.userID, "offline")
			HandleDisconnect(h, client.userID)
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

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, client := range h.clients {
		select {
		case client.send <- data:
		default:
		}
	}
}

// SendToUser sends a message to a specific connected user.
func (h *Hub) SendToUser(userID string, data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if client, ok := h.clients[userID]; ok {
		select {
		case client.send <- data:
		default:
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
		if client, ok := h.clients[uid]; ok {
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

// VoiceUsers returns the list of users in a voice channel.
func (h *Hub) VoiceUsers(channelID string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var users []string
	for uid := range h.voiceChannels[channelID] {
		users = append(users, uid)
	}
	return users
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
