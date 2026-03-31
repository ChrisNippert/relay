package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ── Types ───────────────────────────────────────────────────────────────────

type User struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Status      string `json:"status"`
}

type AuthResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

type Server struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Channel struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	ServerID string `json:"server_id"`
}

type Message struct {
	ID        string   `json:"id"`
	Content   string   `json:"content"`
	UserID    string   `json:"user_id"`
	CreatedAt string   `json:"created_at"`
	Deleted   bool     `json:"deleted"`
	Author    *User    `json:"author"`
	ReplyTo   *Message `json:"reply_to"`
}

type Friendship struct {
	ID       string `json:"id"`
	UserID   string `json:"user_id"`
	FriendID string `json:"friend_id"`
	Status   string `json:"status"`
	Friend   *User  `json:"friend"`
}

type DMChannel struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Participants []User `json:"participants"`
}

type WSMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type Member struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
	User   *User  `json:"user"`
}

type Invite struct {
	ID      string `json:"id"`
	Code    string `json:"code"`
	Uses    int    `json:"uses"`
	MaxUses int    `json:"max_uses"`
}

// ── State ───────────────────────────────────────────────────────────────────

var (
	baseURL string
	token   string
	me      User
	ws      *websocket.Conn
	wsMu    sync.Mutex
	reader  *bufio.Reader

	// navigation state
	currentServer  *Server
	currentChannel *Channel
)

// ── HTTP helpers ────────────────────────────────────────────────────────────

func api(method, path string, body interface{}) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, baseURL+path, r)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return http.DefaultClient.Do(req)
}

func apiJSON(method, path string, body interface{}, out interface{}) error {
	resp, err := api(method, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// ── WebSocket ───────────────────────────────────────────────────────────────

func connectWS() {
	u := strings.Replace(baseURL, "http", "ws", 1) + "/api/ws"
	dialer := *websocket.DefaultDialer
	dialer.Subprotocols = []string{"auth", token}
	var err error
	ws, _, err = dialer.Dial(u, nil)
	if err != nil {
		fmt.Println("WS connect error:", err)
		return
	}
	fmt.Println("[WS connected]")
	go func() {
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				fmt.Println("\n[WS disconnected]")
				return
			}
			var msg WSMessage
			if json.Unmarshal(raw, &msg) != nil {
				continue
			}
			handleWS(msg)
		}
	}()
}

func handleWS(msg WSMessage) {
	switch msg.Type {
	case "chat_message":
		var m Message
		json.Unmarshal(msg.Payload, &m)
		if m.Deleted {
			return
		}
		name := m.UserID[:8]
		if m.Author != nil {
			name = m.Author.DisplayName
			if name == "" {
				name = m.Author.Username
			}
		}
		// only show if in the current channel
		if currentChannel != nil && m.ID != "" {
			chID := ""
			var p struct {
				ChannelID string `json:"channel_id"`
			}
			json.Unmarshal(msg.Payload, &p)
			chID = p.ChannelID
			if chID == currentChannel.ID {
				ts := fmtTime(m.CreatedAt)
				fmt.Printf("\r[%s] %s: %s\n> ", ts, name, m.Content)
			}
		}
	case "presence":
		// silent
	case "typing_start", "typing_stop":
		// silent
	}
}

func wsSend(typ string, payload interface{}) {
	if ws == nil {
		return
	}
	b, _ := json.Marshal(payload)
	msg := WSMessage{Type: typ, Payload: b}
	wsMu.Lock()
	defer wsMu.Unlock()
	ws.WriteJSON(msg)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

func fmtTime(s string) string {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return s
	}
	return t.Local().Format("15:04")
}

func prompt(label string) string {
	fmt.Print(label)
	line, _ := reader.ReadString('\n')
	return strings.TrimSpace(line)
}

func pick(label string, items []string) int {
	for i, s := range items {
		fmt.Printf("  %d) %s\n", i+1, s)
	}
	for {
		s := prompt(label)
		var n int
		if _, err := fmt.Sscanf(s, "%d", &n); err == nil && n >= 1 && n <= len(items) {
			return n - 1
		}
		fmt.Println("Invalid choice")
	}
}

// ── Commands ────────────────────────────────────────────────────────────────

func cmdServers() {
	var servers []Server
	if err := apiJSON("GET", "/api/servers", nil, &servers); err != nil {
		fmt.Println("Error:", err)
		return
	}
	if len(servers) == 0 {
		fmt.Println("No servers.")
		return
	}
	names := make([]string, len(servers))
	for i, s := range servers {
		names[i] = s.Name
	}
	idx := pick("Select server: ", names)
	currentServer = &servers[idx]
	currentChannel = nil
	fmt.Printf("Entered server: %s\n", currentServer.Name)
}

