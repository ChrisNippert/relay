package federation

import (
	"encoding/json"
	"log"

	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/ws"
)

// RegisterHandlers wires up the federation message handler to process incoming
// S2S messages and deliver them to local clients.
func RegisterHandlers(fedHub *Hub, wsHub *ws.Hub, database *db.DB) {
	fedHub.Handler = func(origin string, msg FedMessage) {
		switch msg.Type {
		case "fed_message":
			handleFedMessage(fedHub, wsHub, database, origin, msg.Payload)
		case "fed_message_edit":
			handleFedMessageEdit(wsHub, database, origin, msg.Payload)
		case "fed_message_delete":
			handleFedMessageDelete(wsHub, database, origin, msg.Payload)
		case "fed_typing":
			handleFedTyping(wsHub, database, origin, msg.Payload)
		case "fed_presence":
			handleFedPresence(wsHub, database, origin, msg.Payload)
		case "fed_join":
			handleFedJoin(fedHub, wsHub, database, origin, msg.Payload)
		case "fed_leave":
			handleFedLeave(wsHub, database, origin, msg.Payload)
		case "fed_dm_message":
			handleFedDMMessage(wsHub, database, origin, msg.Payload)
		case "fed_dm_create":
			handleFedDMCreate(database, origin, msg.Payload)
		case "fed_voice_state":
			handleFedVoiceState(wsHub, database, origin, msg.Payload)
		case "fed_call_signal":
			handleFedCallSignal(wsHub, database, origin, msg.Payload)
		default:
			log.Printf("[federation] Unknown message type from %s: %s", origin, msg.Type)
		}
	}
}

// --- Incoming message handlers ---

type fedMessagePayload struct {
	ServerID    string          `json:"server_id"`
	ChannelID   string          `json:"channel_id"`
	MessageID   string          `json:"message_id"`
	Content     string          `json:"content"`
	Nonce       string          `json:"nonce"`
	MsgType     string          `json:"msg_type"`
	KeyEpoch    int             `json:"key_epoch"`
	ReplyToID   *string         `json:"reply_to_id,omitempty"`
	Author      fedAuthorInfo   `json:"author"`
	CreatedAt   string          `json:"created_at"`
	Attachments json.RawMessage `json:"attachments,omitempty"`
}

type fedAuthorInfo struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
	NameColor   string `json:"name_color"`
}

func handleFedMessage(fedHub *Hub, wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedMessagePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		log.Printf("[federation] Invalid fed_message: %v", err)
		return
	}

	// Upsert the remote user cache
	remoteUserID := "fed:" + stripScheme(origin) + ":" + p.Author.ID
	database.UpsertRemoteUser(remoteUserID, origin, p.Author.ID, p.Author.Username, p.Author.DisplayName, p.Author.AvatarURL, p.Author.NameColor)

	// Store the message locally so it appears in history
	localMsgID := "fed:" + p.MessageID
	content := p.Content
	if content == "" {
		content = " "
	}
	database.CreateFederatedMessage(localMsgID, p.ChannelID, remoteUserID, content, p.Nonce, p.MsgType, p.ReplyToID, p.KeyEpoch)

	// Build the WS broadcast for local clients
	authorJSON := map[string]interface{}{
		"id":           remoteUserID,
		"username":     p.Author.Username + "#" + p.Author.ID[:8],
		"display_name": p.Author.DisplayName,
		"avatar_url":   p.Author.AvatarURL,
		"name_color":   p.Author.NameColor,
		"status":       "online",
		"federated":    true,
		"origin_url":   origin,
	}

	msgJSON := map[string]interface{}{
		"id":         localMsgID,
		"channel_id": p.ChannelID,
		"user_id":    remoteUserID,
		"content":    p.Content,
		"nonce":      p.Nonce,
		"type":       p.MsgType,
		"key_epoch":  p.KeyEpoch,
		"edited":     false,
		"deleted":    false,
		"created_at": p.CreatedAt,
		"updated_at": p.CreatedAt,
		"author":     authorJSON,
		"federated":  true,
	}
	if p.ReplyToID != nil {
		msgJSON["reply_to_id"] = *p.ReplyToID
	}

	broadcastMsg := ws.WSMessage{
		Type:    "chat_message",
		Payload: json.RawMessage(mustMarshal(msgJSON)),
	}
	wsHub.SendToChannel(p.ChannelID, mustMarshal(broadcastMsg), "")
}

type fedEditPayload struct {
	ChannelID string        `json:"channel_id"`
	MessageID string        `json:"message_id"`
	Content   string        `json:"content"`
	Author    fedAuthorInfo `json:"author"`
}

