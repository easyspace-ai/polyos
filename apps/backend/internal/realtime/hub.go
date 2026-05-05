package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/drinkthere/polyserver/internal/models"
	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"
)

const (
	writeWait      = 5 * time.Second
	pongWait       = 45 * time.Second
	pingPeriod     = 15 * time.Second
	clientSendSize = 64
)

// BoardSubscriptionSink receives the global frontend board token set.
type BoardSubscriptionSink interface {
	SetBoardTokens(tokens []string)
}

// Hub manages frontend WebSocket clients independently from upstream Polymarket connections.
type Hub struct {
	upgrader  websocket.Upgrader
	priceFeed BoardSubscriptionSink

	nextID atomic.Uint64

	mu      sync.RWMutex
	board   map[uint64]*client
	monitor map[uint64]*client
}

type client struct {
	id       uint64
	conn     *websocket.Conn
	send     chan []byte
	tokenIDs map[string]struct{}
}

// NewHub creates a WebSocket hub.
func NewHub(priceFeed BoardSubscriptionSink) *Hub {
	return &Hub{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		priceFeed: priceFeed,
		board:     map[uint64]*client{},
		monitor:   map[uint64]*client{},
	}
}

// ServeBoard handles /ws/board.
func (h *Hub) ServeBoard(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "websocket",
			"channel":   "board",
			"client_ip": r.RemoteAddr,
		}).Warn("board websocket upgrade failed")
		return
	}
	id := h.nextID.Add(1)
	c := &client{id: id, conn: conn, send: make(chan []byte, clientSendSize), tokenIDs: map[string]struct{}{}}
	h.mu.Lock()
	h.board[id] = c
	h.mu.Unlock()
	logrus.WithFields(logrus.Fields{
		"component":  "websocket",
		"channel":    "board",
		"conn_id":    id,
		"client_ip":  r.RemoteAddr,
		"connection": "opened",
	}).Info("board websocket connected")
	h.publishBoardUnion()

	go h.writeLoop(c)
	h.readBoardLoop(r.Context(), c)
	h.removeBoard(id)
}

// ServeMonitor handles /ws/monitor and sends an initial snapshot.
func (h *Hub) ServeMonitor(w http.ResponseWriter, r *http.Request, snapshot models.MonitorSnapshot) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "websocket",
			"channel":   "monitor",
			"client_ip": r.RemoteAddr,
		}).Warn("monitor websocket upgrade failed")
		return
	}
	id := h.nextID.Add(1)
	c := &client{id: id, conn: conn, send: make(chan []byte, clientSendSize)}
	h.mu.Lock()
	h.monitor[id] = c
	h.mu.Unlock()
	logrus.WithFields(logrus.Fields{
		"component":      "websocket",
		"channel":        "monitor",
		"conn_id":        id,
		"client_ip":      r.RemoteAddr,
		"position_count": len(snapshot.Positions),
		"connection":     "opened",
	}).Info("monitor websocket connected")
	if b, err := json.Marshal(snapshot); err == nil {
		c.enqueue(b)
	} else {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "websocket",
			"channel":   "monitor",
			"conn_id":   id,
		}).Warn("monitor initial snapshot encode failed")
	}
	go h.writeLoop(c)
	h.readDiscardLoop(c)
	h.removeMonitor(id)
}

// BroadcastBoardTicks sends ticks to board clients.
func (h *Hub) BroadcastBoardTicks(quotes map[string]any) {
	logrus.WithFields(logrus.Fields{
		"component":   "websocket",
		"channel":     "board",
		"quote_count": len(quotes),
	}).Debug("board ticks broadcast requested")
	payload := map[string]any{
		"type":      "ticks",
		"quotes":    quotes,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	}
	h.broadcastBoard(payload)
}

// BroadcastMonitor sends monitor snapshot to monitor clients.
func (h *Hub) BroadcastMonitor(snapshot models.MonitorSnapshot) {
	logrus.WithFields(logrus.Fields{
		"component":      "websocket",
		"channel":        "monitor",
		"position_count": len(snapshot.Positions),
	}).Debug("monitor snapshot broadcast requested")
	h.broadcastMonitor(snapshot)
}

func (h *Hub) broadcastBoard(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "websocket",
			"channel":   "board",
		}).Warn("board broadcast encode failed")
		return
	}
	h.mu.RLock()
	clients := make([]*client, 0, len(h.board))
	for _, c := range h.board {
		clients = append(clients, c)
	}
	h.mu.RUnlock()
	logrus.WithFields(logrus.Fields{
		"component":    "websocket",
		"channel":      "board",
		"client_count": len(clients),
	}).Debug("board broadcast fanout")
	for _, c := range clients {
		c.enqueue(b)
	}
}

func (h *Hub) broadcastMonitor(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "websocket",
			"channel":   "monitor",
		}).Warn("monitor broadcast encode failed")
		return
	}
	h.mu.RLock()
	clients := make([]*client, 0, len(h.monitor))
	for _, c := range h.monitor {
		clients = append(clients, c)
	}
	h.mu.RUnlock()
	logrus.WithFields(logrus.Fields{
		"component":    "websocket",
		"channel":      "monitor",
		"client_count": len(clients),
	}).Debug("monitor broadcast fanout")
	for _, c := range clients {
		c.enqueue(b)
	}
}

