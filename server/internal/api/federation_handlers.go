package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/relay-chat/relay/internal/config"
	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/federation"
	"github.com/relay-chat/relay/internal/ws"
)

// FederationInfoHandler returns basic info about this instance for federation discovery.
func FederationInfoHandler(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"instance_url": cfg.Federation.InstanceURL,
			"federation":   true,
		})
	}
}

// FederationResolveInviteHandler allows a peer to resolve an invite code and get server info.
// Authenticated via X-Federation-Token header.
func FederationResolveInviteHandler(cfg *config.Config, database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Federation-Token")
		if token != cfg.Federation.Token {
			http.Error(w, `{"error":"invalid federation token"}`, http.StatusForbidden)
			return
		}

		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
			return
		}

		invite, err := database.GetInviteByCode(req.Code)
		if err != nil {
			http.Error(w, `{"error":"invalid invite code"}`, http.StatusNotFound)
			return
		}

		server, err := database.GetServer(invite.ServerID)
		if err != nil {
			http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"server_id":    server.ID,
			"server_name":  server.Name,
			"server_icon":  server.IconURL,
			"instance_url": cfg.Federation.InstanceURL,
		})
	}
}

// FederationChannelsHandler allows a peer to fetch channel list for a server.
// Authenticated via X-Federation-Token header.
func FederationChannelsHandler(cfg *config.Config, database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Federation-Token")
		if token != cfg.Federation.Token {
			http.Error(w, `{"error":"invalid federation token"}`, http.StatusForbidden)
			return
		}

		serverID := chi.URLParam(r, "serverID")
		channels, err := database.GetChannelsByServer(serverID)
		if err != nil {
			http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if channels == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(channels)
	}
}

// FederationMembersHandler allows a peer to fetch the member list for a server.
// Authenticated via X-Federation-Token header. Returns both local and federated members.
func FederationMembersHandler(cfg *config.Config, database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Federation-Token")
		if token != cfg.Federation.Token {
			http.Error(w, `{"error":"invalid federation token"}`, http.StatusForbidden)
			return
		}

		serverID := chi.URLParam(r, "serverID")
		members, err := database.GetServerMembers(serverID)
		if err != nil {
			http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
			return
		}

		// Build a response with user details
		type memberInfo struct {
			ID          string `json:"id"`
			Username    string `json:"username"`
			DisplayName string `json:"display_name"`
			AvatarURL   string `json:"avatar_url"`
			NameColor   string `json:"name_color"`
			Role        string `json:"role"`
			Status      string `json:"status"`
		}

		var result []memberInfo
		for _, m := range members {
			u, uErr := database.GetUserByID(m.UserID)
			if uErr != nil {
				continue
			}
			result = append(result, memberInfo{
				ID:          m.UserID,
				Username:    u.Username,
				DisplayName: u.DisplayName,
				AvatarURL:   u.AvatarURL,
				NameColor:   u.NameColor,
				Role:        m.Role,
				Status:      u.Status,
			})
		}

		// Include federated members too
		fedMembers, _ := database.GetFederatedMembers(serverID)
		for _, fm := range fedMembers {
			result = append(result, memberInfo{
				ID:          fm.RemoteID,
				Username:    fm.Username,
				DisplayName: fm.DisplayName,
				AvatarURL:   fm.AvatarURL,
				NameColor:   fm.NameColor,
				Role:        "member",
				Status:      "online",
			})
		}

		w.Header().Set("Content-Type", "application/json")
		if result == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(result)
	}
}

// FederatedJoinHandler allows a local user to join a server on a remote federated instance.
// The invite code format is: CODE@https://remote-instance.com
func FederatedJoinHandler(cfg *config.Config, database *db.DB, hub *ws.Hub, fedHub *federation.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			InviteCode string `json:"invite_code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
			return
		}

		// Parse CODE@URL format
		parts := strings.SplitN(req.InviteCode, "@", 2)
		if len(parts) != 2 {
			http.Error(w, `{"error":"invalid federated invite code format, expected CODE@URL"}`, http.StatusBadRequest)
			return
		}
		code := parts[0]
		peerURL := parts[1]

		// Find the peer config to get its token
		var peerToken string
		for _, p := range cfg.Federation.Peers {
			if p.URL == peerURL {
				peerToken = p.Token
				break
			}
		}
		if peerToken == "" {
			http.Error(w, `{"error":"unknown federation peer"}`, http.StatusBadRequest)
			return
		}

		// Resolve the invite on the remote server
		body, _ := json.Marshal(map[string]string{"code": code})
		httpReq, _ := http.NewRequest("POST", peerURL+"/api/federation/resolve-invite", bytes.NewReader(body))
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("X-Federation-Token", peerToken)

		resp, err := http.DefaultClient.Do(httpReq)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"failed to contact peer: %s"}`, err.Error()), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			http.Error(w, `{"error":"remote server rejected invite"}`, resp.StatusCode)
			return
		}

		var resolveResp struct {
			ServerID    string `json:"server_id"`
			ServerName  string `json:"server_name"`
			ServerIcon  string `json:"server_icon"`
			InstanceURL string `json:"instance_url"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&resolveResp); err != nil {
			http.Error(w, `{"error":"invalid response from peer"}`, http.StatusBadGateway)
			return
		}

		// Get local user info
		userID := GetUserID(r)
		user, err := database.GetUserByID(userID)
		if err != nil {
			http.Error(w, `{"error":"user not found"}`, http.StatusInternalServerError)
			return
		}

		// Send fed_join over the S2S WebSocket to notify the remote server
		federation.RequestFederatedJoin(fedHub, peerURL, resolveResp.ServerID,
			federation.MakeFedAuthor(userID, user.Username, user.DisplayName, user.AvatarURL, user.NameColor))

		// Fetch the remote server's channels so we can mirror them locally
		chReq, _ := http.NewRequest("GET", peerURL+"/api/federation/servers/"+resolveResp.ServerID+"/channels", nil)
		chReq.Header.Set("X-Federation-Token", peerToken)

		chResp, err := http.DefaultClient.Do(chReq)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":"failed to fetch channels from peer: %s"}`, err.Error()), http.StatusBadGateway)
			return
		}
		defer chResp.Body.Close()

		var remoteChannels []struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Type        string `json:"type"`
			Position    int    `json:"position"`
			Description string `json:"description"`
		}
		if chResp.StatusCode == http.StatusOK {
			json.NewDecoder(chResp.Body).Decode(&remoteChannels)
		}

		// Create a local mirror of the remote server
		database.CreateFederatedServerMirror(resolveResp.ServerID, resolveResp.ServerName, resolveResp.ServerIcon, resolveResp.InstanceURL, userID)

		// Mirror each remote channel locally
		for _, ch := range remoteChannels {
			database.CreateFederatedChannelMirror(ch.ID, resolveResp.ServerID, ch.Name, ch.Type, ch.Position)
		}

		// Return the server as a regular Server object so the client can add it
		server, err := database.GetServer(resolveResp.ServerID)
		if err != nil {
			http.Error(w, `{"error":"failed to create local server mirror"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(server)
	}
}
