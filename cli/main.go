package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// ── Types ─────────────────────────────────────────────────────────────────────

type User struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

type Server struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Channel struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	ServerID *string `json:"server_id"`
	Type     string  `json:"type"`
}

type Author struct {
	DisplayName string `json:"display_name"`
	Username    string `json:"username"`
}

type Message struct {
	ID        string   `json:"id"`
	ChannelID string   `json:"channel_id"`
	UserID    string   `json:"user_id"`
	Content   string   `json:"content"`
	Edited    bool     `json:"edited"`
	ReplyToID *string  `json:"reply_to_id"`
	ReplyTo   *Message `json:"reply_to"`
	CreatedAt string   `json:"created_at"`
	Author    *Author  `json:"author"`
}

type WSEnvelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// ── Client ────────────────────────────────────────────────────────────────────

type client struct {
	base    string
	token   string
	me      User
	http    *http.Client
	ws      *websocket.Conn
	inbox   chan WSEnvelope
	scanner *bufio.Scanner
}

func newClient(base string) *client {
	return &client{
		base:    strings.TrimRight(base, "/"),
		http:    &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}},
		inbox:   make(chan WSEnvelope, 64),
		scanner: bufio.NewScanner(os.Stdin),
	}
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

func (c *client) do(method, path string, body any) ([]byte, int, error) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+"/api"+path, r)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return data, resp.StatusCode, nil
}

func apiJSON[T any](c *client, method, path string, body any) (T, error) {
	var zero T
	data, code, err := c.do(method, path, body)
	if err != nil {
		return zero, err
	}
	if code >= 400 {
		return zero, fmt.Errorf("HTTP %d: %s", code, strings.TrimSpace(string(data)))
	}
	var out T
	if err := json.Unmarshal(data, &out); err != nil {
		return zero, fmt.Errorf("decode: %w", err)
	}
	return out, nil
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

func (c *client) wsURL() string {
	u, _ := url.Parse(c.base)
	scheme := "wss"
	if u.Scheme == "http" {
		scheme = "ws"
	}
	return fmt.Sprintf("%s://%s/api/ws?token=%s", scheme, u.Host, url.QueryEscape(c.token))
}

func (c *client) connectWS() error {
	dialer := websocket.Dialer{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	conn, _, err := dialer.Dial(c.wsURL(), nil)
	if err != nil {
		return err
	}
	c.ws = conn
	go c.readPump(conn)
	return nil
}

// readPump reads from a WS connection and forwards to inbox.
// On disconnect it drains the inbox sentinel and reconnects automatically.
func (c *client) readPump(conn *websocket.Conn) {
	dialer := websocket.Dialer{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			// Signal disconnect to the chat loop
			c.inbox <- WSEnvelope{Type: "__disconnect__"}
			// Reconnect loop
			for {
				time.Sleep(2 * time.Second)
				newConn, _, err2 := dialer.Dial(c.wsURL(), nil)
				if err2 == nil {
					c.ws = newConn
					conn = newConn
					c.inbox <- WSEnvelope{Type: "__reconnected__"}
					break
				}
			}
			continue
		}
		var env WSEnvelope
		if json.Unmarshal(data, &env) == nil {
			c.inbox <- env
		}
	}
}

func (c *client) sendWS(typ string, payload any) {
	if c.ws == nil {
		return
	}
	data, _ := json.Marshal(map[string]any{"type": typ, "payload": payload})
	c.ws.WriteMessage(websocket.TextMessage, data)
}

// ── Prompt helpers ────────────────────────────────────────────────────────────

func (c *client) prompt(label string) string {
	fmt.Printf("%s: ", label)
	c.scanner.Scan()
	return strings.TrimSpace(c.scanner.Text())
}

func (c *client) choose(label string, options []string) int {
	for i, o := range options {
		fmt.Printf("  [%d] %s\n", i+1, o)
	}
	for {
		s := c.prompt(label)
		n, err := strconv.Atoi(s)
		if err == nil && n >= 1 && n <= len(options) {
			return n - 1
		}
		fmt.Println("  Invalid choice, try again.")
	}
}

// ── Auth ──────────────────────────────────────────────────────────────────────

func (c *client) login() error {
	fmt.Println()
	email := c.prompt("Email")
	fmt.Printf("Password: ")
	c.scanner.Scan()
	password := strings.TrimSpace(c.scanner.Text())
	r, err := apiJSON[map[string]json.RawMessage](c, "POST", "/auth/login", map[string]string{
		"email":    email,
		"password": password,
	})
	if err != nil {
		return fmt.Errorf("login failed: %w", err)
	}
	var resp struct {
		Token string `json:"token"`
		User  User   `json:"user"`
	}
	if err := json.Unmarshal(r["token"], &resp.Token); err != nil || resp.Token == "" {
		return fmt.Errorf("login failed: bad response")
	}
	json.Unmarshal(r["user"], &resp.User)
	c.token = resp.Token
	c.me = resp.User
	return nil
}

// ── Channel selection ─────────────────────────────────────────────────────────

func (c *client) pickChannel() (Channel, error) {
	fmt.Println("\n── Where to? ──────────────────────────────")
	fmt.Println("  [1] Server channel")
	fmt.Println("  [2] Direct message")
	choice := c.prompt("Choose")
	if choice == "2" {
		dms, err := apiJSON[[]Channel](c, "GET", "/dm", nil)
		if err != nil || len(dms) == 0 {
			return Channel{}, fmt.Errorf("no DMs found")
		}
		names := make([]string, len(dms))
		for i, d := range dms {
			names[i] = d.Name
		}
		idx := c.choose("DM", names)
		return dms[idx], nil
	}
	servers, err := apiJSON[[]Server](c, "GET", "/servers", nil)
	if err != nil || len(servers) == 0 {
		return Channel{}, fmt.Errorf("no servers found")
	}
	serverNames := make([]string, len(servers))
	for i, s := range servers {
		serverNames[i] = s.Name
	}
	fmt.Println()
	sIdx := c.choose("Server", serverNames)
	srv := servers[sIdx]
	channels, err := apiJSON[[]Channel](c, "GET", "/servers/"+srv.ID+"/channels", nil)
	if err != nil || len(channels) == 0 {
		return Channel{}, fmt.Errorf("no channels found")
	}
	var textChannels []Channel
	for _, ch := range channels {
		if ch.Type == "text" {
			textChannels = append(textChannels, ch)
		}
	}
	if len(textChannels) == 0 {
		return Channel{}, fmt.Errorf("no text channels")
	}
	chanNames := make([]string, len(textChannels))
	for i, ch := range textChannels {
		chanNames[i] = "#" + ch.Name
	}
	fmt.Println()
	cIdx := c.choose("Channel", chanNames)
	return textChannels[cIdx], nil
}

// ── Message display ───────────────────────────────────────────────────────────

func authorName(m Message) string {
	if m.Author != nil {
		if m.Author.DisplayName != "" {
			return m.Author.DisplayName
		}
		return m.Author.Username
	}
	if len(m.UserID) >= 8 {
		return m.UserID[:8]
	}
	return m.UserID
}

func formatTime(iso string) string {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		t, _ = time.Parse("2006-01-02T15:04:05Z", iso)
	}
	return t.Local().Format("15:04")
}

