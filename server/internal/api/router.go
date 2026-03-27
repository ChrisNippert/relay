package api

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/relay-chat/relay/internal/config"
	"github.com/relay-chat/relay/internal/db"
	"github.com/relay-chat/relay/internal/ws"
)

func NewRouter(cfg *config.Config, database *db.DB, hub *ws.Hub) http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RealIP)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Public routes
	r.Post("/api/auth/register", RegisterHandler(database, cfg))
	r.Post("/api/auth/login", LoginHandler(database, cfg))

	// WebSocket (authenticated via query param token)
	r.Get("/ws", ws.HandleWebSocket(hub, cfg))
	r.Get("/api/ws", ws.HandleWebSocket(hub, cfg))

	// File downloads (public — UUIDs are unguessable)
	r.Get("/api/files/{fileID}", DownloadHandler(cfg))

	// Authenticated routes
	r.Group(func(r chi.Router) {
		r.Use(AuthMiddleware(cfg))

		// Users
		r.Get("/api/users/me", GetMeHandler(database))
		r.Put("/api/users/me", UpdateMeHandler(database))
		r.Get("/api/users/search", SearchUsersHandler(database))
		r.Get("/api/users/{userID}", GetUserHandler(database))
		r.Put("/api/users/me/public-key", UpdatePublicKeyHandler(database))

		// Friends
		r.Get("/api/friends", GetFriendsHandler(database))
		r.Post("/api/friends/request", SendFriendRequestHandler(database))
		r.Post("/api/friends/accept/{friendshipID}", AcceptFriendRequestHandler(database))
		r.Delete("/api/friends/{friendshipID}", RemoveFriendHandler(database))

		// Servers
		r.Post("/api/servers", CreateServerHandler(database))
		r.Get("/api/servers", GetServersHandler(database))
		r.Get("/api/servers/{serverID}", GetServerHandler(database))
		r.Put("/api/servers/{serverID}", UpdateServerHandler(database))
		r.Delete("/api/servers/{serverID}", DeleteServerHandler(database))
		r.Post("/api/servers/{serverID}/join", JoinServerHandler(database))
		r.Post("/api/servers/{serverID}/leave", LeaveServerHandler(database))
		r.Get("/api/servers/{serverID}/members", GetMembersHandler(database))
		r.Get("/api/servers/{serverID}/online", GetOnlineUsersHandler(database, hub))
		r.Put("/api/servers/{serverID}/members/{userID}/role", UpdateMemberRoleHandler(database, hub))
		r.Delete("/api/servers/{serverID}/members/{userID}", KickMemberHandler(database, hub))

		// Server invites
		r.Post("/api/servers/{serverID}/invites", CreateInviteHandler(database))
		r.Get("/api/servers/{serverID}/invites", GetInvitesHandler(database))
		r.Post("/api/invites/{code}/join", JoinByInviteHandler(database))
		r.Delete("/api/invites/{inviteID}", DeleteInviteHandler(database))

		// Channels
		r.Post("/api/servers/{serverID}/channels", CreateChannelHandler(database, hub))
		r.Get("/api/servers/{serverID}/channels", GetChannelsHandler(database))
		r.Put("/api/channels/{channelID}", UpdateChannelHandler(database, hub))
		r.Delete("/api/channels/{channelID}", DeleteChannelHandler(database, hub))
		r.Put("/api/servers/{serverID}/channels/positions", UpdateChannelPositionsHandler(database, hub))

		// DMs
		r.Post("/api/dm", CreateDMHandler(database))
		r.Get("/api/dm", GetDMsHandler(database))
		r.Get("/api/dm/{channelID}/participants", GetDMParticipantsHandler(database))

		// Messages
		r.Get("/api/channels/{channelID}/messages", GetMessagesHandler(database))
		r.Get("/api/channels/{channelID}/messages/search", SearchMessagesHandler(database))
		r.Put("/api/messages/{messageID}", EditMessageHandler(database))
		r.Delete("/api/messages/{messageID}", DeleteMessageHandler(database))
		r.Get("/api/messages/{messageID}/history", GetEditHistoryHandler(database))

		// Voice state
		r.Get("/api/channels/{channelID}/voice-users", GetVoiceUsersHandler(hub))

		// Channel keys (E2E encryption)
		r.Get("/api/channels/{channelID}/keys", GetChannelKeysHandler(database))
		r.Post("/api/channels/{channelID}/keys", SetChannelKeyHandler(database))
		r.Delete("/api/users/me/channel-keys", DeleteMyChannelKeysHandler(database))

		// File upload
		r.Post("/api/upload", UploadHandler(cfg, database))

		// OpenGraph metadata
		r.Get("/api/og", OGHandler())
	})

	// Serve static frontend files with SPA fallback
	if cfg.StaticDir != "" {
		fileServer := http.FileServer(http.Dir(cfg.StaticDir))
		r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
			fsPath := filepath.Join(cfg.StaticDir, filepath.Clean("/"+req.URL.Path))
			if _, err := os.Stat(fsPath); os.IsNotExist(err) {
				http.ServeFile(w, req, filepath.Join(cfg.StaticDir, "index.html"))
				return
			}
			fileServer.ServeHTTP(w, req)
		})
	}

	return r
}