func handleFedMessageEdit(wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedEditPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	localMsgID := "fed:" + p.MessageID
	database.UpdateFederatedMessage(localMsgID, p.Content)

	remoteUserID := "fed:" + stripScheme(origin) + ":" + p.Author.ID
	authorJSON := map[string]interface{}{
		"id":           remoteUserID,
		"username":     p.Author.Username + "#" + p.Author.ID[:8],
		"display_name": p.Author.DisplayName,
		"avatar_url":   p.Author.AvatarURL,
		"name_color":   p.Author.NameColor,
		"federated":    true,
	}

	broadcastMsg := ws.WSMessage{
		Type: "message_edited",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"id":         localMsgID,
			"channel_id": p.ChannelID,
			"user_id":    remoteUserID,
			"content":    p.Content,
			"edited":     true,
			"author":     authorJSON,
		})),
	}
	wsHub.SendToChannel(p.ChannelID, mustMarshal(broadcastMsg), "")
}

type fedDeletePayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
}

func handleFedMessageDelete(wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedDeletePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	localMsgID := "fed:" + p.MessageID
	database.SoftDeleteFederatedMessage(localMsgID)

	broadcastMsg := ws.WSMessage{
		Type: "message_deleted",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"id":         localMsgID,
			"channel_id": p.ChannelID,
			"deleted":    true,
			"content":    "[deleted]",
		})),
	}
	wsHub.SendToChannel(p.ChannelID, mustMarshal(broadcastMsg), "")
}

type fedTypingPayload struct {
	ChannelID string        `json:"channel_id"`
	Author    fedAuthorInfo `json:"author"`
	Started   bool          `json:"started"`
}

func handleFedTyping(wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedTypingPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	remoteUserID := "fed:" + stripScheme(origin) + ":" + p.Author.ID
	typeName := "typing_stop"
	if p.Started {
		typeName = "typing_start"
	}

	msg := ws.WSMessage{
		Type: typeName,
		Payload: json.RawMessage(mustMarshal(map[string]string{
			"channel_id": p.ChannelID,
			"user_id":    remoteUserID,
		})),
	}
	wsHub.SendToChannel(p.ChannelID, mustMarshal(msg), "")
}

type fedPresencePayload struct {
	UserID string `json:"user_id"`
	Status string `json:"status"`
}

func handleFedPresence(wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedPresencePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	remoteUserID := "fed:" + stripScheme(origin) + ":" + p.UserID

	// Track federated user online state so the /online endpoint includes them
	wsHub.SetFederatedOnline(remoteUserID, p.Status == "online")

	// Find servers where this remote user is a federated member
	serverIDs, err := database.GetFederatedServersByOrigin(origin)
	if err != nil {
		return
	}

	msg := ws.WSMessage{
		Type: "presence",
		Payload: json.RawMessage(mustMarshal(map[string]string{
			"user_id": remoteUserID,
			"status":  p.Status,
		})),
	}
	data := mustMarshal(msg)

	// Send to all local members of servers that have this federated user
	for _, serverID := range serverIDs {
		wsHub.SendToServer(serverID, data)
	}
}

type fedJoinPayload struct {
	ServerID string        `json:"server_id"`
	User     fedAuthorInfo `json:"user"`
}

func handleFedJoin(fedHub *Hub, wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedJoinPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	// Verify the server exists locally
	_, err := database.GetServer(p.ServerID)
	if err != nil {
		log.Printf("[federation] fed_join for unknown server %s from %s", p.ServerID, origin)
		return
	}

	remoteUserID := "fed:" + stripScheme(origin) + ":" + p.User.ID
	database.UpsertRemoteUser(remoteUserID, origin, p.User.ID, p.User.Username, p.User.DisplayName, p.User.AvatarURL, p.User.NameColor)
	database.AddFederatedMember(p.ServerID, remoteUserID, "member")

	// Broadcast to local server members
	msg := ws.WSMessage{
		Type: "member_joined",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"server_id":  p.ServerID,
			"user_id":    remoteUserID,
			"federated":  true,
			"origin_url": origin,
		})),
	}
	wsHub.SendToServer(p.ServerID, mustMarshal(msg))
}

type fedLeavePayload struct {
	ServerID string `json:"server_id"`
	UserID   string `json:"user_id"`
}

func handleFedLeave(wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedLeavePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	remoteUserID := "fed:" + stripScheme(origin) + ":" + p.UserID
	database.RemoveFederatedMember(p.ServerID, remoteUserID)

	msg := ws.WSMessage{
		Type: "member_left",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"server_id": p.ServerID,
			"user_id":   remoteUserID,
			"federated": true,
		})),
	}
	wsHub.SendToServer(p.ServerID, mustMarshal(msg))
}