func cmdChannels() {
	if currentServer == nil {
		fmt.Println("Select a server first (/servers)")
		return
	}
	var channels []Channel
	if err := apiJSON("GET", "/api/servers/"+currentServer.ID+"/channels", nil, &channels); err != nil {
		fmt.Println("Error:", err)
		return
	}
	if len(channels) == 0 {
		fmt.Println("No channels.")
		return
	}
	names := make([]string, len(channels))
	for i, c := range channels {
		tag := "T"
		if c.Type == "voice" {
			tag = "V"
		}
		names[i] = fmt.Sprintf("[%s] #%s", tag, c.Name)
	}
	idx := pick("Select channel: ", names)
	currentChannel = &channels[idx]
	fmt.Printf("Joined #%s\n", currentChannel.Name)
	cmdHistory()
}

func cmdHistory() {
	if currentChannel == nil {
		fmt.Println("Select a channel first")
		return
	}
	var msgs []Message
	if err := apiJSON("GET", "/api/channels/"+currentChannel.ID+"/messages?limit=25", nil, &msgs); err != nil {
		fmt.Println("Error:", err)
		return
	}
	// reverse to show oldest first
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	for _, m := range msgs {
		if m.Deleted {
			continue
		}
		name := m.UserID[:8]
		if m.Author != nil {
			n := m.Author.DisplayName
			if n == "" {
				n = m.Author.Username
			}
			name = n
		}
		ts := fmtTime(m.CreatedAt)
		fmt.Printf("[%s] %s: %s\n", ts, name, m.Content)
	}
}

func cmdSend(text string) {
	if currentChannel == nil {
		fmt.Println("Select a channel first")
		return
	}
	wsSend("chat_message", map[string]string{
		"channel_id": currentChannel.ID,
		"content":    text,
		"type":       "text",
	})
}

func cmdFriends() {
	var friends []Friendship
	if err := apiJSON("GET", "/api/friends", nil, &friends); err != nil {
		fmt.Println("Error:", err)
		return
	}
	if len(friends) == 0 {
		fmt.Println("No friends.")
		return
	}
	for _, f := range friends {
		other := f.FriendID
		if f.FriendID == me.ID {
			other = f.UserID
		}
		var u User
		apiJSON("GET", "/api/users/"+other, nil, &u)
		name := u.DisplayName
		if name == "" {
			name = u.Username
		}
		fmt.Printf("  %s [%s] (%s)\n", name, f.Status, u.Status)
	}
}

func cmdDMs() {
	var dms []DMChannel
	if err := apiJSON("GET", "/api/dm", nil, &dms); err != nil {
		fmt.Println("Error:", err)
		return
	}
	if len(dms) == 0 {
		fmt.Println("No DMs.")
		return
	}
	names := make([]string, len(dms))
	for i, d := range dms {
		label := d.Name
		if label == "" {
			label = d.ID[:8]
		}
		names[i] = label
	}
	idx := pick("Select DM: ", names)
	currentServer = nil
	currentChannel = &Channel{ID: dms[idx].ID, Name: dms[idx].Name, Type: "text"}
	fmt.Printf("Opened DM: %s\n", currentChannel.Name)
	cmdHistory()
}

func cmdMembers() {
	if currentServer == nil {
		fmt.Println("Select a server first")
		return
	}
	var members []Member
	if err := apiJSON("GET", "/api/servers/"+currentServer.ID+"/members", nil, &members); err != nil {
		fmt.Println("Error:", err)
		return
	}
	for _, m := range members {
		name := m.UserID[:8]
		if m.User != nil {
			n := m.User.DisplayName
			if n == "" {
				n = m.User.Username
			}
			name = n
		}
		fmt.Printf("  %s [%s]\n", name, m.Role)
	}
}

func cmdInvites() {
	if currentServer == nil {
		fmt.Println("Select a server first")
		return
	}
	var invites []Invite
	if err := apiJSON("GET", "/api/servers/"+currentServer.ID+"/invites", nil, &invites); err != nil {
		fmt.Println("Error:", err)
		return
	}
	if len(invites) == 0 {
		fmt.Println("No invites.")
		return
	}
	for _, inv := range invites {
		fmt.Printf("  %s (uses: %d/%d)\n", inv.Code, inv.Uses, inv.MaxUses)
	}
}

func cmdCreateInvite() {
	if currentServer == nil {
		fmt.Println("Select a server first")
		return
	}
	var inv Invite
	if err := apiJSON("POST", "/api/servers/"+currentServer.ID+"/invites", map[string]interface{}{}, &inv); err != nil {
		fmt.Println("Error:", err)
		return
	}
	fmt.Printf("Invite code: %s\n", inv.Code)
}

