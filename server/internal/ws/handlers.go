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
	case "edit_message":
		handleEditMessage(c, msg.Payload)
	case "delete_message":
		handleDeleteMessage(c, msg.Payload)
	case "typing_start":
		handleTyping(c, msg.Payload, true)
	case "typing_stop":
		handleTyping(c, msg.Payload, false)
	case "call_offer", "call_answer", "ice_candidate", "call_end":
		handleCallSignal(c, msg.Type, msg.Payload)
	case "voice_join":
		handleVoiceJoin(c, msg.Payload)
	case "voice_leave":
		handleVoiceLeave(c, msg.Payload)
	case "voice_kick":
		handleVoiceKick(c, msg.Payload)
	default:
		log.Printf("Unknown WebSocket message type: %s", msg.Type)
	}
}

type chatMessagePayload struct {
	ChannelID     string   `json:"channel_id"`
	Content       string   `json:"content"`
	Nonce         string   `json:"nonce"`
	Type          string   `json:"type"`
	AttachmentIDs []string `json:"attachment_ids"`
	ReplyToID     *string  `json:"reply_to_id,omitempty"`
}

func handleChatMessage(c *Client, payload json.RawMessage) {
	var p chatMessagePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	if p.Content == "" && len(p.AttachmentIDs) == 0 || p.ChannelID == "" {
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
	if p.Content == "" {
		p.Content = " "
	}
	msg, err := c.hub.db.CreateMessage(msgID, p.ChannelID, c.userID, p.Content, p.Nonce, p.Type, p.ReplyToID)
	if err != nil {
		log.Printf("Failed to create message: %v", err)
		return
	}

	// Link attachments to this message
	for _, aid := range p.AttachmentIDs {
		c.hub.db.LinkAttachment(aid, msgID)
	}

	// Reload to get attachments
	if len(p.AttachmentIDs) > 0 {
		msg, _ = c.hub.db.GetMessage(msgID)
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

type editMessagePayload struct {
	MessageID string `json:"message_id"`
	Content   string `json:"content"`
}

func handleEditMessage(c *Client, payload json.RawMessage) {
	var p editMessagePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}
	if p.MessageID == "" || p.Content == "" {
		return
	}

	// Verify ownership
	existing, err := c.hub.db.GetMessage(p.MessageID)
	if err != nil || existing.UserID != c.userID {
		return
	}

	updated, err := c.hub.db.UpdateMessage(p.MessageID, p.Content)
	if err != nil {
		log.Printf("Failed to edit message: %v", err)
		return
	}

	// Get author info
	author, _ := c.hub.db.GetUserByID(c.userID)
	if author != nil {
		author.Email = ""
		updated.Author = author
	}

	broadcastMsg := WSMessage{
		Type:    "message_edited",
		Payload: json.RawMessage(mustMarshal(updated)),
	}
	data := mustMarshal(broadcastMsg)
	c.hub.SendToChannel(existing.ChannelID, data, "")
}

type deleteMessagePayload struct {
	MessageID string `json:"message_id"`
}

func handleDeleteMessage(c *Client, payload json.RawMessage) {
	var p deleteMessagePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}
	if p.MessageID == "" {
		return
	}

	// Verify ownership or admin status
	existing, err := c.hub.db.GetMessage(p.MessageID)
	if err != nil {
		return
	}
	if existing.UserID != c.userID {
		// Check if user is admin of the server this channel belongs to
		ch, chErr := c.hub.db.GetChannel(existing.ChannelID)
		if chErr != nil || ch.ServerID == "" {
			return
		}
		role, roleErr := c.hub.db.GetMemberRole(ch.ServerID, c.userID)
		if roleErr != nil || role != "admin" {
			return
		}
	}

	updated, err := c.hub.db.DeleteMessage(p.MessageID, c.userID)
	if err != nil {
		log.Printf("Failed to delete message: %v", err)
		return
	}

	broadcastMsg := WSMessage{
		Type:    "message_deleted",
		Payload: json.RawMessage(mustMarshal(updated)),
	}
	data := mustMarshal(broadcastMsg)
	c.hub.SendToChannel(existing.ChannelID, data, "")
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

type voicePayload struct {
	ChannelID string `json:"channel_id"`
}

func handleVoiceJoin(c *Client, payload json.RawMessage) {
	var p voicePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	users := c.hub.VoiceJoin(p.ChannelID, c.userID)

	// Broadcast updated voice state to the channel
	msg := WSMessage{
		Type: "voice_state",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"channel_id": p.ChannelID,
			"user_ids":   users,
		})),
	}
	data := mustMarshal(msg)
	c.hub.SendToChannel(p.ChannelID, data, "")
}

func handleVoiceLeave(c *Client, payload json.RawMessage) {
	var p voicePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	c.hub.VoiceLeave(p.ChannelID, c.userID)

	users := c.hub.VoiceUsers(p.ChannelID)
	msg := WSMessage{
		Type: "voice_state",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"channel_id": p.ChannelID,
			"user_ids":   users,
		})),
	}
	data := mustMarshal(msg)
	c.hub.SendToChannel(p.ChannelID, data, "")
}

func handleVoiceKick(c *Client, payload json.RawMessage) {
	var p struct {
		ChannelID string `json:"channel_id"`
		UserID    string `json:"user_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	// Check that the channel belongs to a server and requester is admin
	channel, err := c.hub.db.GetChannel(p.ChannelID)
	if err != nil || channel.ServerID == "" {
		return
	}
	role, err := c.hub.db.GetMemberRole(channel.ServerID, c.userID)
	if err != nil || role != "admin" {
		return
	}

	// Remove the target user from voice
	c.hub.VoiceLeave(p.ChannelID, p.UserID)

	// Notify kicked user
	kickMsg := WSMessage{
		Type: "voice_kicked",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"channel_id": p.ChannelID,
		})),
	}
	c.hub.SendToUser(p.UserID, mustMarshal(kickMsg))

	// Broadcast updated voice state
	users := c.hub.VoiceUsers(p.ChannelID)
	stateMsg := WSMessage{
		Type: "voice_state",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"channel_id": p.ChannelID,
			"user_ids":   users,
		})),
	}
	c.hub.SendToChannel(p.ChannelID, mustMarshal(stateMsg), "")
}

// HandleDisconnect cleans up voice state when a user disconnects.
func HandleDisconnect(hub *Hub, userID string) {
	channels := hub.VoiceLeaveAll(userID)
	for _, chID := range channels {
		users := hub.VoiceUsers(chID)
		msg := WSMessage{
			Type: "voice_state",
			Payload: json.RawMessage(mustMarshal(map[string]interface{}{
				"channel_id": chID,
				"user_ids":   users,
			})),
		}
		data := mustMarshal(msg)
		hub.SendToChannel(chID, data, "")

		// Also notify remaining users to end calls with disconnected user
		endMsg := WSMessage{
			Type: "call_end",
			Payload: json.RawMessage(mustMarshal(map[string]interface{}{
				"from_user_id": userID,
				"channel_id":   chID,
			})),
		}
		endData := mustMarshal(endMsg)
		hub.SendToChannel(chID, endData, userID)
	}
}
