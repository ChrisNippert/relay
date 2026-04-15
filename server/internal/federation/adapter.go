package federation

import "encoding/json"

// Adapter implements ws.FederationRelay by delegating to the federation Hub.
type Adapter struct {
	Hub *Hub
}

func (a *Adapter) RelayMessage(serverID, channelID, messageID, content, nonce, msgType string, keyEpoch int, replyToID *string, authorID, username, displayName, avatarURL, nameColor, createdAt string) {
	author := MakeFedAuthor(authorID, username, displayName, avatarURL, nameColor)
	RelayMessageToFederation(a.Hub, serverID, channelID, messageID, content, nonce, msgType, keyEpoch, replyToID, author, createdAt)
}

func (a *Adapter) RelayEdit(serverID, channelID, messageID, content, authorID, username, displayName, avatarURL, nameColor string) {
	author := MakeFedAuthor(authorID, username, displayName, avatarURL, nameColor)
	RelayEditToFederation(a.Hub, serverID, channelID, messageID, content, author)
}

func (a *Adapter) RelayDelete(serverID, channelID, messageID string) {
	RelayDeleteToFederation(a.Hub, serverID, channelID, messageID)
}

func (a *Adapter) RelayTyping(serverID, channelID, authorID, username, displayName, avatarURL, nameColor string, started bool) {
	author := MakeFedAuthor(authorID, username, displayName, avatarURL, nameColor)
	RelayTypingToFederation(a.Hub, serverID, channelID, author, started)
}

func (a *Adapter) RelayPresence(userID, status string) {
	RelayPresenceToFederation(a.Hub, userID, status)
}

func (a *Adapter) RelayDM(channelID, messageID, content, nonce, msgType, authorID, username, displayName, avatarURL, nameColor, createdAt string) {
	RelayDMToFederation(a.Hub, channelID, messageID, content, nonce, msgType, authorID, username, displayName, avatarURL, nameColor, createdAt)
}

func (a *Adapter) RelayVoiceState(serverID, channelID string, userIDs []string) {
	RelayVoiceStateToFederation(a.Hub, serverID, channelID, userIDs)
}

func (a *Adapter) RelayCallSignal(serverID, channelID, fromUserID, targetUserID, signalType string, signal json.RawMessage) {
	RelayCallSignalToFederation(a.Hub, serverID, channelID, fromUserID, targetUserID, signalType, signal)
}
