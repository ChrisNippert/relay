package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/ws"
)

type createServerRequest struct {
	Name string `json:"name"`
}

func CreateServerHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createServerRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		if req.Name == "" {
			http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
			return
		}

		server, err := database.CreateServer(uuid.New().String(), req.Name, GetUserID(r))
		if err != nil {
			http.Error(w, `{"error":"failed to create server"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(server)
	}
}

func GetServersHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		servers, err := database.GetServersByUser(GetUserID(r))
		if err != nil {
			http.Error(w, `{"error":"failed to get servers"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if servers == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(servers)
	}
}

func GetServerHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")

		isMember, err := database.IsServerMember(serverID, GetUserID(r))
		if err != nil || !isMember {
			http.Error(w, `{"error":"not a member of this server"}`, http.StatusForbidden)
			return
		}

		server, err := database.GetServer(serverID)
		if err != nil {
			http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(server)
	}
}

func UpdateServerHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")

		role, err := database.GetMemberRole(serverID, GetUserID(r))
		if err != nil || role != "admin" {
			http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
			return
		}

		var req struct {
			Name    string `json:"name"`
			IconURL string `json:"icon_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		server, err := database.UpdateServer(serverID, req.Name, req.IconURL)
		if err != nil {
			http.Error(w, `{"error":"failed to update server"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(server)
	}
}

func DeleteServerHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")

		server, err := database.GetServer(serverID)
		if err != nil {
			http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
			return
		}

		if server.OwnerID != GetUserID(r) {
			http.Error(w, `{"error":"only the owner can delete a server"}`, http.StatusForbidden)
			return
		}

		if err := database.DeleteServer(serverID); err != nil {
			http.Error(w, `{"error":"failed to delete server"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func JoinServerHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")

		if _, err := database.GetServer(serverID); err != nil {
			http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
			return
		}

		if err := database.AddServerMember(serverID, GetUserID(r), "member"); err != nil {
			http.Error(w, `{"error":"failed to join server"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func LeaveServerHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")
		userID := GetUserID(r)

		server, err := database.GetServer(serverID)
		if err != nil {
			http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
			return
		}

		if server.OwnerID == userID {
			http.Error(w, `{"error":"owner cannot leave; transfer ownership or delete the server"}`, http.StatusBadRequest)
			return
		}

		if err := database.RemoveServerMember(serverID, userID); err != nil {
			http.Error(w, `{"error":"failed to leave server"}`, http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func GetMembersHandler(database *db.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")

		isMember, err := database.IsServerMember(serverID, GetUserID(r))
		if err != nil || !isMember {
			http.Error(w, `{"error":"not a member of this server"}`, http.StatusForbidden)
			return
		}

		members, err := database.GetServerMembers(serverID)
		if err != nil {
			http.Error(w, `{"error":"failed to get members"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if members == nil {
			w.Write([]byte("[]"))
			return
		}
		json.NewEncoder(w).Encode(members)
	}
}

type updateMemberRoleRequest struct {
	Role string `json:"role"`
}

func UpdateMemberRoleHandler(database *db.DB, hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID := chi.URLParam(r, "serverID")
		targetUserID := chi.URLParam(r, "userID")

		// Only admins can change roles
		role, err := database.GetMemberRole(serverID, GetUserID(r))
		if err != nil || role != "admin" {
			http.Error(w, `{"error":"admin access required"}`, http.StatusForbidden)
			return
		}

		// Cannot change your own role
		if targetUserID == GetUserID(r) {
			http.Error(w, `{"error":"cannot change your own role"}`, http.StatusBadRequest)
			return
		}

		// Cannot change the server owner's role
		server, err := database.GetServer(serverID)
		if err != nil {
			http.Error(w, `{"error":"server not found"}`, http.StatusNotFound)
			return
		}
		if targetUserID == server.OwnerID {
			http.Error(w, `{"error":"cannot change server owner's role"}`, http.StatusBadRequest)
			return
		}

		var req updateMemberRoleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		if req.Role != "admin" && req.Role != "member" {
			http.Error(w, `{"error":"role must be 'admin' or 'member'"}`, http.StatusBadRequest)
			return
		}

		if err := database.UpdateMemberRole(serverID, targetUserID, req.Role); err != nil {
			http.Error(w, `{"error":"failed to update role"}`, http.StatusInternalServerError)
			return
		}

		// Broadcast member role update
		broadcastChannelEvent(hub, serverID, "member_role_updated", map[string]string{
			"server_id": serverID,
			"user_id":   targetUserID,
			"role":      req.Role,
		})

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"role": req.Role})
	}
}
