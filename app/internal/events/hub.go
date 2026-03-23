package events

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
		return true
	},
}

type Event struct {
	Type string      `json:"type"`
	Data interface{} `json:"data,omitempty"`
	At   time.Time   `json:"at"`
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*client]bool
}

type client struct {
	conn *websocket.Conn
	send chan []byte
}

func NewHub() *Hub {
	return &Hub{clients: make(map[*client]bool)}
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("event websocket upgrade failed: %v", err)
		return
	}

	c := &client{
		conn: conn,
		send: make(chan []byte, 32),
	}

	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()

	go c.writeLoop(func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
	})
}

func (h *Hub) Broadcast(event Event) {
	event.At = time.Now()
	data, err := json.Marshal(event)
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.send <- data:
		default:
		}
	}
}

func (c *client) writeLoop(onClose func()) {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
		onClose()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
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