type fedDMMessagePayload struct {
	ChannelID string        `json:"channel_id"`
	MessageID string        `json:"message_id"`
	Content   string        `json:"content"`
	Nonce     string        `json:"nonce"`
	MsgType   string        `json:"msg_type"`
	Author    fedAuthorInfo `json:"author"`
	TargetID  string        `json:"target_id"`
	CreatedAt string        `json:"created_at"`
}

func handleFedDMMessage(wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedDMMessagePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	remoteUserID := "fed:" + stripScheme(origin) + ":" + p.Author.ID
	database.UpsertRemoteUser(remoteUserID, origin, p.Author.ID, p.Author.Username, p.Author.DisplayName, p.Author.AvatarURL, p.Author.NameColor)

	// Store the DM locally
	localMsgID := "fed:" + p.MessageID
	content := p.Content
	if content == "" {
		content = " "
	}
	database.CreateFederatedMessage(localMsgID, p.ChannelID, remoteUserID, content, p.Nonce, p.MsgType, nil, 0)

	authorJSON := map[string]interface{}{
		"id":           remoteUserID,
		"username":     p.Author.Username + "#" + p.Author.ID[:8],
		"display_name": p.Author.DisplayName,
		"avatar_url":   p.Author.AvatarURL,
		"name_color":   p.Author.NameColor,
		"federated":    true,
		"origin_url":   origin,
	}

	broadcastMsg := ws.WSMessage{
		Type: "chat_message",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"id":         localMsgID,
			"channel_id": p.ChannelID,
			"user_id":    remoteUserID,
			"content":    p.Content,
			"nonce":      p.Nonce,
			"type":       p.MsgType,
			"edited":     false,
			"deleted":    false,
			"created_at": p.CreatedAt,
			"updated_at": p.CreatedAt,
			"author":     authorJSON,
			"federated":  true,
		})),
	}
	// Deliver to the target local user
	wsHub.SendToUser(p.TargetID, mustMarshal(broadcastMsg))
}

type fedDMCreatePayload struct {
	ChannelID string        `json:"channel_id"`
	User      fedAuthorInfo `json:"user"`
	TargetID  string        `json:"target_id"`
}

func handleFedDMCreate(database *db.DB, origin string, payload json.RawMessage) {
	var p fedDMCreatePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	remoteUserID := "fed:" + stripScheme(origin) + ":" + p.User.ID
	database.UpsertRemoteUser(remoteUserID, origin, p.User.ID, p.User.Username, p.User.DisplayName, p.User.AvatarURL, p.User.NameColor)

	// Create the DM channel locally if it doesn't exist
	_, err := database.GetChannel(p.ChannelID)
	if err != nil {
		channelID := p.ChannelID
		database.CreateFederatedDMChannel(channelID, p.TargetID, remoteUserID)
	}
}

// --- Federation relay helpers (outgoing) ---

// RelayMessageToFederation is called after a local message is sent in a server channel
// to forward it to peers with federated members.
func RelayMessageToFederation(fedHub *Hub, serverID, channelID, messageID, content, nonce, msgType string, keyEpoch int, replyToID *string, author fedAuthorInfo, createdAt string) {
	if fedHub == nil || !fedHub.cfg.Federation.Enabled {
		return
	}

	payload := fedMessagePayload{
		ServerID:  serverID,
		ChannelID: channelID,
		MessageID: messageID,
		Content:   content,
		Nonce:     nonce,
		MsgType:   msgType,
		KeyEpoch:  keyEpoch,
		ReplyToID: replyToID,
		Author:    author,
		CreatedAt: createdAt,
	}

	msg := FedMessage{
		Type:    "fed_message",
		Origin:  fedHub.cfg.Federation.InstanceURL,
		Payload: json.RawMessage(mustMarshal(payload)),
	}

	fedHub.SendToServersOnPeer(serverID, msg)
}

// RelayEditToFederation forwards a message edit to federated peers.
func RelayEditToFederation(fedHub *Hub, serverID, channelID, messageID, content string, author fedAuthorInfo) {
	if fedHub == nil || !fedHub.cfg.Federation.Enabled {
		return
	}

	msg := FedMessage{
		Type:   "fed_message_edit",
		Origin: fedHub.cfg.Federation.InstanceURL,
		Payload: json.RawMessage(mustMarshal(fedEditPayload{
			ChannelID: channelID,
			MessageID: messageID,
			Content:   content,
			Author:    author,
		})),
	}
	fedHub.SendToServersOnPeer(serverID, msg)
}

