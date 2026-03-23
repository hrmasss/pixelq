package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow extension connections
	},
}

type Message struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Prompt  string          `json:"prompt,omitempty"`
	Images  []string        `json:"images,omitempty"`
	Error   string          `json:"error,omitempty"`
	Message string          `json:"message,omitempty"`
	Ready   bool            `json:"ready,omitempty"`
	TabURL  string          `json:"tab_url,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (m Message) Decode(target interface{}) error {
	if len(m.Data) == 0 {
		return nil
	}
	return json.Unmarshal(m.Data, target)
}

type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	send   chan []byte
	ready  bool
	tabURL string
	mu     sync.RWMutex
}

type ClientSnapshot struct {
	Ready  bool   `json:"ready"`
	TabURL string `json:"tab_url,omitempty"`
}

type Hub struct {
	clients    map[*Client]bool
	register   chan *Client
	unregister chan *Client
	broadcast  chan []byte

	mu           sync.RWMutex
	onMessage    func(*Client, Message)
	onConnect    func(*Client)
	onDisconnect func(*Client)
}

func NewHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan []byte, 256),
	}
}

func (h *Hub) OnMessage(cb func(*Client, Message)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onMessage = cb
}

func (h *Hub) OnConnect(cb func(*Client)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onConnect = cb
}

func (h *Hub) OnDisconnect(cb func(*Client)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onDisconnect = cb
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			cb := h.onConnect
			h.mu.Unlock()

			if cb != nil {
				cb(client)
			}
			log.Printf("Extension connected, total clients: %d", len(h.clients))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			cb := h.onDisconnect
			h.mu.Unlock()

			if cb != nil {
				cb(client)
			}
			log.Printf("Extension disconnected, total clients: %d", len(h.clients))

		case message := <-h.broadcast:
			h.mu.RLock()
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) HasConnections() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients) > 0
}

func (h *Hub) HasReadyClient() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients {
		client.mu.RLock()
		ready := client.ready
		client.mu.RUnlock()
		if ready {
			return true
		}
	}
	return false
}

func (h *Hub) GetReadyClient() *Client {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients {
		client.mu.RLock()
		ready := client.ready
		client.mu.RUnlock()
		if ready {
			return client
		}
	}
	return nil
}

func (h *Hub) SendToReady(msg Message) bool {
	client := h.GetReadyClient()
	if client == nil {
		return false
	}
	return client.Send(msg)
}

func (h *Hub) Broadcast(msg Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal broadcast message: %v", err)
		return
	}
	h.broadcast <- data
}

func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

func (h *Hub) Snapshot() []ClientSnapshot {
	h.mu.RLock()
	defer h.mu.RUnlock()

	snapshots := make([]ClientSnapshot, 0, len(h.clients))
	for client := range h.clients {
		client.mu.RLock()
		snapshots = append(snapshots, ClientSnapshot{
			Ready:  client.ready,
			TabURL: client.tabURL,
		})
		client.mu.RUnlock()
	}
	return snapshots
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}

	client := &Client{
		hub:  h,
		conn: conn,
		send: make(chan []byte, 256),
	}

	h.register <- client

	go client.writePump()
	go client.readPump()
}

func (c *Client) Send(msg Message) bool {
	data, err := json.Marshal(msg)
	if err != nil {
		return false
	}

	select {
	case c.send <- data:
		return true
	default:
		return false
	}
}

func (c *Client) SetReady(ready bool, tabURL string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ready = ready
	c.tabURL = tabURL
}

func (c *Client) IsReady() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.ready
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(65536)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket read error: %v", err)
			}
			break
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to parse message: %v", err)
			continue
		}

		// Handle status messages to update ready state
		if msg.Type == "status" {
			c.SetReady(msg.Ready, msg.TabURL)
		}

		c.hub.mu.RLock()
		cb := c.hub.onMessage
		c.hub.mu.RUnlock()

		if cb != nil {
			cb(c, msg)
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
