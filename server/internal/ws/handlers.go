package ws

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/relay-chat/relay/internal/auth"
	"github.com/relay-chat/relay/internal/config"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// WSMessage is the envelope for all WebSocket messages.
type WSMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// HandleWebSocket upgrades HTTP to WebSocket, authenticating via token query param.
func HandleWebSocket(hub *Hub, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		if token == "" {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}

		claims, err := auth.ValidateToken(token, cfg.JWTSecret)
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("WebSocket upgrade error: %v", err)
			return
		}

		client := &Client{
			hub:    hub,
			conn:   conn,
			userID: claims.UserID,
			send:   make(chan []byte, 256),
		}

		hub.register <- client
		go client.writePump()
		go client.readPump()
	}
}

func handleMessage(c *Client, raw []byte) {
	var msg WSMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		log.Printf("Invalid WebSocket message: %v", err)
		return
	}

	switch msg.Type {
	case "chat_message":
		handleChatMessage(c, msg.Payload)
	case "typing_start":
		handleTyping(c, msg.Payload, true)
	case "typing_stop":
		handleTyping(c, msg.Payload, false)
	case "call_offer", "call_answer", "ice_candidate", "call_end":
		handleCallSignal(c, msg.Type, msg.Payload)
	default:
		log.Printf("Unknown WebSocket message type: %s", msg.Type)
	}
}

type chatMessagePayload struct {
	ChannelID string `json:"channel_id"`
	Content   string `json:"content"`
	Nonce     string `json:"nonce"`
	Type      string `json:"type"`
}

func handleChatMessage(c *Client, payload json.RawMessage) {
	var p chatMessagePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	if p.Content == "" || p.ChannelID == "" {
		return
	}

	if p.Type == "" {
		p.Type = "text"
	}

	// Verify access
	hasAccess, err := c.hub.db.IsChannelParticipant(p.ChannelID, c.userID)
	if err != nil || !hasAccess {
		return
	}

	// Store message
	msgID := uuid.New().String()
	msg, err := c.hub.db.CreateMessage(msgID, p.ChannelID, c.userID, p.Content, p.Nonce, p.Type)
	if err != nil {
		log.Printf("Failed to create message: %v", err)
		return
	}

	// Get author info (strip sensitive fields)
	author, _ := c.hub.db.GetUserByID(c.userID)
	if author != nil {
		author.Email = ""
		msg.Author = author
	}

	// Broadcast to channel (including sender for confirmation)
	broadcastMsg := WSMessage{
		Type:    "chat_message",
		Payload: json.RawMessage(mustMarshal(msg)),
	}
	data := mustMarshal(broadcastMsg)
	c.hub.SendToChannel(p.ChannelID, data, "")
}

type typingPayload struct {
	ChannelID string `json:"channel_id"`
}

func handleTyping(c *Client, payload json.RawMessage, started bool) {
	var p typingPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	typeName := "typing_stop"
	if started {
		typeName = "typing_start"
	}

	msg := WSMessage{
		Type: typeName,
		Payload: json.RawMessage(mustMarshal(map[string]string{
			"channel_id": p.ChannelID,
			"user_id":    c.userID,
		})),
	}
	data := mustMarshal(msg)
	c.hub.SendToChannel(p.ChannelID, data, c.userID)
}

type callSignalPayload struct {
	TargetUserID string          `json:"target_user_id"`
	ChannelID    string          `json:"channel_id"`
	Signal       json.RawMessage `json:"signal"`
}

func handleCallSignal(c *Client, signalType string, payload json.RawMessage) {
	var p callSignalPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	msg := WSMessage{
		Type: signalType,
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"from_user_id": c.userID,
			"channel_id":   p.ChannelID,
			"signal":       p.Signal,
		})),
	}
	data := mustMarshal(msg)
	c.hub.SendToUser(p.TargetUserID, data)
}