// RelayDeleteToFederation forwards a message deletion to federated peers.
func RelayDeleteToFederation(fedHub *Hub, serverID, channelID, messageID string) {
	if fedHub == nil || !fedHub.cfg.Federation.Enabled {
		return
	}

	msg := FedMessage{
		Type:   "fed_message_delete",
		Origin: fedHub.cfg.Federation.InstanceURL,
		Payload: json.RawMessage(mustMarshal(fedDeletePayload{
			ChannelID: channelID,
			MessageID: messageID,
		})),
	}
	fedHub.SendToServersOnPeer(serverID, msg)
}

// RelayTypingToFederation forwards typing indicators to federated peers.
func RelayTypingToFederation(fedHub *Hub, serverID, channelID string, author fedAuthorInfo, started bool) {
	if fedHub == nil || !fedHub.cfg.Federation.Enabled {
		return
	}

	msg := FedMessage{
		Type:   "fed_typing",
		Origin: fedHub.cfg.Federation.InstanceURL,
		Payload: json.RawMessage(mustMarshal(fedTypingPayload{
			ChannelID: channelID,
			Author:    author,
			Started:   started,
		})),
	}
	fedHub.SendToServersOnPeer(serverID, msg)
}

// RelayPresenceToFederation forwards presence updates to all peers.
func RelayPresenceToFederation(fedHub *Hub, userID, status string) {
	if fedHub == nil || !fedHub.cfg.Federation.Enabled {
		return
	}

	msg := FedMessage{
		Type:   "fed_presence",
		Origin: fedHub.cfg.Federation.InstanceURL,
		Payload: json.RawMessage(mustMarshal(fedPresencePayload{
			UserID: userID,
			Status: status,
		})),
	}
	fedHub.Broadcast(msg)
}

// RelayDMToFederation forwards a DM message to the appropriate peer.
func RelayDMToFederation(fedHub *Hub, channelID, messageID, content, nonce, msgType, authorID, username, displayName, avatarURL, nameColor, createdAt string) {
	if fedHub == nil || !fedHub.cfg.Federation.Enabled {
		return
	}

	// Find the DM participants to identify the remote user
	participants, err := fedHub.database.GetDMParticipants(channelID)
	if err != nil {
		return
	}

	for _, pid := range participants {
		// Check if this participant is a federated user
		if len(pid) > 4 && pid[:4] == "fed:" {
			remoteUser, err := fedHub.database.GetRemoteUser(pid)
			if err != nil {
				continue
			}

			msg := FedMessage{
				Type:   "fed_dm_message",
				Origin: fedHub.cfg.Federation.InstanceURL,
				Payload: json.RawMessage(mustMarshal(fedDMMessagePayload{
					ChannelID: channelID,
					MessageID: messageID,
					Content:   content,
					Nonce:     nonce,
					MsgType:   msgType,
					Author: fedAuthorInfo{
						ID:          authorID,
						Username:    username,
						DisplayName: displayName,
						AvatarURL:   avatarURL,
						NameColor:   nameColor,
					},
					TargetID:  remoteUser.RemoteID,
					CreatedAt: createdAt,
				})),
			}
			fedHub.Send(remoteUser.OriginURL, msg)
		}
	}
}

// MakeFedAuthor creates a fedAuthorInfo from user details.
func MakeFedAuthor(id, username, displayName, avatarURL, nameColor string) fedAuthorInfo {
	return fedAuthorInfo{
		ID:          id,
		Username:    username,
		DisplayName: displayName,
		AvatarURL:   avatarURL,
		NameColor:   nameColor,
	}
}

// --- Federated invite join (outgoing) ---

// RequestFederatedJoin sends a join request to a remote server's home node.
func RequestFederatedJoin(fedHub *Hub, peerURL, serverID string, user fedAuthorInfo) {
	if fedHub == nil {
		return
	}

	msg := FedMessage{
		Type:   "fed_join",
		Origin: fedHub.cfg.Federation.InstanceURL,
		Payload: json.RawMessage(mustMarshal(fedJoinPayload{
			ServerID: serverID,
			User:     user,
		})),
	}
	fedHub.Send(peerURL, msg)
}

// helpers

func mustMarshal(v interface{}) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return data
}

func stripScheme(url string) string {
	for _, prefix := range []string{"https://", "http://"} {
		if len(url) > len(prefix) && url[:len(prefix)] == prefix {
			return url[len(prefix):]
		}
	}
	return url
}

// NewFedJoinPayload is used externally.
func NewFedJoinPayload(serverID string, user fedAuthorInfo) fedJoinPayload {
	return fedJoinPayload{ServerID: serverID, User: user}
}