func (h *Hub) readBoardLoop(ctx context.Context, c *client) {
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	first := time.NewTimer(5 * time.Second)
	defer first.Stop()
	msgCh := make(chan []byte, 1)
	errCh := make(chan struct{}, 1)
	go func() {
		for {
			_, b, err := c.conn.ReadMessage()
			if err != nil {
				errCh <- struct{}{}
				return
			}
			msgCh <- b
		}
	}()
	for {
		select {
		case <-ctx.Done():
			logrus.WithFields(logrus.Fields{
				"component": "websocket",
				"channel":   "board",
				"conn_id":   c.id,
				"reason":    "request_context_done",
			}).Info("board websocket read loop stopped")
			return
		case <-errCh:
			logrus.WithFields(logrus.Fields{
				"component": "websocket",
				"channel":   "board",
				"conn_id":   c.id,
				"reason":    "read_error_or_close",
			}).Info("board websocket read loop stopped")
			return
		case <-first.C:
			logrus.WithFields(logrus.Fields{
				"component": "websocket",
				"channel":   "board",
				"conn_id":   c.id,
			}).Debug("board websocket first subscribe timeout")
			first.Reset(24 * time.Hour)
		case b := <-msgCh:
			if tokens, ok := parseBoardSubscribe(b); ok {
				h.setClientTokens(c.id, tokens)
			}
		}
	}
}

func (h *Hub) readDiscardLoop(c *client) {
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			logrus.WithFields(logrus.Fields{
				"component": "websocket",
				"channel":   "monitor",
				"conn_id":   c.id,
				"reason":    "read_error_or_close",
			}).Info("monitor websocket read loop stopped")
			return
		}
	}
}

func (h *Hub) writeLoop(c *client) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer func() {
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, nil)
				logrus.WithFields(logrus.Fields{
					"component": "websocket",
					"conn_id":   c.id,
					"reason":    "send_channel_closed",
				}).Debug("websocket write loop stopped")
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				logrus.WithError(err).WithFields(logrus.Fields{
					"component": "websocket",
					"conn_id":   c.id,
				}).Info("websocket write failed")
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				logrus.WithError(err).WithFields(logrus.Fields{
					"component": "websocket",
					"conn_id":   c.id,
				}).Info("websocket ping failed")
				return
			}
		}
	}
}

func (c *client) enqueue(b []byte) {
	cp := append([]byte(nil), b...)
	select {
	case c.send <- cp:
	default:
		logrus.WithFields(logrus.Fields{
			"component": "websocket",
			"conn_id":   c.id,
			"reason":    "send_queue_full",
		}).Warn("websocket client send queue full; closing")
		_ = c.conn.Close()
	}
}

func (h *Hub) setClientTokens(id uint64, tokens []string) {
	h.mu.Lock()
	if c, ok := h.board[id]; ok {
		next := map[string]struct{}{}
		for _, token := range tokens {
			if token != "" {
				next[token] = struct{}{}
			}
		}
		c.tokenIDs = next
		logrus.WithFields(logrus.Fields{
			"component":   "websocket",
			"channel":     "board",
			"conn_id":     id,
			"token_count": len(next),
		}).Info("board websocket subscription updated")
	}
	h.mu.Unlock()
	h.publishBoardUnion()
}

func (h *Hub) removeBoard(id uint64) {
	h.mu.Lock()
	if c, ok := h.board[id]; ok {
		delete(h.board, id)
		close(c.send)
		logrus.WithFields(logrus.Fields{
			"component":   "websocket",
			"channel":     "board",
			"conn_id":     id,
			"token_count": len(c.tokenIDs),
			"connection":  "closed",
		}).Info("board websocket disconnected")
	}
	h.mu.Unlock()
	h.publishBoardUnion()
}

func (h *Hub) removeMonitor(id uint64) {
	h.mu.Lock()
	if c, ok := h.monitor[id]; ok {
		delete(h.monitor, id)
		close(c.send)
		logrus.WithFields(logrus.Fields{
			"component":  "websocket",
			"channel":    "monitor",
			"conn_id":    id,
			"connection": "closed",
		}).Info("monitor websocket disconnected")
	}
	h.mu.Unlock()
}

func (h *Hub) publishBoardUnion() {
	if h.priceFeed == nil {
		return
	}
	h.mu.RLock()
	set := map[string]struct{}{}
	for _, c := range h.board {
		for token := range c.tokenIDs {
			set[token] = struct{}{}
		}
	}
	h.mu.RUnlock()
	tokens := make([]string, 0, len(set))
	for token := range set {
		tokens = append(tokens, token)
	}
	logrus.WithFields(logrus.Fields{
		"component":   "websocket",
		"channel":     "board",
		"token_count": len(tokens),
	}).Debug("board token union published")
	h.priceFeed.SetBoardTokens(tokens)
}

func parseBoardSubscribe(b []byte) ([]string, bool) {
	var req struct {
		Type     string   `json:"type"`
		TokenIDs []string `json:"tokenIds"`
	}
	if err := json.Unmarshal(b, &req); err != nil {
		return nil, false
	}
	if len(req.TokenIDs) == 0 {
		return nil, false
	}
	return req.TokenIDs, true
}