func printMessage(m Message, idx int) {
	edited := ""
	if m.Edited {
		edited = " (edited)"
	}
	if m.ReplyTo != nil {
		preview := m.ReplyTo.Content
		if len(preview) > 40 {
			preview = preview[:40] + "…"
		}
		fmt.Printf("  ↩ %s: %s\n", authorName(*m.ReplyTo), preview)
	}
	fmt.Printf("[%d] %s  %s%s\n    %s\n", idx, authorName(m), formatTime(m.CreatedAt), edited, m.Content)
}

// ── Chat loop ─────────────────────────────────────────────────────────────────

func (c *client) chat(ch Channel) {
	msgs, err := apiJSON[[]Message](c, "GET", "/channels/"+ch.ID+"/messages?limit=20", nil)
	if err != nil {
		fmt.Println("Could not load messages:", err)
		msgs = nil
	}
	// API returns DESC; reverse to chronological
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	chanLabel := "#" + ch.Name
	if ch.ServerID == nil {
		chanLabel = "DM:" + ch.Name
	}
	fmt.Printf("\n══ %s ══════════════════════════════════════\n", chanLabel)
	fmt.Println("Commands: /reply <N> <text>  /edit <N> <text>  /history <N>  /switch  /quit")
	fmt.Println("          @username to mention someone")
	fmt.Println(strings.Repeat("─", 50))
	for i, m := range msgs {
		printMessage(m, i+1)
	}
	fmt.Println(strings.Repeat("─", 50))

	// Drain stale WS messages
	for len(c.inbox) > 0 {
		<-c.inbox
	}

	inputCh := make(chan string)
	go func() {
		for {
			fmt.Printf("> ")
			if !c.scanner.Scan() {
				inputCh <- "/quit"
				return
			}
			inputCh <- strings.TrimSpace(c.scanner.Text())
		}
	}()

	for {
		select {
		case env := <-c.inbox:
			switch env.Type {
			case "__disconnect__":
				fmt.Printf("\r⚠ Disconnected, reconnecting...\n> ")
				continue
			case "__reconnected__":
				fmt.Printf("\r✓ Reconnected\n> ")
				continue
			case "chat_message":
				var m Message
				if json.Unmarshal(env.Payload, &m) == nil && m.ChannelID == ch.ID {
					msgs = append(msgs, m)
					fmt.Printf("\r")
					printMessage(m, len(msgs))
					fmt.Printf("> ")
				}
			case "message_edited":
				var m Message
				if json.Unmarshal(env.Payload, &m) == nil && m.ChannelID == ch.ID {
					for i := range msgs {
						if msgs[i].ID == m.ID {
							msgs[i] = m
							break
						}
					}
					fmt.Printf("\r✎ Message %d edited\n> ", indexOfMsg(msgs, m.ID))
				}
			case "typing_start":
				var p struct {
					ChannelID string `json:"channel_id"`
					UserID    string `json:"user_id"`
				}
				if json.Unmarshal(env.Payload, &p) == nil && p.ChannelID == ch.ID && p.UserID != c.me.ID {
					fmt.Printf("\r(someone is typing...)\n> ")
				}
			}
		case line := <-inputCh:
			if line == "" {
				continue
			}
			switch {
			case line == "/quit":
				fmt.Println("Bye!")
				os.Exit(0)
			case line == "/switch":
				return
			case strings.HasPrefix(line, "/reply "):
				parts := strings.SplitN(line[7:], " ", 2)
				if len(parts) < 2 {
					fmt.Println("Usage: /reply <N> <text>")
					continue
				}
				n, err := strconv.Atoi(strings.TrimSpace(parts[0]))
				if err != nil || n < 1 || n > len(msgs) {
					fmt.Println("Invalid message number")
					continue
				}
				target := msgs[n-1]
				c.sendWS("chat_message", map[string]any{
					"channel_id":  ch.ID,
					"content":     parts[1],
					"type":        "text",
					"reply_to_id": target.ID,
				})
			case strings.HasPrefix(line, "/edit "):
				parts := strings.SplitN(line[6:], " ", 2)
				if len(parts) < 2 {
					fmt.Println("Usage: /edit <N> <new text>")
					continue
				}
				n, err := strconv.Atoi(strings.TrimSpace(parts[0]))
				if err != nil || n < 1 || n > len(msgs) {
					fmt.Println("Invalid message number")
					continue
				}
				target := msgs[n-1]
				if target.UserID != c.me.ID {
					fmt.Println("You can only edit your own messages")
					continue
				}
				c.sendWS("edit_message", map[string]any{
					"message_id": target.ID,
					"content":    parts[1],
				})
			case strings.HasPrefix(line, "/history "):
				nStr := strings.TrimSpace(line[9:])
				n, err := strconv.Atoi(nStr)
				if err != nil || n < 1 || n > len(msgs) {
					fmt.Println("Invalid message number")
					continue
				}
				target := msgs[n-1]
				type editEntry struct {
					Content  string `json:"content"`
					EditedAt string `json:"edited_at"`
				}
				history, err := apiJSON[[]editEntry](c, "GET", "/messages/"+target.ID+"/history", nil)
				if err != nil {
					fmt.Println("Could not fetch history:", err)
					continue
				}
				if len(history) == 0 {
					fmt.Println("No edit history for that message.")
					continue
				}
				fmt.Printf("── Edit history for message %d ──\n", n)
				for i, e := range history {
					fmt.Printf("  [v%d @ %s] %s\n", i+1, formatTime(e.EditedAt), e.Content)
				}
				fmt.Println("  [current] " + target.Content)
			default:
				c.sendWS("chat_message", map[string]any{
					"channel_id": ch.ID,
					"content":    line,
					"type":       "text",
				})
			}
		}
	}
}

func indexOfMsg(msgs []Message, id string) int {
	for i, m := range msgs {
		if m.ID == id {
			return i + 1
		}
	}
	return 0
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	server := flag.String("server", "https://localhost:8080", "Relay server URL")
	flag.Parse()
	c := newClient(*server)
	fmt.Printf("╔══════════════════════════════╗\n")
	fmt.Printf("║     Relay Chat CLI           ║\n")
	fmt.Printf("╚══════════════════════════════╝\n")
	fmt.Printf("Server: %s\n", *server)
	if err := c.login(); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
	fmt.Printf("✓ Logged in as %s\n", c.me.DisplayName)
	if err := c.connectWS(); err != nil {
		fmt.Fprintln(os.Stderr, "WebSocket error:", err)
		os.Exit(1)
	}
	fmt.Println("✓ Connected to server")
	for {
		ch, err := c.pickChannel()
		if err != nil {
			fmt.Println("Error:", err)
			fmt.Println("Try again? (y/n)")
			c.scanner.Scan()
			if strings.TrimSpace(c.scanner.Text()) != "y" {
				os.Exit(0)
			}
			continue
		}
		c.chat(ch)
		fmt.Println("\n(Returning to channel picker...)")
	}
}