func cmdJoinInvite() {
	code := prompt("Invite code: ")
	if code == "" {
		return
	}
	if err := apiJSON("POST", "/api/invites/"+code+"/join", nil, nil); err != nil {
		fmt.Println("Error:", err)
		return
	}
	fmt.Println("Joined!")
}

func cmdSearch() {
	q := prompt("Search users: ")
	if q == "" {
		return
	}
	var users []User
	if err := apiJSON("GET", "/api/users/search?q="+url.QueryEscape(q), nil, &users); err != nil {
		fmt.Println("Error:", err)
		return
	}
	for _, u := range users {
		name := u.DisplayName
		if name == "" {
			name = u.Username
		}
		fmt.Printf("  %s (@%s) [%s] id:%s\n", name, u.Username, u.Status, u.ID)
	}
}

func cmdAddFriend() {
	id := prompt("User ID: ")
	if id == "" {
		return
	}
	if err := apiJSON("POST", "/api/friends/request", map[string]string{"user_id": id}, nil); err != nil {
		fmt.Println("Error:", err)
		return
	}
	fmt.Println("Friend request sent!")
}

func cmdCreateServer() {
	name := prompt("Server name: ")
	if name == "" {
		return
	}
	var s Server
	if err := apiJSON("POST", "/api/servers", map[string]string{"name": name}, &s); err != nil {
		fmt.Println("Error:", err)
		return
	}
	fmt.Printf("Created server: %s\n", s.Name)
}

func cmdWhere() {
	if currentServer != nil {
		fmt.Printf("Server: %s", currentServer.Name)
	} else {
		fmt.Print("Server: (none)")
	}
	if currentChannel != nil {
		fmt.Printf(" | Channel: #%s\n", currentChannel.Name)
	} else {
		fmt.Println(" | Channel: (none)")
	}
}

func printHelp() {
	fmt.Println(`Commands:
  /servers         - List & select server
  /channels        - List & select channel
  /history         - Show recent messages
  /friends         - List friends
  /dms             - List & select DMs
  /members         - List server members
  /invites         - List server invites
  /create-invite   - Create invite for current server
  /join            - Join server by invite code
  /search          - Search users
  /add-friend      - Send friend request by user ID
  /create-server   - Create a new server
  /where           - Show current location
  /quit            - Exit
  (anything else)  - Send as message to current channel`)
}

// ── Main ────────────────────────────────────────────────────────────────────

func main() {
	reader = bufio.NewReader(os.Stdin)

	// Server URL
	baseURL = os.Getenv("RELAY_URL")
	if baseURL == "" {
		baseURL = prompt("Server URL (e.g. http://localhost:3002): ")
	}
	baseURL = strings.TrimRight(baseURL, "/")

	// Auth
	email := os.Getenv("RELAY_EMAIL")
	pass := os.Getenv("RELAY_PASS")
	if email == "" {
		email = prompt("Email: ")
	}
	if pass == "" {
		pass = prompt("Password: ")
	}

	var auth AuthResponse
	err := apiJSON("POST", "/api/auth/login", map[string]string{
		"email": email, "password": pass,
	}, &auth)
	if err != nil {
		fmt.Println("Login failed:", err)
		os.Exit(1)
	}
	token = auth.Token
	me = auth.User
	fmt.Printf("Logged in as %s (@%s)\n", me.DisplayName, me.Username)

	// Connect WebSocket
	connectWS()
	defer func() {
		if ws != nil {
			ws.Close()
		}
	}()

	printHelp()
	fmt.Println()

	// REPL
	for {
		line := prompt("> ")
		if line == "" {
			continue
		}
		switch {
		case line == "/quit" || line == "/q":
			return
		case line == "/servers":
			cmdServers()
		case line == "/channels" || line == "/ch":
			cmdChannels()
		case line == "/history" || line == "/h":
			cmdHistory()
		case line == "/friends" || line == "/f":
			cmdFriends()
		case line == "/dms":
			cmdDMs()
		case line == "/members" || line == "/m":
			cmdMembers()
		case line == "/invites":
			cmdInvites()
		case line == "/create-invite":
			cmdCreateInvite()
		case line == "/join":
			cmdJoinInvite()
		case line == "/search":
			cmdSearch()
		case line == "/add-friend":
			cmdAddFriend()
		case line == "/create-server":
			cmdCreateServer()
		case line == "/where" || line == "/w":
			cmdWhere()
		case line == "/help" || line == "/?":
			printHelp()
		case strings.HasPrefix(line, "/"):
			fmt.Println("Unknown command. /help for list.")
		default:
			cmdSend(line)
		}
	}
}
