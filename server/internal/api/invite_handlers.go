package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/ws"
)

type createInviteRequest struct {
	MaxUses   int `json:"max_uses"`
	ExpiresIn int `json:"expires_in"` // seconds; 0 = never
}

func generateInviteCode() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func CreateInviteHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")
		userID := GetUserID(r)

		isMember, err := database.IsServerMember(serverID, userID)
		if err != nil || !isMember {
			http.Error(w, `{"error":"not a member of this server"}`, http.StatusForbidden)
			return
		}

		var req createInviteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			// Allow empty body — defaults are fine
			req = createInviteRequest{}
		}

		var expiresAt *time.Time
		if req.ExpiresIn > 0 {
			t := time.Now().Add(time.Duration(req.ExpiresIn) * time.Second)
			expiresAt = &t
		}

		invite, err := database.CreateInvite(uuid.New().String(), serverID, userID, generateInviteCode(), req.MaxUses, expiresAt)
		if err != nil {
			http.Error(w, `{"error":"failed to create invite"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(invite)
	}
}

func GetInvitesHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")
		userID := GetUserID(r)

		isMember, err := database.IsServerMember(serverID, userID)
		if err != nil || !isMember {
			http.Error(w, `{"error":"not a member of this server"}`, http.StatusForbidden)
			return
		}

		invites, err := database.GetServerInvites(serverID)
		if err != nil {
			http.Error(w, `{"error":"failed to get invites"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if invites == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(invites)
	}
}

func JoinByInviteHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := chi.URLParam(r, "code")
		userID := GetUserID(r)

		invite, err := database.GetInviteByCode(code)
		if err != nil {
			http.Error(w, `{"error":"invalid invite code"}`, http.StatusNotFound)
			return
		}

		// Check expiry
		if invite.ExpiresAt != nil && time.Now().After(*invite.ExpiresAt) {
			http.Error(w, `{"error":"invite has expired"}`, http.StatusGone)
			return
		}

		// Check max uses
		if invite.MaxUses > 0 && invite.Uses >= invite.MaxUses {
			http.Error(w, `{"error":"invite has reached max uses"}`, http.StatusGone)
			return
		}

		// Check already a member
		isMember, _ := database.IsServerMember(invite.ServerID, userID)
		if isMember {
			// Already a member — just return the server info
			server, err := database.GetServer(invite.ServerID)
			if err != nil {
				http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(server)
			return
		}

		// Join the server
		if err := database.AddServerMember(invite.ServerID, userID, "member"); err != nil {
			http.Error(w, `{"error":"failed to join server"}`, http.StatusInternalServerError)
			return
		}

		// Increment use count
		database.UseInvite(code)

		server, err := database.GetServer(invite.ServerID)
		if err != nil {
			http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
			return
		}

		// Broadcast member_joined to all server members
		broadcastChannelEvent(hub, invite.ServerID, "member_joined", map[string]string{
			"server_id": invite.ServerID,
			"user_id":   userID,
		})

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(server)
	}
}

func DeleteInviteHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		inviteID := chi.URLParam(r, "inviteID")
		userID := GetUserID(r)

		invite, err := database.GetInvite(inviteID)
		if err != nil {
			http.Error(w, `{"error":"invite not found"}`, http.StatusNotFound)
			return
		}

		// Only the creator or server admin can delete
		role, _ := database.GetMemberRole(invite.ServerID, userID)
		if invite.CreatorID != userID && role != "admin" {
			http.Error(w, `{"error":"not authorized to delete this invite"}`, http.StatusForbidden)
			return
		}

		if err := database.DeleteInvite(inviteID); err != nil {
			http.Error(w, `{"error":"failed to delete invite"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