// --- Voice federation ---

type fedVoiceStatePayload struct {
	ServerID  string   `json:"server_id"`
	ChannelID string   `json:"channel_id"`
	UserIDs   []string `json:"user_ids"`
}

func handleFedVoiceState(wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedVoiceStatePayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	// Map remote user IDs to federated IDs, but skip IDs that are local users
	mappedIDs := make([]string, 0, len(p.UserIDs))
	for _, uid := range p.UserIDs {
		// Skip federated IDs — the relay should only send local user IDs
		if len(uid) > 4 && uid[:4] == "fed:" {
			continue
		}
		// Check if this is actually a local user (shouldn't happen, but guard)
		if _, err := database.GetUserByID(uid); err == nil {
			continue
		}
		mappedIDs = append(mappedIDs, "fed:"+stripScheme(origin)+":"+uid)
	}

	// Update the hub's voice channel state with remote users
	wsHub.SetFederatedVoiceUsers(p.ChannelID, mappedIDs)

	// Get combined voice users (local + federated)
	users := wsHub.VoiceUsers(p.ChannelID)

	msg := ws.WSMessage{
		Type: "voice_state",
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"channel_id": p.ChannelID,
			"user_ids":   users,
		})),
	}
	wsHub.SendToServer(p.ServerID, mustMarshal(msg))
}

type fedCallSignalPayload struct {
	ServerID     string          `json:"server_id"`
	ChannelID    string          `json:"channel_id"`
	FromUserID   string          `json:"from_user_id"`
	TargetUserID string          `json:"target_user_id"`
	SignalType   string          `json:"signal_type"`
	Signal       json.RawMessage `json:"signal"`
}

func handleFedCallSignal(wsHub *ws.Hub, database *db.DB, origin string, payload json.RawMessage) {
	var p fedCallSignalPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return
	}

	// Map the remote sender to a federated user ID
	fromUserID := p.FromUserID
	if len(fromUserID) <= 4 || fromUserID[:4] != "fed:" {
		fromUserID = "fed:" + stripScheme(origin) + ":" + p.FromUserID
	}

	msg := ws.WSMessage{
		Type: p.SignalType,
		Payload: json.RawMessage(mustMarshal(map[string]interface{}{
			"from_user_id": fromUserID,
			"channel_id":   p.ChannelID,
			"signal":       p.Signal,
		})),
	}
	wsHub.SendToUser(p.TargetUserID, mustMarshal(msg))
}

// RelayVoiceStateToFederation forwards voice state changes to federated peers.
// Only sends local user IDs — federated users from other peers are excluded.
func RelayVoiceStateToFederation(fedHub *Hub, serverID, channelID string, userIDs []string) {
	if fedHub == nil || !fedHub.cfg.Federation.Enabled {
		return
	}

	// Only send local user IDs, not federated ones from other peers
	localIDs := make([]string, 0, len(userIDs))
	for _, uid := range userIDs {
		if len(uid) <= 4 || uid[:4] != "fed:" {
			localIDs = append(localIDs, uid)
		}
	}

	msg := FedMessage{
		Type:   "fed_voice_state",
		Origin: fedHub.cfg.Federation.InstanceURL,
		Payload: json.RawMessage(mustMarshal(fedVoiceStatePayload{
			ServerID:  serverID,
			ChannelID: channelID,
			UserIDs:   localIDs,
		})),
	}
	fedHub.SendToServersOnPeer(serverID, msg)
}

// RelayCallSignalToFederation forwards WebRTC signaling to the correct federated peer.
func RelayCallSignalToFederation(fedHub *Hub, serverID, channelID, fromUserID, targetUserID, signalType string, signal json.RawMessage) {
	if fedHub == nil || !fedHub.cfg.Federation.Enabled {
		return
	}

	// Determine which peer owns the target user
	// targetUserID is like "fed:localhost:3002:uuid" — extract the origin
	remoteUser, err := fedHub.database.GetRemoteUser(targetUserID)
	if err != nil {
		return
	}

	msg := FedMessage{
		Type:   "fed_call_signal",
		Origin: fedHub.cfg.Federation.InstanceURL,
		Payload: json.RawMessage(mustMarshal(fedCallSignalPayload{
			ServerID:     serverID,
			ChannelID:    channelID,
			FromUserID:   fromUserID,
			TargetUserID: remoteUser.RemoteID, // Send the actual user ID on the remote instance
			SignalType:   signalType,
			Signal:       signal,
		})),
	}
	fedHub.Send(remoteUser.OriginURL, msg)
}
